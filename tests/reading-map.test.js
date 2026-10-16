'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmpDir } = require('./helpers/tmp');
const { parseDiff } = require('../scripts/lib/diff');
const { classifyTree } = require('../scripts/lib/tiers');
const { tierConfig } = require('../scripts/lib/tier-config');
const { checkProof } = require('../scripts/check-proof');
const { buildReadingMap, renderReadingMap, summarize } = require('../scripts/lib/reading-map');

const tc = tierConfig({});
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const DIFF = [
  'diff --git a/db/migrations/0002_drop.sql b/db/migrations/0002_drop.sql',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/db/migrations/0002_drop.sql',
  '@@ -0,0 +1,1 @@',
  '+DROP TABLE legacy;',
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/src/branchy.ts b/src/branchy.ts',
  '--- a/src/branchy.ts',
  '+++ b/src/branchy.ts',
  '@@ -1 +1 @@',
  '-const b = 1;',
  '+const b = 2;',
  'diff --git a/src/cited.ts b/src/cited.ts',
  '--- a/src/cited.ts',
  '+++ b/src/cited.ts',
  '@@ -1,2 +1,2 @@',
  ' const c = 1;',
  '-const d = 1;',
  '+const d = 2;',
  'diff --git a/src/leaf.ts b/src/leaf.ts',
  '--- a/src/leaf.ts',
  '+++ b/src/leaf.ts',
  '@@ -1 +1 @@',
  "-const v = 'old';",
  "+const v = 'SECRET_VALUE_42';",
  'diff --git a/src/lib/math.ts b/src/lib/math.ts',
  '--- a/src/lib/math.ts',
  '+++ b/src/lib/math.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
  '@@ -10,1 +11,1 @@',
  '-const z = 1;',
  '+const z = 2;',
].join('\n') + '\n';

const resolved = (value) => ({ value, resolved: true, rule: 'direct importers (typescript)' });
const input = (p, over = {}) => ({ path: p, status: 'modified', parser: 'typescript', text: '', hunks: [], declaredEntry: false, fanIn: resolved(0), tested: { value: true, rule: 'imported by test' }, importers: [], downstream: 0, ...over });
const REV = `${golden.inputs.head_sha}:${golden.inputs.diff_sha256}`;
const PASS = { command: 'npm test', exit_code: 0, counts: { pass: 3, fail: 0 }, status: 'ok' };
const proofRec = (id, kind, result = PASS) => ({ id, stage: 'review', agent: 'spine:proof', claim: kind, evidence: [{ kind: 'command', ref: 'x' }], confidence: 1, severity: 'INFO', proof_kind: kind, revision: REV, scope: ['*'], result });
const RECORDS = [
  proofRec('R-0001', 'test_run'),
  proofRec('R-0002', 'lint', { command: 'npm run lint', exit_code: 0, status: 'ok' }),
  proofRec('R-0003', 'integration'),
  { id: 'R-0004', stage: 'review', agent: 'spine:devils-advocate', claim: 'd is wrong', evidence: [{ kind: 'file', ref: 'src/cited.ts:2' }], confidence: 0.7, severity: 'MEDIUM', dissent: 'reverts a fix' },
  { id: 'R-0005', stage: 'review', agent: 'ecc:code-review', claim: 'z may overflow', evidence: [{ kind: 'file', ref: 'src/lib/math.ts:11' }], confidence: 0.4, severity: 'LOW' },
];

