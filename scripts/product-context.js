'use strict';
// node scripts/product-context.js --run <run dir> [--files a,b,c]
// Writes <run>/product.json and <run>/product-context.md; each state's record is written at most once per run.
// Idempotence rests on product.json. Known limit (REQ-2): two overlapping calls on a fresh run can both write the absent record.
// A present but unparsable product.json is a defect: no record is written and the call reports ok false.
const fs = require('node:fs');
const path = require('node:path');
const { loadProduct, appendDecision, readProductJson, readDecisionsTail, defaultIo } = require('./lib/product-context');
const { listRecords, nextRecordId } = require('./lib/records');
const { PRODUCT_AGENTS, DOC_FILE_RE } = require('./lib/cap-record');
const { writeRecords } = require('./lib/record-writer');
const { loadConfig, readJson } = require('./lib/state');

const ABSENT_CLAIM = 'no product context: .spine/product.md absent';
const RECORD_ID_RE = /^R-\d{4,}$/;
const CLAIM_ANSWER_MAX = 120;
const STAGES = new Set(['intent', 'spec', 'plan', 'implement', 'review']);

const productJsonPath = (runDir) => path.join(runDir, 'product.json');
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');

function parseArgs(argv) {
  const args = { run: null, files: [], decide: false, record: null, answer: null };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--decide') {
      args.decide = true;
      i -= 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === '--run') args.run = value;
    else if (argv[i] === '--files') args.files = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--record') args.record = value;
    else if (argv[i] === '--answer') args.answer = value;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!args.run) throw new Error('--run <run dir> is required');
  if (args.decide && (!args.record || args.answer === null)) throw new Error('--decide needs --record <R-id> and --answer <text>');
  return args;
}

const emptyState = () => ({
  state: 'absent', sha256: null, lines: 0, loaded_lines: 0, flows_touched: [], left_out: [], flow_issues: [],
  absent_record: null, defect_record: null, trim_record: null, flow_record: null, resume_record: null, decisions: [],
  sections: null, repo_docs: [], repo_docs_truncated: false,
});

const infoRecord = (stage, severity, claim, evidence) => ({
  stage, agent: 'spine:orchestrator', claim, evidence, confidence: 1, severity, dissent: null, resolution: null, alternatives: [],
});

// Decides which records this call owes, given what product.json already says was written.
function plannedRecords(prev, loaded, flowIssues, rel) {
  const ref = (line) => (line ? `${rel}:${line}` : rel);
  const out = [];
  if (loaded.state === 'absent' && !prev.absent_record) {
    out.push(['absent_record', 'INFO', ABSENT_CLAIM, [{ kind: 'doc', ref: rel, note: 'absent' }]]);
  }
  if (loaded.state === 'malformed' && !prev.defect_record) {
    const { line, message } = loaded.issue || { line: 0, message: 'unreadable' };
    out.push(['defect_record', 'MEDIUM', `product.md malformed: ${message}`, [{ kind: 'doc', ref: ref(line), note: message }]]);
  }
  if (loaded.state === 'trimmed' && !prev.trim_record) {
    out.push(['trim_record', 'INFO', `product context trimmed: left out ${loaded.leftOut.join(', ')}`, [{ kind: 'doc', ref: rel, note: 'over product_context_max_lines' }]]);
  }
  if (flowIssues.length && !prev.flow_record) {
    const names = (list) => [...new Set(list.map((i) => i.flow))].join(', ');
    const pairs = (list) => list.map((i) => i.flow + ': ' + i.glob).join(', ');
    const dropped = flowIssues.filter((i) => i.glob === null);
    const unmatched = flowIssues.filter((i) => i.glob !== null);
    const parts = [];
    if (unmatched.length) parts.push(`key flow paths matched nothing: ${pairs(unmatched)}`);
    if (dropped.length) parts.push(`key flow entries dropped: ${names(dropped)}`);
    out.push(['flow_record', 'INFO', parts.join('; '), flowIssues.map((i) => ({ kind: 'doc', ref: ref(i.line), note: `${i.flow}: ${i.message}` }))]);
  }
  return out;
}

