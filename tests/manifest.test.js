const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('plugin manifest names the plugin spine', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'spine');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('package.json runs node:test over tests/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.js"');
});
