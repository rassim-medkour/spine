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