const REPO_DOCS_MAX = 5000;

// Tracked documentation files (REQ-11): the workflows check doc citations against this list instead of the file system.
function repoDocsOf(root) {
  try {
    const all = defaultIo.listFiles(root).map((f) => f.replaceAll('\\', '/')).filter((f) => DOC_FILE_RE.test(f)).sort();
    // truncated tells the workflows the list cannot prove a doc is missing (R-0227).
    return { docs: all.slice(0, REPO_DOCS_MAX), truncated: all.length > REPO_DOCS_MAX };
  } catch {
    return { docs: [], truncated: false };
  }
}

function mergeDiagnostics(runDir, product) {
  const file = path.join(runDir, 'diagnostics.json');
  const current = readJson(file);
  if (!current) return;
  writeJson(file, { ...current, product });
}

// The repo root the run was started from: the run dir sits at <root>/<artifacts_dir>/<run id>, whatever the cwd or a review worktree.
function repoRootOf(runDir, artifactsDir) {
  const depth = String(artifactsDir).split(/[\/]/).filter(Boolean).length;
  return path.resolve(runDir, ...Array(depth + 1).fill('..'));
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

const decisionRecord = (stage, sourceId, answer, rel) => {
  const flat = String(answer).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return {
    ...infoRecord(stage, 'INFO', 'decision for ' + sourceId + ': ' + [...flat].slice(0, CLAIM_ANSWER_MAX).join(''), [{ kind: 'doc', ref: rel, note: 'decisions log' }]),
    resolution: { kind: 'decision', text: String(answer) },
    resolves: sourceId,
  };
};

const existingDecisionRecord = (runDir, sourceId) => {
  const hit = listRecords(runDir).map((r) => r.record).find((r) => r.resolves === sourceId && r.agent === 'spine:orchestrator' && r.resolution && r.resolution.kind === 'decision');
  return hit ? hit.id : null;
};

// Records the human answer: one decision record holding the whole answer, one log line, product.json bookkeeping.
// The append is the commitment; a product.json that cannot be written is repaired by the next call.
function decide(args, runDir, state, config, io) {
  const record = readJson(path.join(runDir, 'records', args.record + '.json'));
  if (!record) return { ok: false, error: 'record ' + args.record + ' not found' };
  if (!PRODUCT_AGENTS.includes(record.agent)) return { ok: false, error: 'record agent is not a product role' };
  const prevPath = productJsonPath(runDir);
  const pj = readProductJson(runDir);
  if (pj.status === 'unreadable') return { ok: false, error: 'product.json unreadable' };
  const prev = { ...emptyState(), ...(pj.data || {}) };
  const stage = STAGES.has(state.stage) ? state.stage : 'spec';
  const repoRoot = repoRootOf(runDir, config.artifacts_dir);
  const rel = config.artifacts_dir + '/decisions.md';
  const file = path.join(repoRoot, config.artifacts_dir, 'decisions.md');
  const runId = state.id || path.basename(runDir);
  // The log line is appended first; the decision record is written only after it succeeds. Its id is known in advance for the cut marker.
  const existingId = existingDecisionRecord(runDir, args.record);
  const plannedId = existingId || nextRecordId(runDir);
  const question = record.resolution && record.resolution.text ? record.resolution.text : record.claim;
  const out = appendDecision(file, { runId, recordId: args.record, date: todayUtc(), question, answer: args.answer, fullTextRecordId: plannedId }, io);
  if (!out.ok) {
    writeRecords(runDir, [infoRecord(stage, 'MEDIUM', 'decision not written: ' + args.record + ' (' + out.error + ')', [{ kind: 'doc', ref: rel, note: out.error }])], {});
    return { ok: false, written: false, error: out.error, record: args.record };
  }
  const decisionId = existingId || writeRecords(runDir, [decisionRecord(stage, args.record, args.answer, rel)], {})[0];
  const line = out.written ? out.line : (readDecisionsTail(file, Infinity).find((l) => l.includes(' · ' + runId + ' · ' + args.record + ' · ')) || null);
  const result = { ok: true, written: out.written, line, record: args.record, decision_record: decisionId, file: rel };
  if (line && !prev.decisions.some((d) => d.record === args.record)) {
    try {
      writeJson(prevPath, { ...prev, decisions: [...prev.decisions, { record: args.record, line, decision_record: decisionId }] });
    } catch {
      return { ...result, warning: 'product.json not updated; the next call repairs it' };
    }
  }
  return result;
}

function main(argv, root = process.cwd(), decisionsIo) {
  const args = parseArgs(argv);
  if (args.decide && !RECORD_ID_RE.test(args.record)) return { ok: false, error: 'invalid record id' };
  const runDir = path.resolve(root, args.run);
  const state = readJson(path.join(runDir, 'state.json'));
  if (!state) throw new Error('run dir has no readable state.json');
  const config = loadConfig(root);
  if (args.decide) return decide(args, runDir, state, config, decisionsIo);
  const rel = `${config.artifacts_dir}/product.md`;
  const stage = STAGES.has(state.stage) ? state.stage : 'spec';
  const prevPath = productJsonPath(runDir);
  const pj = readProductJson(runDir);
  if (pj.status === 'unreadable') return { ok: false, error: 'product.json unreadable' };
  const prevFile = pj.data;
  const prev = { ...emptyState(), ...(prevFile || {}) };
  const loaded = loadProduct(root, config, args.files, undefined, { decisionsRoot: repoRootOf(runDir, config.artifacts_dir) });
  const changed = Boolean(prevFile) && prev.sha256 !== loaded.sha256;
  const flowIssues = changed ? [] : loaded.flowIssues;

  const plan = plannedRecords(changed ? { ...prev, absent_record: 'x', defect_record: 'x', trim_record: 'x', flow_record: 'x' } : prev, loaded, flowIssues, rel);
  if (changed && !prev.resume_record) plan.push(['resume_record', 'INFO', 'product.md changed since run start', [{ kind: 'doc', ref: rel, note: 'sha256 differs from product.json' }]]);
  const ids = plan.length ? writeRecords(runDir, plan.map(([, sev, claim, ev]) => infoRecord(stage, sev, claim, ev)), {}) : [];
  const written = Object.fromEntries(plan.map(([key], i) => [key, ids[i]]));

  const usable = loaded.state === 'ok' || loaded.state === 'trimmed';
  const docs = usable && !changed ? repoDocsOf(root) : { docs: [], truncated: false };
  const fresh = changed ? prev : {
    ...prev, state: loaded.state, sha256: loaded.sha256, lines: loaded.lines, loaded_lines: loaded.loadedLines,
    flows_touched: loaded.flowsTouched, left_out: loaded.leftOut, flow_issues: flowIssues.map(({ flow, glob, message, line }) => ({ flow, glob, message, line })),
    sections: usable ? loaded.sections : null, repo_docs: docs.docs, repo_docs_truncated: docs.truncated,
  };
  const next = { ...fresh, ...written };
  writeJson(productJsonPath(runDir), next);
  if (!changed && loaded.text) fs.writeFileSync(path.join(runDir, 'product-context.md'), loaded.text);
  if (next.state === 'ok' || next.state === 'trimmed') mergeDiagnostics(runDir, { state: next.state, loaded_lines: next.loaded_lines, flows_touched: next.flows_touched.length, flow_issues: next.flow_issues.length });
  const record = ids.length ? ids[ids.length - 1] : null;
  return { ok: true, state: next.state, record, loaded_lines: next.loaded_lines, flows_touched: next.flows_touched.length, repo_docs_truncated: next.repo_docs_truncated === true };
}

module.exports = { main, productJsonPath, plannedRecords };

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n');
  } catch (err) {
    process.stderr.write(`spine: product-context: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
