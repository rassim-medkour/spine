'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');
const { checkProof } = require('../scripts/check-proof');
const { validateRecord } = require('../scripts/lib/validate');
const { tierConfig } = require('../scripts/lib/tier-config');
const { parseCounts } = require('../scripts/lib/record-proof');
const { listRecords } = require('../scripts/lib/records');

const ROOT = path.join(__dirname, '..');
const golden = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const REVISION = () => `${golden().inputs.head_sha}:${golden().inputs.diff_sha256}`;
const noSkill = () => [];

function setup(t) {
  const root = tmpDir('spine-rp-', t);
  const dir = path.join(root, '.spine', '20261015-proof');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(golden()));
  fs.writeFileSync(path.join(dir, 'diff.patch'), '');
  return { root, dir };
}

const record = (root, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'record-proof.js'), ...args], { cwd: root, encoding: 'utf8', env: cleanEnv() });
const saved = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'));
const checked = (root, dir) => checkProof({ runDir: dir, root, tree: golden(), tc: tierConfig({}), findVerify: noSkill, records: listRecords(dir).map((r) => r.record) });
const script = (root, body) => {
  const file = path.join(root, 'fake-tests.js');
  fs.writeFileSync(file, body);
  return `node "${file}"`;
};

test('parseCounts reads node:test TAP totals and returns null for other output', () => {
  assert.deepEqual(parseCounts('ok 1\n# tests 5\n# pass 4\n# fail 0\n# skipped 1\n'), { pass: 4, fail: 0, skip: 1 });
  assert.deepEqual(parseCounts('# pass 3\r\n# fail 2\r\n'), { pass: 3, fail: 2 });
  assert.equal(parseCounts('all good'), null);
});

test('a test_run runs the command and records the revision check-proof expects, counts and a payload', (t) => {
  const { root, dir } = setup(t);
  const command = script(root, "console.log('# tests 3\\n# pass 3\\n# fail 0');");
  const r = record(root, ['--run', dir, '--kind', 'test_run', '--command', command]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).ids, ['R-0001']);
  const rec = saved(dir, 'R-0001');
  assert.deepEqual(validateRecord(rec), []);
  assert.equal(rec.revision, REVISION());
  assert.deepEqual(rec.scope, ['*']);
  assert.deepEqual(rec.result.counts, { pass: 3, fail: 0 });
  assert.equal(rec.result.exit_code, 0);
  assert.equal(rec.result.status, 'ok');
  assert.equal(rec.payloads.length, 1);
  assert.ok(fs.existsSync(path.join(dir, rec.payloads[0].path)));
  const proof = checked(root, dir);
  assert.ok(proof.present.some((p) => p.requirement === 'test_run' && p.record_ids.includes('R-0001')));
  assert.ok(!proof.missing.some((m) => m.requirement === 'test_run'));
});

test('a failing command is recorded with its exit code and fails the CLI', (t) => {
  const { root, dir } = setup(t);
  const command = script(root, "console.log('# pass 1\\n# fail 2'); process.exit(1);");
  const r = record(root, ['--run', dir, '--kind', 'test_run', '--command', command, '--scope', 'src/a.ts,src/b.ts']);
  assert.equal(r.status, 1);
  const rec = saved(dir, 'R-0001');
  assert.equal(rec.result.exit_code, 1);
  assert.deepEqual(rec.result.counts, { pass: 1, fail: 2 });
  assert.deepEqual(rec.scope, ['src/a.ts', 'src/b.ts']);
  assert.ok(checked(root, dir).missing.some((m) => m.requirement === 'test_run' && m.reason === 'test run failed'));
});

test('output without TAP totals records the exit code only and omits counts', (t) => {
  const { root, dir } = setup(t);
  const r = record(root, ['--run', dir, '--kind', 'lint', '--command', script(root, "console.log('clean');")]);
  assert.equal(r.status, 0, r.stderr);
  const rec = saved(dir, 'R-0001');
  assert.equal(rec.proof_kind, 'lint');
  assert.equal(rec.result.counts, undefined);
  assert.equal(rec.result.exit_code, 0);
});

test('--from records captured output without running anything and ids keep counting', (t) => {
  const { root, dir } = setup(t);
  const out = path.join(root, 'captured.txt');
  fs.writeFileSync(out, '# pass 7\n# fail 0\n');
  assert.equal(record(root, ['--run', dir, '--kind', 'test_run', '--command', 'npm test', '--from', out]).status, 0);
  assert.equal(record(root, ['--run', dir, '--kind', 'test_run', '--command', 'npm test', '--from', out]).status, 0);
  const rec = saved(dir, 'R-0002');
  assert.deepEqual(rec.result.counts, { pass: 7, fail: 0 });
  assert.equal(rec.result.command, 'npm test');
});

test('a rollback_plan keeps the plan text in the record and check-proof finds it without review.md', (t) => {
  const { root, dir } = setup(t);
  const plan = path.join(dir, 'rollback.md');
  fs.writeFileSync(plan, '## Rollback\n\nRun `git revert <merge commit>`. Kill switch: set `risk_tiers: false`.\n');
  assert.ok(checked(root, dir).missing.some((m) => m.requirement === 'rollback_or_flag_plan'));
  const r = record(root, ['--run', dir, '--kind', 'rollback_plan', '--from', plan]);
  assert.equal(r.status, 0, r.stderr);
  const rec = saved(dir, 'R-0001');
  assert.deepEqual(validateRecord(rec), []);
  assert.match(rec.result.plan, /## Rollback/);
  assert.equal(rec.revision, REVISION());
  assert.ok(checked(root, dir).present.some((p) => p.requirement === 'rollback_or_flag_plan'));
});

test('a stale rollback_plan record does not satisfy the requirement', (t) => {
  const { root, dir } = setup(t);
  const plan = path.join(dir, 'rollback.md');
  fs.writeFileSync(plan, '## Rollback\n\nRun `git revert HEAD`.\n');
  assert.equal(record(root, ['--run', dir, '--kind', 'rollback_plan', '--from', plan]).status, 0);
  const file = path.join(dir, 'records', 'R-0001.json');
  fs.writeFileSync(file, JSON.stringify({ ...saved(dir, 'R-0001'), revision: 'old:old' }));
  assert.ok(checked(root, dir).missing.some((m) => m.requirement === 'rollback_or_flag_plan'));
});

test('a plan without a ## Rollback heading is refused and nothing is written', (t) => {
  const { root, dir } = setup(t);
  const plan = path.join(root, 'plan.md');
  fs.writeFileSync(plan, 'just revert it\n');
  const r = record(root, ['--run', dir, '--kind', 'rollback_plan', '--from', plan]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /## Rollback/);
  assert.deepEqual(listRecords(dir), []);
});

test('test_quality writes the test-quality records for the run', (t) => {
  const { root, dir } = setup(t);
  const r = record(root, ['--run', dir, '--kind', 'test_quality']);
  assert.equal(r.status, 0, r.stderr);
  const rec = saved(dir, 'R-0001');
  assert.equal(rec.proof_kind, 'test_quality');
  assert.equal(rec.revision, REVISION());
});

test('refuses without tree.json, with an unknown kind, or without a command', (t) => {
  const { root, dir } = setup(t);
  assert.equal(record(root, ['--run', dir, '--kind', 'bogus', '--command', 'x']).status, 1);
  assert.equal(record(root, ['--run', dir, '--kind', 'test_run']).status, 1);
  fs.rmSync(path.join(dir, 'tree.json'));
  const r = record(root, ['--run', dir, '--kind', 'test_run', '--command', 'npm test']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tree\.json/);
});
