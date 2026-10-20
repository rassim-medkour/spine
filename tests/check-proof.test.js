'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { checkProof } = require('../scripts/check-proof');
const { tierConfig } = require('../scripts/lib/tier-config');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const tc = tierConfig({});
const golden = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const REV = `${'2'.repeat(40)}:${'3'.repeat(64)}`;
const PASS = { command: 'npm test', exit_code: 0, counts: { pass: 3, fail: 0 }, status: 'ok' };
let n = 0;
const rec = (kind, result = PASS, extra = {}) => ({ id: `R-${String((n += 1)).padStart(4, '0')}`, stage: 'review', agent: 'spine:proof', claim: kind, evidence: [{ kind: 'command', ref: 'x' }], confidence: 1, severity: 'INFO', proof_kind: kind, revision: REV, scope: ['*'], result, ...extra });

function runDir() {
  const root = tmpDir('spine-proof-');
  const dir = path.join(root, '.spine', '20261015-proof');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  return { root, dir };
}

function leafTree() {
  const t = golden();
  return { ...t, tier: 'leaf', files: [{ ...t.files[1], path: 'src/a.ts', tier: 'leaf', reasons: ['leaf: fan-in 0, no trunk or branch signal'] }] };
}

const REV_EXPECTED = `${golden().inputs.head_sha}:${golden().inputs.diff_sha256}`;
const noSkill = () => [];
const check = (over) => checkProof({ tc, findVerify: noSkill, records: [], ...over });

test('leaf change with test run and lint has no proof gaps and covers the file', () => {
  const { root, dir } = runDir();
  const t = rec('test_run');
  const out = check({ runDir: dir, root, tree: leafTree(), records: [t, rec('lint', { command: 'npm run lint', exit_code: 0, status: 'ok' })] });
  assert.deepEqual(out.required, ['test_run', 'static_check']);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.covering, { 'src/a.ts': [t.id] });
});

test('stale proof stays a gap and names why', () => {
  const { root, dir } = runDir();
  const out = check({ runDir: dir, root, tree: leafTree(), records: [rec('test_run', PASS, { revision: `${'9'.repeat(40)}:x` })] });
  const gap = out.missing.find((m) => m.requirement === 'test_run');
  assert.match(gap.reason, /^stale/);
  assert.ok(gap.reason.includes(REV_EXPECTED), 'names the expected revision');
  assert.ok(gap.reason.includes('9'.repeat(40) + ':x'), 'names the record revision');
  assert.match(gap.reason, /record-proof.js/);
  assert.deepEqual(gap.files, ['src/a.ts']);
  assert.ok(gap.hint.length > 0);
});

test('a payload with a wrong hash or a missing file is a gap', () => {
  const { root, dir } = runDir();
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'app.log'), 'started\n');
  const good = crypto.createHash('sha256').update('started\n').digest('hex');
  const t = { ...golden(), tier: 'branch', files: [{ ...golden().files[1], tier: 'branch' }] };
  const log = (payloads) => rec('runtime_log', { command: 'npm start', exit_code: 0, status: 'ok' }, { payloads });
  const base = [rec('test_run'), rec('lint', { command: 'l', exit_code: 0, status: 'ok' })];
  assert.deepEqual(check({ runDir: dir, root, tree: t, records: [...base, log([{ path: 'evidence/app.log', sha256: good, bytes: 8 }])] }).missing, []);
  assert.equal(check({ runDir: dir, root, tree: t, records: [...base, log([{ path: 'evidence/app.log', sha256: 'f'.repeat(64), bytes: 8 }])] }).missing[0].reason, 'payload hash mismatch');
  assert.equal(check({ runDir: dir, root, tree: t, records: [...base, log([{ path: 'evidence/gone.log', sha256: good, bytes: 8 }])] }).missing[0].reason, 'payload missing');
});

