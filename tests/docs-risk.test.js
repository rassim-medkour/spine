'use strict';
// README checks for the risk-tier feature. Kept apart from docs.test.js, whose hash is pinned in claude-baseline.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('README documents the tree.json contract field by field', () => {
  const text = read('README.md');
  const start = text.indexOf('<!-- tree-contract:start -->');
  const end = text.indexOf('<!-- tree-contract:end -->');
  assert.ok(start >= 0 && end > start, 'README needs the tree-contract markers');
  const block = text.slice(start, end);
  const schema = JSON.parse(read('schemas/tree.json'));
  const keys = [...schema.required, ...schema.inputs, ...schema.signals, ...schema.knobs, ...schema.consumer_fields, ...schema.arrays.files.required];
  for (const key of keys) assert.ok(block.includes(`\`${key}\``), `README tree contract is missing ${key}`);
});

test('README lists UNPROVEN, the kill switch, shadow mode and gitignore guidance', () => {
  const text = read('README.md');
  for (const needle of ['`UNPROVEN`', '"risk_tiers": false', '"unproven_blocks": true', '.spine/*/diff.patch', '.spine/*/evidence/', '.spine/cache/', 'scripts/tree.js', 'scripts/check-proof.js', 'scripts/verdict.js', 'scripts/reading-map.js', 'scripts/pr-body.js']) {
    assert.ok(text.includes(needle), `README is missing ${needle}`);
  }
});
