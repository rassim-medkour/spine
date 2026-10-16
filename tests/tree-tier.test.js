'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyTree, KNOB_KEYS, SIGNAL_KEYS } = require('../scripts/lib/tiers');
const { tierConfig } = require('../scripts/lib/tier-config');
const { classify } = require('../scripts/classify');
const { validateTree } = require('../scripts/lib/validate');

const tc = tierConfig({});
const resolved = (value) => ({ value, resolved: true, rule: 'direct importers (typescript)' });
const hunk = (...added) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, added: added.map((text, i) => ({ line: i + 1, text })), removed: [] });

function file(over = {}) {
  return {
    path: 'src/a.ts', status: 'modified', parser: 'typescript', text: '', hunks: [], declaredEntry: false,
    fanIn: resolved(0), tested: { value: true, rule: 'imported by test' }, importers: [], downstream: 0,
    ...over,
  };
}
const churn0 = () => ({ value: 0, rule: 'commits in 90 days' });
const run = (files, cfg = tc, churn = churn0) => classifyTree(files, null, cfg, churn);
const tierOf = (over, cfg) => run([file(over)], cfg).files[0];

test('fan-in boundary rows around both thresholds', () => {
  const rows = [
    [tc.fan_in_branch - 1, 'leaf'],
    [tc.fan_in_branch, 'branch'],
    [tc.fan_in_branch + 1, tc.fan_in_branch + 1 >= tc.fan_in_trunk ? 'trunk' : 'branch'],
    [tc.fan_in_trunk - 1, 'branch'],
    [tc.fan_in_trunk, 'trunk'],
    [tc.fan_in_trunk + 1, 'trunk'],
  ];
  for (const [n, expected] of rows) assert.equal(tierOf({ fanIn: resolved(n) }).tier, expected, `fan-in ${n}`);
});

test('one row per signal that forces a tier on its own', () => {
  const forced = (key) => (tc.trunk_signals.includes(key) ? 'trunk' : 'branch');
  assert.equal(tierOf({ path: 'src/server.ts' }).tier, forced('entry_point'));
  assert.equal(tierOf({ path: 'db/migrations/0001_init.sql', parser: 'generic' }).tier, forced('one_way_door'));
  assert.equal(tierOf({ path: 'src/config.ts' }).tier, forced('shared_state'));
  assert.equal(tierOf({ path: 'src/api/routes.ts' }).tier, forced('public_interface'));
  assert.equal(tierOf({ path: 'src/auth/session.ts' }).tier, forced('security_path'));
});

test('critical_paths forces trunk and names the glob', () => {
  const f = tierOf({ path: 'src/pay/x.ts' }, tierConfig({ critical_paths: ['src/pay/**'] }));
  assert.equal(f.tier, 'trunk');
  assert.equal(f.reasons[0], 'critical_paths override: src/pay/**');
});

test('unknown fan-in is never leaf, even when gated', () => {
  const unknown = { value: null, resolved: false, rule: 'fan-in unknown: binary file' };
  assert.equal(tierOf({ fanIn: unknown }).tier, 'branch');
  assert.ok(tierOf({ fanIn: unknown }).reasons.includes('fan-in unknown: binary file'));
  assert.equal(tierOf({ fanIn: unknown, hunks: [hunk("if (isEnabled('x')) {")] }).tier, 'branch');
});

test('an unparseable file in an otherwise leaf change gives branch', () => {
  const out = run([file({ path: 'src/a.ts' }), file({ path: 'src/b.bin', parser: 'none', fanIn: { value: null, resolved: false, rule: 'fan-in unknown: binary file' } })]);
  assert.equal(out.tier, 'branch');
});

test('gating lowers branch to leaf only', () => {
  const gated = [hunk("if (isEnabled('x')) {")];
  const b = tierOf({ fanIn: resolved(tc.fan_in_branch), hunks: gated });
  assert.equal(b.tier, 'leaf');
  assert.equal(b.reasons[b.reasons.length - 1], 'gated: lowered branch to leaf');
  assert.equal(tierOf({ fanIn: resolved(tc.fan_in_trunk), hunks: gated }).tier, 'trunk');
  assert.equal(tierOf({ path: 'db/migrations/0002.sql', parser: 'generic', hunks: gated }).tier, 'trunk');
  assert.equal(tierOf({ path: 'src/auth/x.ts', hunks: gated }).tier, tc.trunk_signals.includes('security_path') ? 'trunk' : 'branch');
});

