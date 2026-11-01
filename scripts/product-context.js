'use strict';
// node scripts/product-context.js --run <run dir> [--files a,b,c]
// Writes <run>/product.json and <run>/product-context.md; each state's record is written at most once per run.
const fs = require('node:fs');
const path = require('node:path');
const { loadProduct } = require('./lib/product-context');
const { writeRecords } = require('./lib/record-writer');
const { loadConfig, readJson } = require('./lib/state');

const ABSENT_CLAIM = 'no product context: .spine/product.md absent';
const STAGES = new Set(['intent', 'spec', 'plan', 'implement', 'review']);

const productJsonPath = (runDir) => path.join(runDir, 'product.json');
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');

function parseArgs(argv) {
  const args = { run: null, files: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === '--run') args.run = value;
    else if (argv[i] === '--files') args.files = value.split(',').map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!args.run) throw new Error('--run <run dir> is required');
  return args;
}

const emptyState = () => ({
  state: 'absent', sha256: null, lines: 0, loaded_lines: 0, flows_touched: [], left_out: [], flow_issues: [],
  absent_record: null, defect_record: null, trim_record: null, flow_record: null, resume_record: null, decisions: [],
});

const infoRecord = (stage, severity, claim, evidence) => ({
  stage, agent: 'spine:orchestrator', claim, evidence, confidence: 1, severity, dissent: null, resolution: null, alternatives: [],
});

function unmatchedFlows(loaded, files) {
  if (!files.length) return [];
  const hit = new Set(loaded.flowsTouched.map((t) => t.name));
  return loaded.flows.filter((f) => !hit.has(f.name)).map((f) => ({ flow: f.name, glob: f.paths.join(', '), message: 'no matching files', line: f.line }));
}

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
    const names = [...new Set(flowIssues.map((i) => i.flow))].join(', ');
    out.push(['flow_record', 'INFO', `key flow paths matched nothing: ${names}`, flowIssues.map((i) => ({ kind: 'doc', ref: ref(i.line), note: `${i.flow}: ${i.message}` }))]);
  }
  return out;
}

function mergeDiagnostics(runDir, product) {
  const file = path.join(runDir, 'diagnostics.json');
  const current = readJson(file);
  if (!current) return;
  writeJson(file, { ...current, product });
}

function main(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const runDir = path.resolve(root, args.run);
  const state = readJson(path.join(runDir, 'state.json'));
  if (!state) throw new Error('run dir has no readable state.json');
  const config = loadConfig(root);
  const rel = `${config.artifacts_dir}/product.md`;
  const stage = STAGES.has(state.stage) ? state.stage : 'spec';
  const prevFile = readJson(productJsonPath(runDir));
  const prev = { ...emptyState(), ...(prevFile || {}) };
  const loaded = loadProduct(root, config, args.files);
  const changed = Boolean(prevFile) && prev.sha256 !== loaded.sha256;
  const flowIssues = changed ? [] : [...loaded.flowIssues, ...unmatchedFlows(loaded, args.files)];

  const plan = plannedRecords(changed ? { ...prev, absent_record: 'x', defect_record: 'x', trim_record: 'x', flow_record: 'x' } : prev, loaded, flowIssues, rel);
  if (changed && !prev.resume_record) plan.push(['resume_record', 'INFO', 'product.md changed since run start', [{ kind: 'doc', ref: rel, note: 'sha256 differs from product.json' }]]);
  const ids = plan.length ? writeRecords(runDir, plan.map(([, sev, claim, ev]) => infoRecord(stage, sev, claim, ev)), {}) : [];
  const written = Object.fromEntries(plan.map(([key], i) => [key, ids[i]]));

  const fresh = changed ? prev : {
    ...prev, state: loaded.state, sha256: loaded.sha256, lines: loaded.lines, loaded_lines: loaded.loadedLines,
    flows_touched: loaded.flowsTouched, left_out: loaded.leftOut, flow_issues: flowIssues.map(({ flow, glob, message }) => ({ flow, glob, message })),
  };
  const next = { ...fresh, ...written };
  writeJson(productJsonPath(runDir), next);
  if (!changed && loaded.text) fs.writeFileSync(path.join(runDir, 'product-context.md'), loaded.text);
  mergeDiagnostics(runDir, { state: next.state, loaded_lines: next.loaded_lines, flows_touched: next.flows_touched.length, flow_issues: next.flow_issues.length });
  const record = ids.length ? ids[ids.length - 1] : null;
  return { ok: true, state: next.state, record, loaded_lines: next.loaded_lines, flows_touched: next.flows_touched.length };
}

module.exports = { main, productJsonPath };

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n');
  } catch (err) {
    process.stderr.write(`spine: product-context: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