test('trunk without a verify skill: live verify exempt as INFO, rollback section checked', () => {
  const { root, dir } = runDir();
  const out = check({ runDir: dir, root, tree: golden() });
  assert.ok(!out.required.includes('live_verify'));
  assert.deepEqual(out.info, [{ requirement: 'live_verify', exempt: true, reason: 'no project verify skill covers the trunk files' }]);
  const why = out.missing.find((m) => m.requirement === 'rollback_or_flag_plan').reason;
  assert.match(why, /^no ## Rollback section/);
  assert.match(why, /review.md/);
  assert.match(why, /plan.md/);
  assert.match(why, /record-proof.js/);
  fs.writeFileSync(path.join(dir, 'review.md'), '## Rollback\n\nRun `git revert HEAD`.\n');
  const after = check({ runDir: dir, root, tree: golden() });
  assert.ok(after.present.some((p) => p.requirement === 'rollback_or_flag_plan'));
});

test('trunk with a verify skill requires live verify for the covered files', () => {
  const { root, dir } = runDir();
  const skill = () => [{ skillDir: '.claude/skills/verify', covers: ['src/lib/math.ts'] }];
  const out = checkProof({ runDir: dir, root, tree: golden(), records: [], tc, findVerify: skill });
  const gap = out.missing.find((m) => m.requirement === 'live_verify');
  assert.deepEqual(gap.files, ['src/lib/math.ts']);
  assert.deepEqual(out.info, []);
});

test('a migration file adds the dry-run requirement; no checkout changes the hint', () => {
  const { root, dir } = runDir();
  const t = golden();
  const mig = { ...t.files[1], path: 'db/migrations/0002.sql', parser: 'generic', signals: { ...t.files[1].signals, one_way_door: { value: true, rule: 'migration path' } } };
  const tree = { ...t, files: [mig, t.files[1]] };
  const out = check({ runDir: dir, root, tree, noCheckout: true });
  const gap = out.missing.find((m) => m.requirement === 'migration_dry_run');
  assert.deepEqual(gap.files, ['db/migrations/0002.sql']);
  assert.equal(gap.hint, 'check out the branch to collect proof');
  assert.match(out.missing.find((m) => m.requirement === 'rollback_or_flag_plan').hint, /backup or restore/);
});

test('docs-only change never produces a proof gap', () => {
  const { root, dir } = runDir();
  const t = golden();
  const out = check({ runDir: dir, root, tree: { ...t, tier: 'leaf', files: [t.files[0]] } });
  assert.deepEqual([out.required, out.missing], [[], []]);
});

test('no tree.json or the kill switch means legacy, no requirements', () => {
  const { root, dir } = runDir();
  assert.equal(check({ runDir: dir, root, tree: null }).legacy, true);
  assert.equal(checkProof({ runDir: dir, root, tree: golden(), records: [], tc: tierConfig({ risk_tiers: false }), findVerify: noSkill }).legacy, true);
});

test('CLI writes proof.json and exits 0 with ok false on a malformed tree.json', () => {
  const { root, dir } = runDir();
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(leafTree()));
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-proof.js'), ...args], { cwd: root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: root }) });
  const out = cli(['--run', dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'proof.json'), 'utf8')).required, ['test_run', 'static_check']);
  fs.writeFileSync(path.join(dir, 'tree.json'), '{ broken');
  assert.equal(JSON.parse(cli(['--run', dir]).stdout).ok, false);
});

test('a record scoped to one file does not satisfy a requirement spanning two', () => {
  const { root, dir } = runDir();
  const base = leafTree();
  const second = { ...base.files[0], path: 'src/b.ts' };
  const tree = { ...base, files: [...base.files, second] };
  const lint = rec('lint', { command: 'npm run lint', exit_code: 0, status: 'ok' });
  const partial = check({ runDir: dir, root, tree, records: [rec('test_run', PASS, { scope: ['src/a.ts'] }), lint] });
  const gap = partial.missing.find((m) => m.requirement === 'test_run');
  assert.ok(gap, 'scoped record leaves a gap');
  assert.match(gap.reason, /src\/b\.ts/);
  const union = check({ runDir: dir, root, tree, records: [rec('test_run', PASS, { scope: ['src/a.ts'] }), rec('test_run', PASS, { scope: ['src/b.ts'] }), lint] });
  assert.equal(union.missing.find((m) => m.requirement === 'test_run'), undefined);
  const whole = check({ runDir: dir, root, tree, records: [rec('test_run', PASS, { scope: undefined }), lint] });
  assert.equal(whole.missing.find((m) => m.requirement === 'test_run'), undefined);
});
