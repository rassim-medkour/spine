'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeVerdict, applyToReview } = require('../scripts/verdict');
const { checkProof } = require('../scripts/check-proof');
const { tierConfig } = require('../scripts/lib/tier-config');
const { validateReview, validateArtifactFile } = require('../scripts/lib/validate');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const tc = tierConfig({});
const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const GAP = { requirement: 'test_run', kinds: ['test_run'], tier: 'trunk', files: ['src/lib/math.ts'], reason: 'no proof record', hint: 'run the tests' };
const proof = (missing = []) => ({ ok: true, legacy: false, missing });
const finding = (id, severity, extra = {}) => ({ id, stage: 'review', agent: 'ecc:code-review', claim: 'c', evidence: [{ kind: 'file', ref: 'src/a.ts:1' }], confidence: 0.9, severity, ...extra });
const v = (records, missing = [], cfg = tc) => computeVerdict({ records, tree, proof: proof(missing), tc: cfg });

test('precedence: FAIL > UNPROVEN > PASS_WITH_ADVISORIES > PASS', () => {
  const fail = v([finding('R-0001', 'HIGH', { verified: true })], [GAP]);
  assert.equal(fail.verdict, 'FAIL');
  assert.deepEqual(fail.missing_proof, [{ requirement: 'test_run', kinds: ['test_run'], tier: 'trunk', files: ['src/lib/math.ts'], hint: 'run the tests' }]);
  assert.equal(v([finding('R-0001', 'MEDIUM')], [GAP]).verdict, 'UNPROVEN');
  assert.equal(v([finding('R-0001', 'MEDIUM')]).verdict, 'PASS_WITH_ADVISORIES');
  assert.equal(v([finding('R-0001', 'INFO')]).verdict, 'PASS');
  assert.equal(v([]).verdict, 'PASS');
});

test('verification decides whether a HIGH fails the review', () => {
  assert.equal(v([finding('R-0001', 'HIGH', { verified: false })]).verdict, 'PASS_WITH_ADVISORIES');
  const verifier = { id: 'R-0002', stage: 'review', agent: 'feature-dev:code-reviewer', verifies: 'R-0001', verified: true, claim: 'v', evidence: [{ kind: 'file', ref: 'src/a.ts:1' }], confidence: 1, severity: 'INFO' };
  assert.equal(v([finding('R-0001', 'HIGH'), verifier]).verdict, 'FAIL');
  const live = { id: 'R-0003', stage: 'review', agent: 'spine:live-verify', claim: 'checkout broken', evidence: [{ kind: 'file', ref: 'evidence/s.png' }], confidence: 1, severity: 'HIGH' };
  assert.equal(v([live]).verdict, 'FAIL');
});

test('a finding closed by a resolves record no longer counts', () => {
  const fix = { id: 'R-0002', stage: 'review', agent: 'spine:orchestrator', resolves: 'R-0001', claim: 'fixed', evidence: [{ kind: 'test', ref: 'npm test' }], confidence: 1, severity: 'INFO' };
  assert.equal(v([finding('R-0001', 'HIGH', { verified: true }), fix]).verdict, 'PASS');
});

test('hollow-test flags are advisories and never cause UNPROVEN', () => {
  const hollow = { id: 'R-0001', stage: 'review', agent: 'spine:test-quality', claim: 'hollow test: no-assertion', evidence: [{ kind: 'file', ref: 't.test.js:3' }], confidence: 0.7, severity: 'MEDIUM' };
  assert.equal(v([hollow]).verdict, 'PASS_WITH_ADVISORIES');
});

test('shadow mode by default; unproven_blocks needs a covering waiver', () => {
  const shadow = v([], [GAP]);
  assert.equal(shadow.proof_gate, 'shadow');
  assert.equal(shadow.unproven_needs_waiver, false);
  const enforce = tierConfig({ unproven_blocks: true });
  assert.equal(v([], [GAP], enforce).unproven_needs_waiver, true);
  const waiver = { id: 'R-0009', stage: 'review', agent: 'spine:orchestrator', claim: 'G3 waiver: UNPROVEN accepted', evidence: [{ kind: 'doc', ref: 'human message', note: 'ship it' }], confidence: 1, severity: 'INFO', waives: ['test_run'] };
  const waived = v([waiver], [GAP], enforce);
  assert.deepEqual(waived.waiver, { record_id: 'R-0009', covers_all: true });
  assert.equal(waived.unproven_needs_waiver, false);
});

