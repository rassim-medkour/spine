'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('README documents the kill switch, the plan location and rollback (REQ-50)', () => {
  const t = read('README.md');
  for (const n of ['## Model routing', '"model_policy": "inherit"', '<run>/models.json', 'rolls back to 0.3.0 dispatch', 'Balanced', 'verifier floor', 'model_ids', 'cursor_discovery']) assert.ok(t.includes(n), n);
});

test('README Cursor section mentions model discovery without the word tier', () => {
  const t = read('README.md');
  const start = t.indexOf('\n## Cursor (experimental)\n');
  const rest = t.slice(start + 1);
  const section = rest.slice(0, rest.slice(3).search(/\n## /) + 3);
  assert.match(section, /local app state/);
  assert.doesNotMatch(section, /\btiers?\b/i);
});

test('the 0.3.0 CHANGELOG entry lists model routing as a behaviour change', () => {
  const entry = read('CHANGELOG.md').split(/\r?\n## /).find((e) => e.startsWith('0.3.0'));
  assert.ok(entry, 'CHANGELOG has a 0.3.0 entry');
  assert.match(entry, /^0\.3\.0/);
  assert.match(entry, /### Changed[\s\S]*model routing[\s\S]*behaviour change/i);
  assert.match(entry, /model_policy.*inherit/);
  assert.match(entry, /\[claude-code\][^\n]*workflows/);
  for (const line of entry.split('\n').filter((l) => l.startsWith('- '))) assert.match(line, /^- \[(claude-code|cursor|both)\]/, line);
});

test('README has ## Product context and names decisions.md, key flow and click-through (T-13)', () => {
  const t = read('README.md');
  assert.match(t, /^## Product context$/m);
  const section = t.slice(t.indexOf('\n## Product context\n'));
  for (const n of ['.spine/product.md', '.spine/decisions.md', 'key flow', 'click-through', 'critical', 'important', 'minor', 'product_context_max_lines', 'citation', '/spine:spine product', 'byte-identical']) assert.ok(section.includes(n), n);
});

test('the 0.4.0 CHANGELOG entry lists both new roles and the policy hash change (T-13)', () => {
  const entry = read('CHANGELOG.md').split(/\r?\n## /).find((e) => e.startsWith('0.4.0'));
  assert.ok(entry);
  assert.match(entry, /### Added/);
  assert.match(entry, /### Changed/);
  assert.match(entry, /product_lens/);
  assert.match(entry, /ux_finder/);
  assert.match(entry, /policy hash/);
  assert.equal(read('CHANGELOG.md').split(/\r?\n/).filter((l) => l === '## 0.4.0').length, 1);
  assert.match(entry, /\.spine\/product\.md/);
  assert.match(entry, /decisions\.md/);
  for (const line of entry.split('\n').filter((l) => l.startsWith('- '))) assert.match(line, /^- \[(claude-code|cursor|both)\]/, line);
});
