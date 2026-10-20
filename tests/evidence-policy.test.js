'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const proof = require('../scripts/lib/proof');

const { requiredEvidence, changeContext, checkTestRun, checkMigrationDryRun, checkRollbackPlan, recordSatisfies } = proof;
const REV = `${'2'.repeat(40)}:${'3'.repeat(64)}`;
const ok = () => ({ ok: true, reason: 'payload verified' });
const rec = (kind, result, extra = {}) => ({ id: 'R-0009', stage: 'review', agent: 'spine:proof', claim: kind, evidence: [{ kind: 'command', ref: 'x' }], confidence: 1, severity: 'INFO', proof_kind: kind, revision: REV, scope: ['*'], result, ...extra });
const pass = { command: 'npm test', exit_code: 0, counts: { pass: 3, fail: 0, skip: 1 }, status: 'ok' };

test('requiredEvidence covers every tier and all four live-verify and migration combinations', () => {
  assert.deepEqual(requiredEvidence('leaf'), ['test_run', 'static_check']);
  assert.deepEqual(requiredEvidence('branch'), ['test_run', 'static_check', 'integration_or_runtime']);
  const trunk = ['test_run', 'static_check', 'integration_or_runtime', 'rollback_or_flag_plan', 'test_quality'];
  assert.deepEqual(requiredEvidence('trunk', { migration: false, liveVerify: false }), trunk);
  assert.deepEqual(requiredEvidence('trunk', { migration: true, liveVerify: false }), [...trunk, 'migration_dry_run']);
  assert.deepEqual(requiredEvidence('trunk', { migration: false, liveVerify: true }), [...trunk, 'live_verify']);
  assert.deepEqual(requiredEvidence('trunk', { migration: true, liveVerify: true }), [...trunk, 'migration_dry_run', 'live_verify']);
});

test('docs-only needs no proof; test-only needs only a test run; empty change needs nothing', () => {
  const f = (p, rule = 'no one-way-door pattern') => ({ path: p, signals: { one_way_door: { value: rule !== 'no one-way-door pattern', rule } } });
  assert.deepEqual(requiredEvidence('leaf', changeContext([f('README.md'), f('docs/a.md')])), []);
  assert.deepEqual(requiredEvidence('branch', changeContext([f('tests/a.test.js'), f('README.md')])), ['test_run']);
  assert.deepEqual(requiredEvidence('leaf', changeContext([])), []);
  assert.equal(changeContext([f('db/migrations/1.sql', 'migration path')]).migration, true);
  assert.equal(changeContext([f('api/x.graphql', 'external contract file')]).migration, false);
});

test('test_run shape: command, integer exit_code, integer counts, and it must pass', () => {
  assert.equal(checkTestRun(pass).ok, true);
  assert.equal(checkTestRun({ ...pass, command: '' }).ok, false);
  assert.equal(checkTestRun({ ...pass, exit_code: '0' }).ok, false);
  assert.equal(checkTestRun({ ...pass, counts: { pass: 3 } }).ok, false);
  assert.equal(checkTestRun({ ...pass, counts: { pass: 3, fail: 0, skip: 'one' } }).ok, false);
  assert.equal(checkTestRun({ ...pass, exit_code: 1 }).reason, 'test run failed');
  assert.equal(checkTestRun({ ...pass, counts: { pass: 3, fail: 1 } }).reason, 'test run failed');
});

test('freshness: proof against another revision does not close a gap', () => {
  const sat = (r) => recordSatisfies(r, 'test_run', { revision: REV, verifyPayload: ok });
  assert.equal(sat(rec('test_run', pass)).ok, true);
  assert.match(sat(rec('test_run', pass, { revision: `${'9'.repeat(40)}:${'3'.repeat(64)}` })).reason, /^stale/);
  assert.match(sat(rec('test_run', pass, { revision: undefined })).reason, /^stale/);
});

test('a timed-out command counts as missing', () => {
  assert.equal(recordSatisfies(rec('test_run', { ...pass, status: 'timeout' }), 'test_run', { revision: REV, verifyPayload: ok }).reason, 'command timed out');
});

test('lint or typecheck satisfies static_check; other kinds are skipped', () => {
  const lint = rec('lint', { command: 'npm run lint', exit_code: 0, status: 'ok' });
  assert.equal(recordSatisfies(lint, 'static_check', { revision: REV, verifyPayload: ok }).ok, true);
  assert.equal(recordSatisfies(lint, 'test_run', { revision: REV, verifyPayload: ok }).reason, 'other proof kind');
});

test('runtime logs and live verify need a verified payload', () => {
  const log = rec('runtime_log', { command: 'npm start', exit_code: 0, status: 'ok' });
  assert.equal(recordSatisfies(log, 'integration_or_runtime', { revision: REV, verifyPayload: ok }).reason, 'no evidence payload');
  const withPayload = { ...log, payloads: [{ path: 'evidence/app.log', sha256: 'a'.repeat(64), bytes: 1 }] };
  assert.equal(recordSatisfies(withPayload, 'integration_or_runtime', { revision: REV, verifyPayload: ok }).ok, true);
  const bad = () => ({ ok: false, reason: 'payload hash mismatch' });
  assert.equal(recordSatisfies(withPayload, 'integration_or_runtime', { revision: REV, verifyPayload: bad }).reason, 'payload hash mismatch');
  const legacyLive = { id: 'R-0010', agent: 'spine:live-verify', severity: 'INFO', revision: REV, payloads: [{ path: 'evidence/s.png', sha256: 'b'.repeat(64), bytes: 1 }], evidence: [] };
  assert.equal(recordSatisfies(legacyLive, 'live_verify', { revision: REV, verifyPayload: ok }).ok, true);
});

test('migration dry-run must name a non-production target and show the flag or target', () => {
  const base = { command: 'alembic upgrade head --sql', exit_code: 0, status: 'ok', target: 'local sqlite' };
  assert.equal(checkMigrationDryRun(base).ok, true);
  assert.equal(checkMigrationDryRun({ ...base, target: 'production' }).ok, false);
  assert.equal(checkMigrationDryRun({ ...base, target: undefined }).ok, false);
  assert.equal(checkMigrationDryRun({ ...base, command: 'alembic upgrade head', target: 'staging' }).ok, false);
  assert.equal(checkMigrationDryRun({ ...base, command: 'DATABASE_URL=$PROD alembic upgrade head --sql' }).ok, false);
});

test('rollback or flag plan: a named section that names something concrete', () => {
  assert.equal(checkRollbackPlan('# Review\n\nno plan here').reason, 'no ## Rollback section');
  assert.equal(checkRollbackPlan('## Rollback\n\nWe will be careful.').ok, false);
  assert.equal(checkRollbackPlan('## Rollback\n\nRun `git revert abc123` and redeploy.').ok, true);
  assert.equal(checkRollbackPlan('## Flag plan\n\nTurn off the `new_checkout` flag.').ok, true);
  assert.equal(checkRollbackPlan('## Rollback\n\nThis is not instantly reversible.').ok, true);
  assert.equal(checkRollbackPlan('## Rollback\n\n1. Revert the deploy.\n2. Re-run the job.\n\n## Next\n\nbackup').ok, true);
  const door = '## Rollback\n\nRun `git revert abc123`.';
  assert.equal(checkRollbackPlan(door, { oneWayDoor: true }).reason, 'one-way door needs backup or restore steps');
  assert.equal(checkRollbackPlan(`${door}\nRestore from the nightly backup first.`, { oneWayDoor: true }).ok, true);
});
