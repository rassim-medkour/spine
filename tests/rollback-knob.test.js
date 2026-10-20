'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { rollbackAnswer } = require('../scripts/lib/proof');
const { buildPrBody } = require('../scripts/lib/pr-body');
const { parseDiff } = require('../scripts/lib/diff');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const REVISION = `${golden.inputs.head_sha}:${golden.inputs.diff_sha256}`;
const PLAN = '## Rollback\n\nRun `git revert <merge commit>`.\nSecond line.\n';
const planRecord = (over = {}) => ({ id: 'R-0007', proof_kind: 'rollback_plan', revision: REVISION, result: { status: 'ok', plan: PLAN }, ...over });
const gap = { requirement: 'rollback_or_flag_plan', files: ['src/lib/math.ts'], reason: 'no ## Rollback section' };
const proofOf = (over = {}) => ({ revision: REVISION, required: ['rollback_or_flag_plan'], present: [], missing: [], ...over });

test('a valid recorded plan at the current revision answers yes with id and first line', () => {
  assert.equal(rollbackAnswer(golden, proofOf(), [planRecord()]), 'yes (R-0007: Run `git revert <merge commit>`.)');
  const flag = planRecord({ proof_kind: 'flag_plan', result: { status: 'ok', plan: '## Rollback\n\nTurn off flag `risk_tiers`.\n' } });
  assert.equal(rollbackAnswer(golden, proofOf(), [flag]), 'yes (R-0007: Turn off flag `risk_tiers`.)');
});

test('stale, failed or vague plan records do not count; a required plan with none is "no plan"', () => {
  const stale = planRecord({ revision: 'x:y' });
  const failed = planRecord({ result: { status: 'failed', plan: PLAN } });
  const vague = planRecord({ result: { status: 'ok', plan: '## Rollback\n\nbe careful\n' } });
  for (const r of [stale, failed, vague]) assert.equal(rollbackAnswer(golden, proofOf({ missing: [gap] }), [r]), 'no plan');
});

test('without a requirement, or with a plan only in review.md, the tree answer stays', () => {
  assert.equal(rollbackAnswer(golden, proofOf({ required: [] }), []), 'unknown');
  assert.equal(rollbackAnswer(golden, proofOf({ present: [{ requirement: 'rollback_or_flag_plan', record_ids: [] }] }), []), 'unknown');
  assert.equal(rollbackAnswer(golden, null, []), 'unknown');
  assert.equal(rollbackAnswer(null, null, []), 'unknown');
});

test('the PR body knob line and rollout line use the recorded plan', () => {
  const diffFiles = parseDiff('diff --git a/src/lib/math.ts b/src/lib/math.ts\n--- a/src/lib/math.ts\n+++ b/src/lib/math.ts\n@@ -1 +1,2 @@\n const a = 1;\n+export const b = 2;\n');
  const base = { tier: 'trunk', runRel: '.spine/x', diffFiles, tree: golden, review: { verdict: 'PASS', tier: 'trunk', providers: [], findings: [] }, specAssumptions: [], planText: '', readingMap: null };
  const written = ['## TL;DR', '', 'x', '', '## The problem, with an example', '', 'Before: a.', 'After: b.', '', '## The design decision that shaped everything', '', 'y', ''].join('\n');
  const yes = buildPrBody({ ...base, records: [planRecord()], proof: proofOf({ present: [{ requirement: 'rollback_or_flag_plan', record_ids: [] }] }) }, written);
  assert.match(yes.body, /instant rollback yes \(R-0007: Run `git revert <merge commit>`\.\)/);
  assert.match(yes.body, /- Instant rollback: yes \(R-0007:/);
  const none = buildPrBody({ ...base, records: [], proof: proofOf({ missing: [gap] }) }, written);
  assert.match(none.body, /instant rollback no plan/);
});

test('reading-map.md shows the recorded plan answer and tree.json is untouched', () => {
  const root = tmpDir('spine-knob-');
  const dir = path.join(root, '.spine', '20261015-kn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  const diff = 'diff --git a/src/lib/math.ts b/src/lib/math.ts\n--- a/src/lib/math.ts\n+++ b/src/lib/math.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
  fs.writeFileSync(path.join(dir, 'diff.patch'), diff);
  const diffSha = crypto.createHash('sha256').update(diff).digest('hex');
  const tree = { ...golden, inputs: { ...golden.inputs, diff_sha256: diffSha } };
  const treeText = JSON.stringify(tree);
  fs.writeFileSync(path.join(dir, 'tree.json'), treeText);
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reading-map.js'), '--run', dir], { cwd: root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: root }) });
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(path.join(dir, 'reading-map.md'), 'utf8'), /Can it be rolled back instantly\? no plan/);
  const rec = path.join(dir, 'plan.md');
  fs.writeFileSync(rec, PLAN);
  const rp = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'record-proof.js'), '--run', dir, '--kind', 'rollback_plan', '--from', rec], { cwd: root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: root }) });
  assert.equal(rp.status, 0, rp.stderr);
  fs.unlinkSync(rec);
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(path.join(dir, 'reading-map.md'), 'utf8'), /Can it be rolled back instantly\? yes \(R-0001: Run `git revert <merge commit>`\.\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'tree.json'), 'utf8'), treeText);
});