test('docs are leaf; untested source is branch; untested data files are not', () => {
  assert.deepEqual(tierOf({ path: 'docs/guide.md', parser: 'none' }).reasons, ['docs only']);
  assert.equal(tierOf({ tested: { value: false, rule: 'no test file imports it (heuristic)' } }).tier, 'branch');
  assert.equal(tierOf({ path: 'data/x.json', parser: 'none', tested: { value: false, rule: 'x' } }).tier, 'leaf');
});

test('high churn raises to branch', () => {
  assert.equal(run([file()], tc, () => ({ value: tc.churn_branch, rule: 'commits in 90 days' })).files[0].tier, 'branch');
});

test('change tier is the highest file tier and is independent of size', () => {
  const trunkOneLine = run([file({ fanIn: resolved(tc.fan_in_trunk) })]);
  assert.equal(trunkOneLine.tier, 'trunk');
  assert.equal(classify({ files: ['src/a.ts'] }, { lens_budget: 6, critical_paths: [] }, () => 0).size, 'S');
  const paths = Array.from({ length: 13 }, (_, i) => `src/leaf${String(i).padStart(2, '0')}.ts`);
  const leafWide = run(paths.map((p) => file({ path: p })));
  assert.equal(leafWide.tier, 'leaf');
  assert.equal(classify({ files: paths }, { lens_budget: 6, critical_paths: [] }, () => 0).size, 'L');
});

test('every file has a tier, non-empty reasons and all nine signals', () => {
  const out = run([file(), file({ path: 'src/b.ts', fanIn: resolved(tc.fan_in_trunk) })]);
  for (const f of out.files) {
    assert.ok(['leaf', 'branch', 'trunk'].includes(f.tier));
    assert.ok(f.reasons.length > 0);
    assert.deepEqual(Object.keys(f.signals), SIGNAL_KEYS);
  }
});

test('review knobs are answered with evidence', () => {
  const out = run([
    file({ path: 'db/migrations/0003.sql', parser: 'generic' }),
    file({ path: 'src/b.ts', fanIn: resolved(tc.fan_in_trunk), downstream: tc.fan_in_trunk }),
  ]);
  assert.deepEqual(Object.keys(out.knobs), KNOB_KEYS);
  for (const k of KNOB_KEYS) {
    assert.ok(['yes', 'no', 'unknown'].includes(out.knobs[k].answer), k);
    assert.ok(out.knobs[k].evidence.length > 0, k);
    assert.ok(out.knobs[k].evidence.every((e) => /^signal:|^R-\d+$|\//.test(e) || out.files.some((f) => f.path === e)), k);
  }
  assert.equal(out.knobs.is_trunk.answer, 'yes');
  assert.equal(out.knobs.wide_downstream.answer, 'yes');
  assert.equal(out.knobs.instant_rollback.answer, 'no');
  const allGated = run([file({ hunks: [hunk("if (isEnabled('x')) {")] })]);
  assert.equal(allGated.knobs.gated.answer, 'yes');
  assert.equal(allGated.knobs.instant_rollback.answer, 'yes');
});

test('a tree assembled from classifyTree validates against schemas/tree.json', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
  const out = run([file(), file({ path: 'README.md', parser: 'none' })]);
  assert.deepEqual(validateTree({ schema_version: 1, tier: out.tier, inputs: golden.inputs, knobs: out.knobs, files: out.files }), []);
});

test('partial fan-in applies the thresholds to the known lower bound, branch as floor', () => {
  const partial = (value) => ({ value, resolved: false, rule: 'fan-in partial: unresolved import in x.ts' });
  assert.equal(tierOf({ fanIn: partial(tc.fan_in_trunk) }).tier, 'trunk');
  assert.equal(tierOf({ fanIn: partial(tc.fan_in_trunk + 5) }).tier, 'trunk');
  assert.equal(tierOf({ fanIn: partial(0) }).tier, 'branch');
  assert.equal(tierOf({ fanIn: partial(1) }).tier, 'branch');
  assert.equal(tierOf({ fanIn: partial(tc.fan_in_branch) }).tier, 'branch');
});
