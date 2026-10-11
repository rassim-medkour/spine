// tests/claude-baseline.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'fixtures', 'claude-baseline.json');
const PRE_CURSOR_TESTS = [
  'agents', 'churn', 'classify', 'command', 'docs', 'find-verify', 'hook-io', 'hooks-json', 'manifest',
  'providers', 'release', 'session-start', 'skills', 'state', 'stop-gate', 'subagent-gate',
  'validate-artifact-hook', 'validate', 'workflows-smoke', 'workflows',
].map((n) => `tests/${n}.test.js`);

function digest(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

test('baseline protects every pre-Cursor test file', () => {
  for (const rel of PRE_CURSOR_TESTS) assert.ok(rel in baseline.files, `${rel} missing from claude-baseline.json`);
});

for (const [rel, hash] of Object.entries(baseline.files)) {
  test(`Claude-side file unchanged: ${rel}`, () => {
    assert.equal(digest(rel), hash, `${rel} changed. An intended Claude-side change must update tests/fixtures/claude-baseline.json in the same commit and say [claude-code] in the CHANGELOG.`);
  });
}
