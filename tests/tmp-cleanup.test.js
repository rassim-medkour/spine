'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs a node command with TMP/TEMP/TMPDIR pointed at a private dir so the
// count is not disturbed by test files running in parallel.
function runInPrivateTmp(args) {
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined, TMP: priv, TEMP: priv, TMPDIR: priv };
    const r = spawnSync(process.execPath, args, { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    const left = fs.readdirSync(priv).filter((n) => n.startsWith('spine'));
    return { r, left };
  } finally {
    fs.rmSync(priv, { recursive: true, force: true });
  }
}

test('tmpDir creates a spine-prefixed dir and removes it when the process ends', () => {
  const code = `
    const { tmpDir } = require('./tests/helpers/tmp');
    const fs = require('node:fs');
    const d = tmpDir('spine-helper-');
    fs.writeFileSync(d + '/x', 'x');
    console.log(d);
  `;
  const { r, left } = runInPrivateTmp(['-e', code]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(path.basename(r.stdout.trim()).startsWith('spine-helper-'));
  assert.deepEqual(left, []);
});

test('tmpDir with a test context removes the dir after that test', () => {
  const code = `
    const test = require('node:test');
    const fs = require('node:fs');
    const { tmpDir } = require('./tests/helpers/tmp');
    let made;
    test('a', (t) => { made = tmpDir('spine-ctx-', t); });
    test('b', () => { if (fs.existsSync(made)) throw new Error('still there'); });
  `;
  const { r, left } = runInPrivateTmp(['--test-concurrency=1', '-e', code]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(left, []);
});

const SAMPLE = [
  'tests/gate.test.js',
  'tests/hook-io-bom.test.js',
  'tests/claude-stdin.test.js',
  'tests/cursor-io.test.js',
  'tests/write-record.test.js',
  'tests/tree-contract.test.js',
];

test('a sample of hook tests leaves no spine-* temp dirs behind', () => {
  for (const file of SAMPLE) {
    const { r, left } = runInPrivateTmp(['--test', file]);
    assert.equal(r.status, 0, `${file}\n${r.stdout}${r.stderr}`);
    assert.deepEqual(left, [], `${file} leaked temp dirs`);
  }
});