function fixture(records = RECORDS) {
  const out = classifyTree([
    input('db/migrations/0002_drop.sql', { status: 'added', parser: 'generic' }),
    input('docs/guide.md', { parser: 'none' }),
    input('src/branchy.ts', { fanIn: resolved(tc.fan_in_branch) }),
    input('src/cited.ts'),
    input('src/leaf.ts'),
    input('src/lib/math.ts', { fanIn: resolved(tc.fan_in_trunk), importers: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
  ], null, tc, () => ({ value: 0, rule: 'commits in 90 days' }));
  const tree = { schema_version: 1, tier: out.tier, inputs: golden.inputs, knobs: out.knobs, files: out.files };
  const runDir = tmpDir('spine-rm-');
  const proof = checkProof({ runDir, root: runDir, tree, records, tc, findVerify: () => [] });
  return { tree, proof, map: buildReadingMap({ diffFiles: parseDiff(DIFF), tree, records, proof, tc }) };
}
const refs = (list) => list.map((e) => e.ref);

test('every hunk lands in exactly one group and the counts add up', () => {
  const { map } = fixture();
  const g = map.groups;
  assert.equal(g.read_yourself.length + g.skim.length + g.skip.length, 7);
  assert.equal(map.totals.whole.hunks, 7);
});

test('forced read-yourself cases, deterministic ranking', () => {
  const { map } = fixture();
  assert.deepEqual(refs(map.groups.read_yourself), ['db/migrations/0002_drop.sql:1-1', 'src/cited.ts:1-2', 'src/lib/math.ts:1-2', 'src/lib/math.ts:11-11']);
  const [door, dissent, , lowConf] = map.groups.read_yourself;
  assert.deepEqual(door.reasons, ['one-way door', 'no proof', 'trunk']);
  assert.deepEqual(dissent.reasons, ['open dissent']);
  assert.deepEqual(dissent.records, ['R-0004']);
  assert.deepEqual(lowConf.reasons, ['no proof', 'trunk', 'low-confidence finding']);
});

test('entry content: importers with +N more, touches and covering evidence', () => {
  const math = fixture().map.groups.read_yourself[2];
  assert.deepEqual(math.importers, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(math.more, tc.fan_in_trunk - 3);
  assert.deepEqual(math.evidence, ['R-0001', 'R-0003']);
  const door = fixture().map.groups.read_yourself[0];
  assert.deepEqual(door.touches, ['one-way door']);
});

test('skim entries carry a reason and skip entries cite covering proof', () => {
  const { map } = fixture();
  assert.deepEqual(map.groups.skim.map((e) => [e.ref, e.reason]), [['docs/guide.md:1-1', 'docs only'], ['src/branchy.ts:1-1', `branch: fan-in ${tc.fan_in_branch} >= ${tc.fan_in_branch}`]]);
  assert.deepEqual(map.groups.skip.map((e) => [e.ref, e.evidence]), [['src/leaf.ts:1-1', ['R-0001', 'R-0003']]]);
});

test('a hollow-test flag pushes its hunk to read-yourself', () => {
  const hollow = { id: 'R-0006', stage: 'review', agent: 'spine:test-quality', claim: 'hollow test: no-assertion', evidence: [{ kind: 'file', ref: 'src/leaf.ts:1' }], confidence: 0.7, severity: 'MEDIUM' };
  const { map } = fixture([...RECORDS, hollow]);
  assert.ok(map.groups.read_yourself.some((e) => e.ref === 'src/leaf.ts:1-1' && e.reasons.includes('hollow test')));
  assert.equal(map.groups.skip.length, 0);
});

test('a hunk with neither proof nor a skim reason is promoted to read-yourself', () => {
  const extra = 'diff --git a/src/unknown.ts b/src/unknown.ts\n--- a/src/unknown.ts\n+++ b/src/unknown.ts\n@@ -1 +1 @@\n-x\n+y\n';
  const { tree, proof } = fixture();
  const map = buildReadingMap({ diffFiles: parseDiff(DIFF + extra), tree, records: RECORDS, proof, tc });
  assert.deepEqual(map.groups.read_yourself.find((e) => e.path === 'src/unknown.ts').reasons, ['no proof']);
});

test('minutes: skip is 0, read + skim never exceed whole, clamping is reported', () => {
  const t = fixture().map.totals;
  assert.equal(t.skip.minutes, 0);
  assert.ok(t.read_yourself.minutes + t.skim.minutes <= t.whole.minutes);
  assert.equal(t.whole.clamped, true);
  const slow = buildReadingMap({ diffFiles: parseDiff(DIFF), tree: fixture().tree, records: RECORDS, proof: fixture().proof, tc: tierConfig({ tiers: { reading_rates: { whole: 1 } } }) }).totals;
  assert.equal(slow.whole.clamped, false);
});

test('renamed file is one entry under the new path; empty diff gives an empty map', () => {
  const rename = 'diff --git a/lib/one.js b/lib/two.js\nsimilarity index 90%\nrename from lib/one.js\nrename to lib/two.js\n--- a/lib/one.js\n+++ b/lib/two.js\n@@ -1 +1 @@\n-a\n+b\n';
  const map = buildReadingMap({ diffFiles: parseDiff(rename), tree: null, records: [], proof: null, tc });
  const all = [...map.groups.read_yourself, ...map.groups.skim, ...map.groups.skip];
  assert.deepEqual(all.map((e) => e.path), ['lib/two.js']);
  const empty = buildReadingMap({ diffFiles: [], tree: null, records: [], proof: null, tc });
  assert.deepEqual(empty.totals.whole, { hunks: 0, lines: 0, minutes: 0, clamped: false });
});

test('the rendered map and summary hold references only, never source text', () => {
  const { map, tree } = fixture();
  const meta = { runId: '20261015-x', diffSha: crypto.createHash('sha256').update(DIFF).digest('hex'), treeSha: 'f'.repeat(64), stale: false, tier: tree.tier, verdict: 'UNPROVEN', knobs: tree.knobs, rollback: 'missing: no ## Rollback section', relPath: '.spine/20261015-x/reading-map.md' };
  const md = renderReadingMap(map, meta);
  assert.match(md, /^---\nid: 20261015-x-reading-map\ndiff_sha256: [0-9a-f]{64}\ntree_sha256: f{64}\nstale: false\n---\n/);
  assert.match(md, /## Read yourself/);
  assert.match(md, /## Confirm at G3/);
  assert.match(md, /Rollback or flag plan: missing: no ## Rollback section/);
  for (const secret of ['SECRET_VALUE_42', 'DROP TABLE legacy', 'const z = 2']) assert.ok(!md.includes(secret), secret);
  const s = summarize(map, meta);
  assert.deepEqual(s.counts, { read_yourself: 4, skim: 2, skip: 1, total: 7 });
  assert.equal(s.g3, `tier trunk · verdict UNPROVEN · read yourself 4 hunks, ${s.minutes.read_yourself} min (whole diff ${s.minutes.whole} min) · .spine/20261015-x/reading-map.md`);
  assert.ok(!JSON.stringify(s).includes('SECRET_VALUE_42'));
});