test('legacy runs and the kill switch keep the v0.2.0 verdict shape', () => {
  const legacy = computeVerdict({ records: [finding('R-0001', 'MEDIUM')], tree: null, proof: null, tc });
  assert.deepEqual(legacy, { verdict: 'PASS_WITH_ADVISORIES', legacy: true });
  assert.equal(computeVerdict({ records: [], tree, proof: proof([GAP]), tc: tierConfig({ risk_tiers: false }) }).legacy, true);
  const old = { id: 'r', upstream_id: 'u', verdict: 'PASS', providers: [], findings: [], dissent: [], tier: 'leaf', missing_proof: [] };
  assert.deepEqual(applyToReview(old, legacy), { id: 'r', upstream_id: 'u', verdict: 'PASS_WITH_ADVISORIES', providers: [], findings: [], dissent: [] });
});

test('docs-only change needs no proof and passes', () => {
  const docsTree = { ...tree, tier: 'leaf', files: [tree.files[0]] };
  const p = checkProof({ runDir: os.tmpdir(), root: os.tmpdir(), tree: docsTree, records: [], tc, findVerify: () => [] });
  assert.equal(computeVerdict({ records: [], tree: docsTree, proof: p, tc }).verdict, 'PASS');
});

test('review.json schema: UNPROVEN needs missing_proof; v0.2.0 files still validate', () => {
  const base = { id: 'r', upstream_id: 'u', providers: [], findings: [], dissent: [] };
  assert.deepEqual(validateReview({ ...base, verdict: 'PASS_WITH_ADVISORIES' }), []);
  assert.deepEqual(validateReview({ ...base, verdict: 'UNPROVEN' }), ['missing_proof must be a non-empty array when verdict is UNPROVEN']);
  assert.deepEqual(validateReview({ ...base, verdict: 'UNPROVEN', tier: 'trunk', missing_proof: [{ requirement: 'test_run', kinds: ['test_run'], files: [] }] }), []);
  assert.deepEqual(validateReview({ ...base, verdict: 'MAYBE' }), ['verdict must be one of PASS, FAIL, PASS_WITH_ADVISORIES, UNPROVEN, got MAYBE']);
  const applied = applyToReview({ ...base, verdict: 'PASS' }, v([], [GAP]));
  assert.deepEqual(validateReview(applied), []);
  assert.equal(applied.tier, 'trunk');
});

function oldRun() {
  const root = tmpDir('spine-oldrun-');
  const home = tmpDir('spine-oldrun-home-');
  const id = '20260920-old-review';
  const dir = path.join(root, '.spine', id);
  writeState(dir, { id, stage: 'review', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z', host: 'claude-code' });
  setActive(root, loadConfig(root, home), id);
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ id: `${id}-review`, upstream_id: 'none', verdict: 'PASS', providers: ['ecc:code-review'], findings: [], dissent: [] }));
  fs.mkdirSync(path.join(dir, 'records'));
  fs.writeFileSync(path.join(dir, 'records', 'R-0001.json'), JSON.stringify({ id: 'R-0001', stage: 'review', agent: 'spine:boundary-checker', claim: 'PASS', evidence: [{ kind: 'doc', ref: 'review.json:1' }], confidence: 1, severity: 'INFO' }));
  return { root, home, dir };
}

test('a v0.2.0 run resumes cleanly: Stop gate allows it and verdict.js uses the old rules', () => {
  const r = oldRun();
  const stop = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'stop-gate.js')], { input: JSON.stringify({ cwd: r.root, stop_hook_active: false }), encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home }) });
  assert.equal(stop.status, 0, stop.stderr);
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verdict.js'), '--run', r.dir, '--write'], { cwd: r.root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home }) });
  assert.deepEqual(JSON.parse(out.stdout), { ok: true, verdict: 'PASS', legacy: true });
  assert.deepEqual(validateArtifactFile(path.join(r.dir, 'review.json'), 'review.json'), []);
});

test('PostToolUse fails open on an UNPROVEN review.json without missing_proof', () => {
  const r = oldRun();
  const file = path.join(r.dir, 'review.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'x', upstream_id: 'none', verdict: 'UNPROVEN', providers: [], findings: [], dissent: [] }));
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-artifact.js')], { input: JSON.stringify({ cwd: r.root, tool_input: { file_path: file } }), encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home }) });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /missing_proof must be a non-empty array/);
});
