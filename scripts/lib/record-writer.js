'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateRecord } = require('./validate');
const { nextRecordId } = require('./records');
const { RUN_ID_RE, readJson } = require('./state');
const { listRecords } = require('./records');
const { groupFindings } = require('./cross-author');
const mp = require('./model-policy');

const FLAG_KEYS = Object.freeze({
  '--provider': 'provider', '--author': 'author', '--verifies': 'verifies', '--verifier-note': 'verifier_note', '--host': 'host',
});

const MODEL_KEYS = Object.freeze(['model', 'verifier_model', 'model_note']);

function modelBlockFor(plan, stage, role, source) {
  const entry = plan && plan.stages && plan.stages[stage] && plan.stages[stage].roles && plan.stages[stage].roles[role];
  if (!entry) return { role, tier: null, tier_source: null, class: null, requested: null, source: source || 'fallback-error' };
  const block = { role, tier: entry.tier, tier_source: entry.tier_source, class: entry.class, requested: entry.model, source: source || entry.source };
  return !source && entry.source === 'floor-raised' && entry.reason ? { ...block, reason: entry.reason } : block;
}

// Text written by an agent never carries model fields (REQ-30). JSON given with --file or on
// stdin comes from the orchestrator or a workflow: a well-formed block is kept as returned.
function keepModelFields(out, record, trusted) {
  for (const key of MODEL_KEYS) delete out[key];
  if (!trusted) return;
  for (const key of ['model', 'verifier_model']) {
    if (record[key] && typeof record[key] === 'object' && !mp.validateModelBlock(record[key]).length) out[key] = record[key];
  }
  if (record.model_note === mp.WEAK_VERIFIER_NOTE) out.model_note = record.model_note;
}

function weakVerifierNote(block, verifies, ctx) {
  const records = ctx.records || [];
  const group = groupFindings(records).find((g) => g.records.some((r) => r.id === verifies));
  const raisers = group ? group.records.map((r) => r.model).filter(Boolean) : [];
  const killSwitch = Boolean(ctx.plan && ctx.plan.policy && ctx.plan.policy.kind === 'inherit');
  return mp.isWeakVerifier(block, raisers, { tier: block.tier, killSwitch });
}

function stamp(record, flags, ctx = {}) {
  const out = { ...record };
  keepModelFields(out, record, !flags['--from-text']);
  for (const [flag, key] of Object.entries(FLAG_KEYS)) if (flags[flag]) out[key] = flags[flag];
  if (flags['--verified']) out.verified = flags['--verified'] === 'true';
  const role = flags['--model-role'];
  if (!role) return out;
  out.model = modelBlockFor(ctx.plan, out.stage, role, flags['--model-source']);
  delete out.model_note;
  if (role === 'verifier' && out.verifies && weakVerifierNote(out.model, out.verifies, ctx)) out.model_note = mp.WEAK_VERIFIER_NOTE;
  return out;
}

function modelProblems(r, i) {
  return ['model', 'verifier_model'].filter((k) => r[k] !== undefined).flatMap((k) => mp.validateModelBlock(r[k]).map((e) => `record ${i + 1}: ${k === 'model' ? e : e.replace(/^model\./, 'verifier_model.')}`));
}

function writeRecords(runDir, records, flags = {}) {
  if (!runDir || !RUN_ID_RE.test(path.basename(runDir)) || !fs.existsSync(path.join(runDir, 'state.json'))) {
    throw new Error('first argument must be an existing <artifacts_dir>/<run-id> directory with state.json');
  }
  const ctx = { plan: readJson(path.join(runDir, 'models.json')), records: listRecords(runDir).map((r) => r.record) };
  const stamped = records.map((r) => stamp(r, flags, ctx));
  const problems = stamped.flatMap((r, i) => [...validateRecord({ ...r, id: 'R-0000' }).map((e) => `record ${i + 1}: ${e}`), ...modelProblems(r, i)]);
  if (problems.length) throw new Error(problems.join('; '));
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  return stamped.map((r) => {
    const id = nextRecordId(runDir);
    fs.writeFileSync(path.join(runDir, 'records', `${id}.json`), JSON.stringify({ ...r, id }, null, 2) + '\n', { flag: 'wx' });
    return id;
  });
}

module.exports = { writeRecords, stamp };
