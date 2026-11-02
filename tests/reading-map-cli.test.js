'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const DIFF = 'diff --git a/src/lib/math.ts b/src/lib/math.ts\n--- a/src/lib/math.ts\n+++ b/src/lib/math.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2; // SECRET_VALUE_42\n';

function runDir({ diff = DIFF, tree = true } = {}) {
  const root = tmpDir('spine-rmcli-');
  const dir = path.join(root, '.spine', '20261015-rm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  if (diff !== null) fs.writeFileSync(path.join(dir, 'diff.patch'), diff);
  if (tree) {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
    const t = { ...golden, inputs: { ...golden.inputs, diff_sha256: crypto.createHash('sha256').update(diff || '').digest('hex') } };
    fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(t));
  }
  return { root, dir };
}
const cli = (r) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reading-map.js'), '--run', r.dir], { cwd: r.root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.root }) });

test('writes reading-map.md and reading-map.json and prints the G3 summary', () => {
  const r = runDir();
  const out = cli(r);
  assert.equal(out.status, 0, out.stderr);
  const s = JSON.parse(out.stdout);
  assert.equal(s.ok, true);
  assert.equal(s.stale, false);
  assert.deepEqual(s.counts, { read_yourself: 1, skim: 0, skip: 0, total: 1 });
  assert.match(s.g3, /^tier trunk · verdict pending · read yourself 1 hunks, \d+ min \(whole diff \d+ min\) · \.spine\/20261015-rm\/reading-map\.md$/);
  const md = fs.readFileSync(path.join(r.dir, 'reading-map.md'), 'utf8');
  const json = fs.readFileSync(path.join(r.dir, 'reading-map.json'), 'utf8');
  for (const text of [md, json, out.stdout]) assert.ok(!text.includes('SECRET_VALUE_42'));
  assert.match(md, /`src\/lib\/math\.ts:1-1`/);
});

test('a diff changed after tree.json is flagged stale', () => {
  const r = runDir();
  fs.appendFileSync(path.join(r.dir, 'diff.patch'), ' ');
  const s = JSON.parse(cli(r).stdout);
  assert.equal(s.stale, true);
  assert.match(fs.readFileSync(path.join(r.dir, 'reading-map.md'), 'utf8'), /^---[\s\S]*stale: true[\s\S]*STALE: the diff changed/);
});

test('no tree.json is skipped; a missing diff.patch is ok false with exit 0', () => {
  assert.deepEqual(JSON.parse(cli(runDir({ tree: false })).stdout), { ok: true, skipped: 'no tree.json' });
  const missing = cli(runDir({ diff: null }));
  assert.equal(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});

const PRODUCT_MD = ['## Users', 'a', '## Goals', 'b', '## Glossary', 'c', '## Invariants', 'd', '## Key flows', '', '### Math', 'weight: critical', 'paths: src/lib/**', '1. Open the calculator', '2. Add two numbers', '', '## UX principles', 'e', ''].join('\n');

test('a touched key flow adds Click through yourself with steps from product.md and the G3 suffix', () => {
  const r = runDir();
  fs.writeFileSync(path.join(r.dir, 'product.json'), JSON.stringify({ state: 'ok', flows_touched: [{ name: 'Math', weight: 'critical', files: ['src/lib/math.ts'] }] }));
  fs.mkdirSync(path.join(r.root, '.spine'), { recursive: true });
  fs.writeFileSync(path.join(r.root, '.spine', 'product.md'), PRODUCT_MD);
  const s = JSON.parse(cli(r).stdout);
  assert.match(s.g3, / · click through 1 flows, 3 min$/);
  const md = fs.readFileSync(path.join(r.dir, 'reading-map.md'), 'utf8');
  assert.match(md, /## Click through yourself\n\n1\. \*\*Math\*\* \(critical\) · not driven\n   1\. Open the calculator\n   2\. Add two numbers\n/);
  const json = JSON.parse(fs.readFileSync(path.join(r.dir, 'reading-map.json'), 'utf8'));
  assert.deepEqual(json.totals.click_through, { flows: 1, minutes: 3 });
});

test('product.json with no touched flows, or unreadable, leaves the output as without it', () => {
  const base = runDir();
  const want = cli(base).stdout.replace(/\.spine\/[^ ]+/, '');
  for (const body of ['{"state":"ok","flows_touched":[]}', '{"state":"absent"}', 'not json']) {
    const r = runDir();
    fs.writeFileSync(path.join(r.dir, 'product.json'), body);
    assert.equal(cli(r).stdout.replace(/\.spine\/[^ ]+/, ''), want);
    assert.ok(!fs.readFileSync(path.join(r.dir, 'reading-map.md'), 'utf8').includes('Click through'));
  }
});

test('touched flows with an unreadable or missing product.md keep the group with steps unavailable (R-0158)', () => {
  for (const setup of [(r) => {}, (r) => { fs.mkdirSync(path.join(r.root, '.spine'), { recursive: true }); fs.writeFileSync(path.join(r.root, '.spine', 'product.md'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28])); }]) {
    const r = runDir();
    fs.writeFileSync(path.join(r.dir, 'product.json'), JSON.stringify({ state: 'ok', flows_touched: [{ name: 'Math', weight: 'critical', files: ['src/lib/math.ts'] }] }));
    setup(r);
    const s = JSON.parse(cli(r).stdout);
    assert.match(s.g3, / · click through 1 flows, 3 min$/);
    assert.match(fs.readFileSync(path.join(r.dir, 'reading-map.md'), 'utf8'), /## Click through yourself\n\n1\. \*\*Math\*\* \(critical\) · not driven\n   steps unavailable\n/);
  }
});
