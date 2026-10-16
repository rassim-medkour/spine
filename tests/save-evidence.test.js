'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { saveEvidence } = require('../scripts/save-evidence');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
function runDir() {
  const root = tmpDir('spine-ev-');
  const dir = path.join(root, '.spine', '20261015-ev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  return { root, dir };
}

test('copies the file under evidence/ with its sha256 and size', () => {
  const { root, dir } = runDir();
  const src = path.join(root, 'out.txt');
  fs.writeFileSync(src, 'ok 1\nok 2\n');
  const r = saveEvidence({ runDir: dir, from: src, name: 'test-run.txt', cap: 1024 });
  assert.equal(r.path, 'evidence/test-run.txt');
  assert.equal(r.truncated, false);
  const body = fs.readFileSync(path.join(dir, 'evidence', 'test-run.txt'));
  assert.equal(r.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(r.bytes, body.length);
});

test('a capture over the cap is truncated with a marker and the truncation is reported', () => {
  const { root, dir } = runDir();
  const src = path.join(root, 'big.log');
  fs.writeFileSync(src, 'x'.repeat(5000));
  const r = saveEvidence({ runDir: dir, from: src, name: 'big.log', cap: 1000 });
  assert.equal(r.truncated, true);
  assert.equal(r.original_bytes, 5000);
  assert.ok(r.bytes <= 1000);
  assert.match(fs.readFileSync(path.join(dir, 'evidence', 'big.log'), 'utf8'), /\[spine: truncated at 1000 of 5000 bytes\]\n$/);
});

test('refuses bad names, a non-run directory and overwrites', () => {
  const { root, dir } = runDir();
  const src = path.join(root, 'a.txt');
  fs.writeFileSync(src, 'a');
  assert.throws(() => saveEvidence({ runDir: dir, from: src, name: '../x', cap: 10 }), /plain file name/);
  assert.throws(() => saveEvidence({ runDir: root, from: src, name: 'a.txt', cap: 10 }), /existing run directory/);
  saveEvidence({ runDir: dir, from: src, name: 'a.txt', cap: 10 });
  assert.throws(() => saveEvidence({ runDir: dir, from: src, name: 'a.txt', cap: 10 }), /EEXIST/);
});

test('CLI prints ok false and exits 0 on failure', () => {
  const { dir } = runDir();
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'save-evidence.js'), '--run', dir, '--from', 'missing.txt', '--name', 'x.txt'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).ok, false);
});
