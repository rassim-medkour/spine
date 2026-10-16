'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { tierConfig } = require('./lib/tier-config');
const { realPathInside } = require('./lib/paths');
const { validateTree } = require('./lib/validate');
const { requiredEvidence, changeContext, recordSatisfies, checkRollbackPlan, REQUIREMENTS, RUNTIME, HINTS } = require('./lib/proof');
const { findVerifySkills } = require('./find-verify');

const COVERING = new Set(['test_run', 'integration_or_runtime']);
const LEGACY = Object.freeze({ ok: true, legacy: true, tier: null, revision: null, required: [], present: [], missing: [], info: [], covering: {} });

function verifyPayload(runDir) {
  return (p) => {
    if (!p || typeof p.path !== 'string' || typeof p.sha256 !== 'string') return { ok: false, reason: 'payload reference incomplete' };
    const inside = realPathInside(path.join(runDir, 'evidence'), path.join(runDir, p.path));
    if (!inside) return { ok: false, reason: 'payload missing' };
    const hash = crypto.createHash('sha256').update(fs.readFileSync(inside.abs)).digest('hex');
    return hash === p.sha256 ? { ok: true, reason: 'payload verified' } : { ok: false, reason: 'payload hash mismatch' };
  };
}

const readFileOrEmpty = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function filesFor(requirement, tree, liveFiles) {
  if (requirement === 'live_verify') return liveFiles;
  if (requirement === 'migration_dry_run') return tree.files.filter((f) => /^migration/.test(f.signals.one_way_door.rule) && f.signals.one_way_door.value === true).map((f) => f.path);
  return tree.files.filter((f) => requiredEvidence(f.tier, changeContext([f])).includes(requirement)).map((f) => f.path);
}

function hintFor(requirement, noCheckout, oneWayDoor) {
  if (noCheckout && RUNTIME.has(requirement)) return 'check out the branch to collect proof';
  if (requirement === 'rollback_or_flag_plan' && oneWayDoor) return `${HINTS.rollback_or_flag_plan}, with backup or restore steps`;
  return HINTS[requirement];
}

function scopeOf(record, tree) {
  const all = tree.files.map((f) => f.path);
  if (!Array.isArray(record.scope) || record.scope.includes('*')) return all;
  return all.filter((p) => record.scope.includes(p));
}

function liveContext(tree, root, findVerify) {
  const trunkFiles = tree.files.filter((f) => f.tier === 'trunk').map((f) => f.path);
  const skills = tree.tier === 'trunk' && trunkFiles.length ? findVerify(trunkFiles, root) : [];
  const liveFiles = [...new Set(skills.flatMap((s) => s.covers))].sort();
  const info = tree.tier === 'trunk' && !skills.length ? [{ requirement: 'live_verify', exempt: true, reason: 'no project verify skill covers the trunk files' }] : [];
  return { liveVerify: skills.length > 0, liveFiles, info };
}

function checkProof({ runDir, root, tree, records, tc, noCheckout = false, findVerify = findVerifySkills, readText = readFileOrEmpty }) {
  if (!tc.enabled || !tree) return LEGACY;
  const revision = `${tree.inputs.head_sha}:${tree.inputs.diff_sha256}`;
  const live = liveContext(tree, root, findVerify);
  const required = requiredEvidence(tree.tier, { ...changeContext(tree.files), liveVerify: live.liveVerify });
  const oneWayDoor = tree.files.some((f) => f.signals.one_way_door.value === true);
  const proofRecords = records.filter((r) => r.proof_kind || r.agent === 'spine:live-verify');
  const ctx = { revision, verifyPayload: verifyPayload(runDir) };
  const planText = ['review.md', 'plan.md'].map((n) => readText(path.join(runDir, n))).join('\n');
  const present = [];
  const missing = [];
  const covering = {};
  const gap = (requirement, reason) => ({ requirement, kinds: [...REQUIREMENTS[requirement]], tier: tree.tier, files: filesFor(requirement, tree, live.liveFiles), reason, hint: hintFor(requirement, noCheckout, oneWayDoor) });
  for (const requirement of required) {
    if (requirement === 'rollback_or_flag_plan') {
      const plan = checkRollbackPlan(planText, { oneWayDoor });
      if (plan.ok) present.push({ requirement, record_ids: [], source: 'review.md or plan.md ## Rollback' });
      else missing.push(gap(requirement, plan.reason));
      continue;
    }
    const judged = proofRecords.map((r) => ({ r, v: recordSatisfies(r, requirement, ctx) })).filter(({ v }) => v.reason !== 'other proof kind');
    const good = judged.filter(({ v }) => v.ok).map(({ r }) => r);
    if (!good.length) {
      missing.push(gap(requirement, judged.length ? judged[judged.length - 1].v.reason : 'no proof record'));
      continue;
    }
    const covered = new Set(good.flatMap((r) => scopeOf(r, tree)));
    const uncovered = gap(requirement, '').files.filter((p) => !covered.has(p));
    if (uncovered.length) missing.push(gap(requirement, `proof scope misses ${uncovered.join(', ')}`));
    else present.push({ requirement, record_ids: good.map((r) => r.id) });
    if (!COVERING.has(requirement)) continue;
    for (const r of good) for (const p of scopeOf(r, tree)) covering[p] = [...new Set([...(covering[p] || []), r.id])].sort();
  }
  return { ok: true, legacy: false, tier: tree.tier, revision, required, present, missing, info: live.info, covering };
}

function main(argv, root = process.cwd()) {
  const i = argv.indexOf('--run');
  if (i < 0 || !argv[i + 1]) throw new Error('usage: check-proof.js --run <run dir> [--no-checkout]');
  const runDir = path.resolve(root, argv[i + 1]);
  const treePath = path.join(runDir, 'tree.json');
  let tree = null;
  if (fs.existsSync(treePath)) {
    tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
    const problems = validateTree(tree);
    if (problems.length) throw new Error(`tree.json invalid: ${problems.length} problem(s)`);
  }
  const result = checkProof({ runDir, root, tree, records: listRecords(runDir).map((r) => r.record), tc: tierConfig(loadConfig(root)), noCheckout: argv.includes('--no-checkout') });
  fs.writeFileSync(path.join(runDir, 'proof.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { checkProof, verifyPayload };
