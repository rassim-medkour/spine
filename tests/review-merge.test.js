'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review.workflow.js'), 'utf8').replace(/^export /, '');

// Three finders report the same skipped-suite problem at different lines, plus one unrelated finding.
const FOUND = {
  'find:a': [{ claim: 'test_edge.py skips the whole module in CI', severity: 'MEDIUM', confidence: 0.8, evidence: [{ kind: 'file', ref: 'tools/tests/test_edge.py:19' }] }],
  'find:b': [{ claim: 'CI never runs edge tests: module-level skip', severity: 'HIGH', confidence: 0.7, evidence: [{ kind: 'file', ref: 'tools/tests/test_edge.py:938' }] },
    { claim: 'models sync leaves a second copy', severity: 'MEDIUM', confidence: 0.8, evidence: [{ kind: 'file', ref: 'edge.py:793' }] }],
  'find:c': [{ claim: 'workflow does not check out sylvia-fleet, so tests skip', severity: 'MEDIUM', confidence: 0.6, evidence: [{ kind: 'file', ref: '.github/workflows/verify.yml:27' }] }],
};

function run(mergeReply) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt });
    if (FOUND[opts.label]) return { findings: FOUND[opts.label] };
    if (opts.label === 'merge') return mergeReply;
    return null;
  };
  const parallel = (thunks) => Promise.all(thunks.map((fn) => fn()));
  const pipeline = (items, stage) => Promise.all(items.map((v, i) => stage(v, v, i)));
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body);
  const providers = ['a', 'b', 'c'].map((id, i) => ({ id, kind: 'agent', author: `au${i}`, rank: i + 1, strengths: [] }));
  return fn(agent, parallel, pipeline, () => {}, () => {}, { diff: 'x', changedFiles: [], devilsAdvocate: false, runId: 'r', stage: 'review', providers })
    .then((result) => ({ result, calls }));
}

test('a merge step groups findings that make the same claim at different lines', async () => {
  const { result, calls } = await run({ groups: [[0, 1, 3]] });
  assert.ok(calls.some((c) => c.label === 'merge'));
  assert.equal(result.findings.length, 2);
  const merged = result.findings.find((f) => f.corroboration === 3);
  assert.ok(merged, 'one finding carries all three reports');
  assert.equal(merged.severity, 'HIGH', 'the group keeps its highest severity');
  assert.deepEqual([...merged.providers].sort(), ['a', 'b', 'c']);
  assert.equal(merged.evidence.length, 3, 'every cited location is kept');
});

test('a failed or malformed merge reply keeps the findings as they were', async () => {
  for (const reply of [null, { groups: [[0, 99]] }, { groups: [[0, 0]] }, { groups: 'x' }, { groups: [[0, 1], [1, 3]] }]) {
    const { result } = await run(reply);
    assert.equal(result.findings.length, 4, JSON.stringify(reply));
  }
});

test('merging keeps every member claim, and never folds one CRITICAL or HIGH into another', async () => {
  const { result } = await run({ groups: [[0, 1, 3]] });
  const merged = result.findings.find((f) => f.corroboration === 3);
  for (const claim of ['test_edge.py skips the whole module in CI', 'workflow does not check out sylvia-fleet, so tests skip']) {
    assert.ok(merged.alternatives.some((a) => a.includes(claim)), `kept: ${claim}`);
  }
  const twoHigh = { ...FOUND, 'find:a': [{ ...FOUND['find:a'][0], severity: 'CRITICAL' }] };
  const saved = FOUND['find:a'];
  FOUND['find:a'] = twoHigh['find:a'];
  try {
    const again = await run({ groups: [[0, 1, 3]] });
    assert.equal(again.result.findings.length, 4, 'a group with two CRITICAL/HIGH members is not merged');
  } finally {
    FOUND['find:a'] = saved;
  }
});
