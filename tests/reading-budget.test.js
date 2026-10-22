'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers/tmp');
const { parseDiff } = require('../scripts/lib/diff');
const { classifyTree } = require('../scripts/lib/tiers');
const { tierConfig } = require('../scripts/lib/tier-config');
const { checkProof } = require('../scripts/check-proof');
const { buildReadingMap, renderReadingMap, summarize } = require('../scripts/lib/reading-map');

// A trunk file with eight 100-line hunks (5 min each at the default 20 lines/min),
// a one-way-door migration of 200 lines (10 min) and one finding on hunk 6.
const HUNK_LINES = 100;
function diff() {
  const out = ['diff --git a/src/core.ts b/src/core.ts', '--- a/src/core.ts', '+++ b/src/core.ts'];
  for (let i = 0; i < 8; i += 1) {
    out.push(`@@ -${i * 200 + 1},0 +${i * 200 + 1},${HUNK_LINES} @@`);
    for (let j = 0; j < HUNK_LINES; j += 1) out.push(`+const v${i}_${j} = ${j};`);
  }
  out.push('diff --git a/db/migrations/0003_drop.sql b/db/migrations/0003_drop.sql', 'new file mode 100644', '--- /dev/null', '+++ b/db/migrations/0003_drop.sql', '@@ -0,0 +1,200 @@');
  for (let j = 0; j < 200; j += 1) out.push(`+DROP TABLE t${j};`);
  return `${out.join('\n')}\n`;
}

const resolved = (value) => ({ value, resolved: true, rule: 'direct importers (typescript)' });
const input = (p, over = {}) => ({ path: p, status: 'modified', parser: 'typescript', text: '', hunks: [], declaredEntry: false, fanIn: resolved(0), tested: { value: true, rule: 'imported by test' }, importers: [], downstream: 0, ...over });
const FINDING = { id: 'R-0001', stage: 'review', agent: 'ecc:code-review', claim: 'cache never repaired', evidence: [{ kind: 'file', ref: 'src/core.ts:1201' }], confidence: 0.9, severity: 'MEDIUM' };

function build(config = {}) {
  const tc = tierConfig(config);
  const out = classifyTree([
    input('src/core.ts', { fanIn: resolved(tc.fan_in_trunk) }),
    input('db/migrations/0003_drop.sql', { status: 'added', parser: 'generic' }),
  ], null, tc, () => ({ value: 0, rule: 'commits in 90 days' }));
  const tree = { schema_version: 1, tier: out.tier, inputs: { head_sha: 'a'.repeat(40), diff_sha256: 'b'.repeat(64) }, knobs: out.knobs, files: out.files };
  const runDir = tmpDir('spine-budget-');
  const proof = checkProof({ runDir, root: runDir, tree, records: [FINDING], tc, findVerify: () => [] });
  return buildReadingMap({ diffFiles: parseDiff(diff()), tree, records: [FINDING], proof, tc });
}

test('read-yourself stops at the reading budget; the rest is listed as read-if-time in risk order', () => {
  const map = build();
  const read = map.groups.read_yourself.map((e) => e.ref);
  assert.equal(read[0], 'db/migrations/0003_drop.sql:1-200', 'one-way door first');
  assert.equal(read[1], 'src/core.ts:1201-1300', 'the hunk a finding cites comes next');
  assert.ok(map.totals.read_yourself.minutes <= 20, `read yourself is ${map.totals.read_yourself.minutes} min`);
  assert.equal(map.groups.read_if_time.length, 6);
  assert.equal(map.totals.read_if_time.minutes, 30);
  assert.ok(map.groups.read_yourself.find((e) => e.ref === 'src/core.ts:1201-1300').reasons.includes('finding'));
});

test('a one-way door or open dissent is never moved out of read-yourself, even over budget', () => {
  const map = build({ tiers: { read_budget_minutes: 1 } });
  assert.deepEqual(map.groups.read_yourself.map((e) => e.ref), ['db/migrations/0003_drop.sql:1-200']);
  assert.equal(map.groups.read_if_time.length, 8);
});

test('a large budget keeps everything in read-yourself', () => {
  const map = build({ tiers: { read_budget_minutes: 500 } });
  assert.equal(map.groups.read_if_time.length, 0);
});

test('the G3 line and the reading map show the read-if-time remainder', () => {
  const map = build();
  const meta = { runId: 'x', diffSha: 'd', treeSha: 't', stale: false, tier: 'trunk', verdict: 'UNPROVEN', knobs: {}, rollback: 'n/a', relPath: '.spine/x/reading-map.md' };
  const s = summarize(map, meta);
  assert.match(s.g3, /read yourself \d+ hunks, \d+ min, then 6 more hunks, 30 min if you have time \(whole diff \d+ min\)/);
  assert.equal(s.counts.read_if_time, 6);
  assert.match(renderReadingMap(map, meta), /## Read if you have time\n\n1\. `src\/core\.ts:/);
});

test('a hunk cited by an open CRITICAL or HIGH finding is never moved out of read-yourself', () => {
  const tc = tierConfig({ tiers: { read_budget_minutes: 1 } });
  const out = classifyTree([input('src/core.ts', { fanIn: resolved(tc.fan_in_trunk) })], null, tc, () => ({ value: 0, rule: 'commits in 90 days' }));
  const tree = { schema_version: 1, tier: out.tier, inputs: { head_sha: 'a'.repeat(40), diff_sha256: 'b'.repeat(64) }, knobs: out.knobs, files: out.files };
  const high = { ...FINDING, severity: 'HIGH', evidence: [{ kind: 'file', ref: 'src/core.ts:1401' }] };
  const high2 = { ...FINDING, id: 'R-0002', severity: 'CRITICAL', evidence: [{ kind: 'file', ref: 'src/core.ts:201' }] };
  const runDir = tmpDir('spine-budget-');
  const proof = checkProof({ runDir, root: runDir, tree, records: [high, high2], tc, findVerify: () => [] });
  const map = buildReadingMap({ diffFiles: parseDiff(diff()).filter((f) => f.path === 'src/core.ts'), tree, records: [high, high2], proof, tc });
  assert.deepEqual(map.groups.read_yourself.map((e) => e.ref).sort(), ['src/core.ts:1401-1500', 'src/core.ts:201-300'], 'both CRITICAL/HIGH-cited hunks stay, nothing else');
});
