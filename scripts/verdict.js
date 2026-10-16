'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, readJson } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { tierConfig } = require('./lib/tier-config');
const { isFinding, latestVerification } = require('./lib/cross-author');
const { validateReview, validateTree } = require('./lib/validate');
const { checkProof } = require('./check-proof');

const STRONG = new Set(['CRITICAL', 'HIGH']);
const ADVISORY = new Set(['MEDIUM', 'LOW']);

function openFindings(records) {
  const closed = new Set(records.filter((r) => typeof r.resolves === 'string').map((r) => r.resolves));
  const hollow = (r) => r.agent === 'spine:test-quality' && r.severity === 'MEDIUM';
  const live = (r) => r.agent === 'spine:live-verify' && r.severity !== 'INFO';
  return records.filter((r) => (isFinding(r) || hollow(r) || live(r)) && !closed.has(r.id));
}

function verifiedStrong(r, records) {
  if (!STRONG.has(r.severity)) return false;
  if (r.agent === 'spine:live-verify' || r.verified === true) return true;
  const check = latestVerification(records, [r.id]);
  return Boolean(check && check.verified === true);
}

function findWaiver(records, missing) {
  const waivers = records.filter((r) => r.agent === 'spine:orchestrator' && Array.isArray(r.waives));
  if (!waivers.length) return null;
  const last = waivers[waivers.length - 1];
  return { record_id: last.id, covers_all: missing.every((m) => last.waives.includes(m.requirement)) };
}

function computeVerdict({ records, tree, proof, tc }) {
  const open = openFindings(records);
  const legacy = !tc.enabled || !tree || !proof || proof.legacy;
  const missing = legacy ? [] : proof.missing.map((m) => ({ requirement: m.requirement, kinds: m.kinds, tier: m.tier, files: m.files, hint: m.hint }));
  let verdict = 'PASS';
  if (open.some((r) => verifiedStrong(r, records))) verdict = 'FAIL';
  else if (missing.length) verdict = 'UNPROVEN';
  else if (open.some((r) => ADVISORY.has(r.severity) || STRONG.has(r.severity))) verdict = 'PASS_WITH_ADVISORIES';
  if (legacy) return { verdict, legacy: true };
  const waiver = findWaiver(records, missing);
  return {
    verdict, legacy: false, tier: tree.tier, missing_proof: missing,
    proof_gate: tc.unproven_blocks ? 'enforce' : 'shadow',
    waiver,
    unproven_needs_waiver: verdict === 'UNPROVEN' && tc.unproven_blocks && !(waiver && waiver.covers_all),
  };
}

function applyToReview(review, result) {
  const { tier, missing_proof: missingProof, ...rest } = review;
  const base = { ...rest, verdict: result.verdict };
  if (result.legacy) return base;
  return { ...base, tier: result.tier, ...(result.missing_proof.length ? { missing_proof: result.missing_proof } : {}) };
}

function loadTree(runDir) {
  const tree = readJson(path.join(runDir, 'tree.json'));
  if (!tree) return null;
  const problems = validateTree(tree);
  if (problems.length) throw new Error(`tree.json invalid: ${problems.length} problem(s)`);
  return tree;
}

function main(argv, root = process.cwd()) {
  const i = argv.indexOf('--run');
  if (i < 0 || !argv[i + 1]) throw new Error('usage: verdict.js --run <run dir> [--write] [--no-checkout]');
  const runDir = path.resolve(root, argv[i + 1]);
  const tc = tierConfig(loadConfig(root));
  const records = listRecords(runDir).map((r) => r.record);
  const tree = loadTree(runDir);
  const proof = tree ? checkProof({ runDir, root, tree, records, tc, noCheckout: argv.includes('--no-checkout') }) : null;
  const result = computeVerdict({ records, tree, proof, tc });
  if (!argv.includes('--write')) return { ok: true, ...result };
  const reviewPath = path.join(runDir, 'review.json');
  const review = readJson(reviewPath);
  if (!review) throw new Error('write review.json before running verdict.js --write');
  const next = applyToReview(review, result);
  const problems = validateReview(next);
  if (problems.length) throw new Error(`review.json would be invalid: ${problems.join('; ')}`);
  fs.writeFileSync(reviewPath, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, ...result };
}

if (require.main === module) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { computeVerdict, applyToReview };
