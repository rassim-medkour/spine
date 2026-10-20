// tests/write-record.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState } = require('../scripts/lib/state');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const node = (script, args, input) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { input: input || '', encoding: 'utf8', env: cleanEnv() });
function runDir() {
  const dir = path.join(tmpDir('spine-wr-'), '.spine', '20260920-demo');
  writeState(dir, { id: '20260920-demo', stage: 'review', status: 'active', awaiting: null });
  return dir;
}
const rec = (extra = {}) => ({ id: 'R-XXXX', stage: 'review', agent: 'ecc:code-reviewer', claim: 'c', evidence: [{ kind: 'file', ref: 'a.py:1' }], confidence: 0.9, severity: 'HIGH', ...extra });

test('write-record numbers and writes every block from --from-text with stamped provider and author', () => {
  const dir = runDir();
  const t = path.join(dir, 'answer.md');
  const fence = (r) => ['```json spine-record', JSON.stringify(r), '```'].join('\n');
  fs.writeFileSync(t, ['text', fence(rec()), fence(rec({ severity: 'LOW' }))].join('\n'));
  const r = node('write-record.js', [dir, '--from-text', t, '--provider', 'ecc:code-review', '--author', 'ecc', '--host', 'cursor']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).ids, ['R-0001', 'R-0002']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'records', 'R-0001.json'), 'utf8'));
  assert.equal(saved.id, 'R-0001');
  assert.equal(saved.provider, 'ecc:code-review');
  assert.equal(saved.author, 'ecc');
  assert.equal(saved.host, 'cursor');
});
test('write-record refuses an unverified-only HIGH record and writes nothing', () => {
  const dir = runDir();
  const r = node('write-record.js', [dir], JSON.stringify(rec({ evidence: [{ kind: 'unverified', ref: 'h' }] })));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /severity HIGH requires/);
  assert.equal(fs.existsSync(path.join(dir, 'records')), false);
});
test('write-record rejects a directory that is not a run dir and malformed flags', () => {
  assert.equal(node('write-record.js', [os.tmpdir()], JSON.stringify(rec())).status, 1);
  assert.equal(node('write-record.js', [runDir(), '--verifies', '../x'], JSON.stringify(rec())).status, 1);
  assert.equal(node('write-record.js', [runDir(), '--verified', 'maybe'], JSON.stringify(rec())).status, 1);
});
test('pick-verifier, da-gate and check-cross-author work end to end', () => {
  const dir = runDir();
  node('write-record.js', [dir, '--provider', 'ecc:code-review', '--author', 'ecc'], JSON.stringify(rec({ evidence: [{ kind: 'file', ref: 'a.py:1' }, { kind: 'test', ref: 't' }] })));
  const provFile = path.join(dir, 'providers.json');
  fs.writeFileSync(provFile, JSON.stringify([{ id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1 }, { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5 }]));
  const plan = JSON.parse(node('pick-verifier.js', [dir, '--providers', provFile]).stdout);
  assert.equal(plan[0].verifier.id, 'feature-dev:code-reviewer');
  node('write-record.js', [dir, '--provider', 'ecc:code-review', '--author', 'ecc', '--verifies', 'R-0001', '--verified', 'true'], JSON.stringify(rec({ severity: 'INFO' })));
  const bad = node('check-cross-author.js', [dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /same author ecc/);
  const gate = JSON.parse(node('da-gate.js', [dir, '--devils-advocate', 'true']).stdout);
  assert.equal(typeof gate.open, 'boolean');
});
