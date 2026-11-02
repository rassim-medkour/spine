'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

// Click through yourself (T-11). The snapshot was produced by the 0.3.2 code on this same input.
const SNAPSHOT = fs.readFileSync(path.join(__dirname, 'fixtures', 'reading-map-0.3.2.md'), 'utf8');
const META = { runId: 'x', diffSha: 'd', treeSha: 't', stale: false, tier: 'trunk', verdict: 'UNPROVEN', knobs: {}, rollback: 'n/a', relPath: '.spine/x/reading-map.md' };
const render = (map) => `${renderReadingMap(map, META)}\n--- g3 ---\n${summarize(map, META).g3}\n`;
const FLOWS = [
  { name: 'Checkout', weight: 'critical', steps: ['Add an item', 'Pay with a card', 'See the receipt'] },
  { name: 'Refund', weight: 'important', steps: ['Open an order', 'Press refund'] },
];
test('click-through: no product, empty product and zero flows are byte-equal to the 0.3.2 snapshot', () => {
  assert.equal(render(build()), SNAPSHOT);
  for (const product of [null, undefined, {}, { flows_touched: [] }]) {
    const map = buildReadingMap({ ...mapInput(), product });
    assert.equal(map.groups.click_through, undefined);
    assert.equal(map.totals.click_through, undefined);
    assert.equal(render(map), SNAPSHOT);
  }
});

function mapInput(config = {}, records = [FINDING]) {
  const tc = tierConfig(config);
  const out = classifyTree([
    input('src/core.ts', { fanIn: resolved(tc.fan_in_trunk) }),
    input('db/migrations/0003_drop.sql', { status: 'added', parser: 'generic' }),
  ], null, tc, () => ({ value: 0, rule: 'commits in 90 days' }));
  const tree = { schema_version: 1, tier: out.tier, inputs: { head_sha: 'a'.repeat(40), diff_sha256: 'b'.repeat(64) }, knobs: out.knobs, files: out.files };
  const runDir = tmpDir('spine-budget-');
  const proof = checkProof({ runDir, root: runDir, tree, records, tc, findVerify: () => [] });
  return { diffFiles: parseDiff(diff()), tree, records, proof, tc };
}

