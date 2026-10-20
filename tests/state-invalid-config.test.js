'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, loadConfigLayers } = require('../scripts/lib/state');

const { tmpDir } = require('./helpers/tmp');
const tmp = () => tmpDir('spine-cfg-');

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

test('an existing config file that is not valid JSON prints one spine: line naming the file, never its content', () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.spine'));
  const file = path.join(home, '.spine', 'config.json');
  fs.writeFileSync(file, '{ "secret_token": nope');
  const lines = captureStderr(() => {
    assert.equal(loadConfig(cwd, home).strictness, 'block');
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^spine: /);
  assert.ok(lines[0].includes(file));
  assert.ok(!lines[0].includes('secret_token'));
  assert.ok(lines[0].endsWith('\n'));
});

test('a missing config file and a valid one print nothing; loadConfigLayers warns for a bad repo file', () => {
  const cwd = tmp();
  const home = tmp();
  assert.deepEqual(captureStderr(() => loadConfig(cwd, home)), []);
  fs.mkdirSync(path.join(cwd, '.spine'));
  fs.writeFileSync(path.join(cwd, '.spine', 'config.json'), '{"lens_budget": 2}');
  assert.deepEqual(captureStderr(() => loadConfigLayers(cwd, home)), []);
  fs.writeFileSync(path.join(cwd, '.spine', 'config.json'), 'oops');
  const lines = captureStderr(() => assert.deepEqual(loadConfigLayers(cwd, home).repo, {}));
  assert.equal(lines.length, 1);
});
