'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeMix, mixLine } = require('../scripts/lib/model-mix');
const { buildPrBody } = require('../scripts/lib/pr-body');
const { runStatus } = require('../scripts/run-status');
const { parseDiff } = require('../scripts/lib/diff');
const { tmpDir } = require('./helpers/tmp');

const rec = (model, extra = {}) => ({ id: 'R-1', stage: 'review', agent: 'a', claim: 'c', evidence: [{ kind: 'file', ref: 'a:1' }], confidence: 1, severity: 'LOW', ...(model === undefined ? {} : { model }), ...extra });
const blk = (cls, id, source = 'requested') => ({ role: 'finder', tier: 'trunk', tier_source: 'tree', class: cls, requested: id, source });

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const DIFF = 'diff --git a/src/lib/math.ts b/src/lib/math.ts\n--- a/src/lib/math.ts\n+++ b/src/lib/math.ts\n@@ -1 +1,2 @@\n const a = 1;\n+export const b = 2;\n';
const WRITTEN = '## TL;DR\n\nAdds subtraction.\n\n## The problem, with an example\n\nBefore: x.\nAfter: y.\n\n## The design decision that shaped everything\n\nKeep math pure.\n\n';
const prData = (records) => ({
  tier: 'branch',
  runRel: '.spine/20261015-pr',
  diffFiles: parseDiff(DIFF),
  tree: { ...golden, tier: 'branch' },
  review: { verdict: 'PASS', tier: 'branch', providers: ['ecc:code-review'], findings: [] },
  records,
  proof: { present: [], missing: [], info: [] },
  readingMap: { totals: { read_yourself: { hunks: 1, minutes: 1 }, whole: { minutes: 1 } }, groups: { read_yourself: [] } },
  planText: '## Rollback\n\nRun `git revert HEAD`.\n',
  specAssumptions: [],
});
const norm = (s) => s.replace(/\r\n/g, '\n');

test('no model fields: mix is null and pr-body is unchanged (REQ-37)', () => {
  assert.equal(computeMix([rec(undefined)]), null);
  const body = buildPrBody(prData([rec(undefined)]), WRITTEN).body;
  assert.doesNotMatch(norm(body), /Models \(requested\)/);
});

test('counts equal dispatched-agent blocks, per class and per model (REQ-37)', () => {
  const mix = computeMix([
    rec(blk('top', 'opus'), { verifier_model: blk('top', 'opus', 'floor-raised') }),
    rec(blk('mid', 'sonnet')),
    rec(blk('inherit', null, 'inherit')),
    rec(blk('mid', 'sonnet', 'session-fallback'), { claim: 'agent did not run: find:x', severity: 'INFO' }),
    rec(blk(null, null, 'fallback-error')),
  ]);
  assert.equal(mix.agents, 6);
  assert.deepEqual(mix.by_class, { cheap: 0, mid: 1, top: 2, pinned: 0 });
  assert.deepEqual(mix.by_model, { opus: 2, sonnet: 1 });
  assert.equal(mix.session, 2);
  assert.equal(mix.fallback_error, 1);
  assert.equal(mix.unsupported, 0);
  assert.equal(mix.did_not_run, 1);
});

test('hostile ids never reach the line (REQ-38)', () => {
  const mix = computeMix([rec(blk('top', '[x](http://evil)')), rec(blk('top', '<img src=x>')), rec(blk('top', 'a`b'))]);
  assert.equal(mix.invalid_ids, 3);
  const line = mixLine(mix);
  assert.doesNotMatch(line, /evil|<img|a`b/);
  assert.match(line, /3 top/);
});

test('the line says requested, never ran (REQ-33)', () => {
  const line = mixLine(computeMix([rec(blk('top', 'opus'), { verifier_model: blk('mid', 'sonnet') })]));
  assert.match(line, /^Models \(requested\): 1 top, 1 mid · `opus` 1, `sonnet` 1 · session 0 · fallback-error 0 · unsupported 0 · did not run 0$/);
  assert.equal(mixLine(null), null);
});

test('pr-body How it was checked shows the mix line when records carry models', () => {
  const out = buildPrBody(prData([rec(blk('top', 'opus'))]), WRITTEN);
  assert.match(norm(out.body), /- Models \(requested\): 1 top · `opus` 1 · session 0/);
  const plain = buildPrBody(prData([rec(undefined)]), WRITTEN).body;
  assert.ok(norm(out.body).split('\n').length === norm(plain).split('\n').length + 1);
});

test('run-status adds model_mix only when records carry models', (t) => {
  const dir = tmpDir('spine-mix-', t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ host: 'claude-code' }));
  assert.equal('model_mix' in runStatus(dir), false);
  fs.mkdirSync(path.join(dir, 'records'));
  fs.writeFileSync(path.join(dir, 'records', 'R-0001.json'), JSON.stringify(rec(blk('top', 'opus'))));
  const s = runStatus(dir);
  assert.equal(s.model_mix.by_class.top, 1);
  assert.match(s.model_mix.line, /^Models \(requested\): 1 top/);
});