test('click-through: two flows add the group, 6 minutes and the G3 suffix after Read yourself', () => {
  const map = buildReadingMap({ ...mapInput(), product: { flows_touched: FLOWS } });
  assert.deepEqual(map.totals.click_through, { flows: 2, minutes: 6 });
  assert.equal(map.groups.click_through.length, 2);
  assert.deepEqual(map.groups.click_through[0], { name: 'Checkout', weight: 'critical', steps: FLOWS[0].steps, evidence: null });
  const md = renderReadingMap(map, META);
  assert.match(md, /## Click through yourself\n\n1\. \*\*Checkout\*\* \(critical\) · not driven\n   1\. Add an item\n   2\. Pay with a card\n   3\. See the receipt\n2\. \*\*Refund\*\* \(important\) · not driven\n   1\. Open an order\n   2\. Press refund\n/);
  assert.ok(md.indexOf('## Click through yourself') > md.indexOf('## Read yourself'));
  assert.ok(md.indexOf('## Click through yourself') < md.indexOf('## Skim'));
  assert.match(summarize(map, META).g3, /\(whole diff \d+ min\) · \.spine\/x\/reading-map\.md · click through 2 flows, 6 min$/);
});

test('click-through: a live-verification record naming the flow shows its id, otherwise not driven', () => {
  const live = { id: 'R-0042', stage: 'review', agent: 'spine:live-verify', claim: 'driven: checkout works end to end', evidence: [{ kind: 'command', ref: 'x' }], confidence: 0.9, severity: 'INFO', revision: 'rev1', payloads: [{ path: 'e.png' }] };
  const noRevision = { ...live, id: 'R-0043', claim: 'refund done', revision: undefined, payloads: undefined };
  const evNote = { ...live, id: 'R-0044', claim: 'ran it', evidence: [{ kind: 'doc', ref: 'e.md', note: 'flow REFUND clicked' }] };
  const one = buildReadingMap({ ...mapInput({}, [FINDING, live, noRevision]), product: { flows_touched: FLOWS } });
  assert.deepEqual(one.groups.click_through.map((e) => e.evidence), ['R-0042', null]);
  const both = buildReadingMap({ ...mapInput({}, [FINDING, live, evNote]), product: { flows_touched: FLOWS } });
  assert.deepEqual(both.groups.click_through.map((e) => e.evidence), ['R-0042', 'R-0044']);
  assert.match(renderReadingMap(both, META), /\*\*Checkout\*\* \(critical\) · R-0042\n/);
});

test('click-through: tiers.click_through_minutes changes the minutes', () => {
  const map = buildReadingMap({ ...mapInput({ tiers: { click_through_minutes: 5 } }), product: { flows_touched: FLOWS } });
  assert.deepEqual(map.totals.click_through, { flows: 2, minutes: 10 });
  assert.match(summarize(map, META).g3, /click through 2 flows, 10 min$/);
});

test('click-through: only live-verification records drive a flow, matched on whole words (R-0154, R-0159)', () => {
  const base = { id: 'R-0050', stage: 'review', agent: 'spine:live-verify', claim: 'driven: refund works', evidence: [{ kind: 'command', ref: 'x' }], confidence: 0.9, severity: 'INFO', revision: 'rev1', payloads: [{ path: 'e.png' }] };
  const drive = (rec, flows = FLOWS) => buildReadingMap({ ...mapInput({}, [FINDING, rec]), product: { flows_touched: flows } }).groups.click_through.map((e) => e.evidence);
  assert.deepEqual(drive(base), [null, 'R-0050']);
  assert.deepEqual(drive({ ...base, agent: 'spine:regression', proof_kind: 'regression' }), [null, null], 'a regression proof record does not drive');
  assert.deepEqual(drive({ ...base, agent: 'spine:other' }), [null, null], 'agent and proof_kind both wrong');
  assert.deepEqual(drive({ ...base, agent: 'spine:other', proof_kind: 'live_verify' }), [null, 'R-0050'], 'proof_kind live_verify drives');
  assert.deepEqual(drive({ ...base, severity: 'MEDIUM' }), [null, null], 'only INFO records drive');
  const pay = [{ name: 'Pay', weight: 'critical', steps: ['a'] }];
  assert.deepEqual(drive({ ...base, claim: 'the payment page loads' }, pay), [null], 'Pay is not driven by payment');
  assert.deepEqual(drive({ ...base, claim: 'driven: Pay, then receipt' }, pay), ['R-0050']);
  assert.deepEqual(drive({ ...base, claim: 'driven: (pay)' }, pay), ['R-0050'], 'punctuation is a boundary');
});

test('click-through: a flow name with regex characters matches literally', () => {
  const base = { id: 'R-0051', stage: 'review', agent: 'spine:live-verify', claim: 'driven: Sign up (new) ok', evidence: [{ kind: 'command', ref: 'x' }], confidence: 0.9, severity: 'INFO', revision: 'r', payloads: [{ path: 'e.png' }] };
  const flows = [{ name: 'Sign up (new)', weight: 'minor', steps: ['a'] }];
  assert.deepEqual(buildReadingMap({ ...mapInput({}, [FINDING, base]), product: { flows_touched: flows } }).groups.click_through.map((e) => e.evidence), ['R-0051']);
});

test('click-through: a flow without steps reads steps unavailable (R-0158)', () => {
  const map = buildReadingMap({ ...mapInput(), product: { flows_touched: [{ name: 'Checkout', weight: 'critical', steps: [] }] } });
  assert.deepEqual(map.groups.click_through[0].steps, []);
  assert.match(renderReadingMap(map, META), /## Click through yourself\n\n1\. \*\*Checkout\*\* \(critical\) · not driven\n   steps unavailable\n/);
});
