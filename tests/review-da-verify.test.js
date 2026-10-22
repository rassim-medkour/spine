'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review.workflow.js'), 'utf8').replace(/^export /, '');

// Finders report two MEDIUMs with two evidence kinds, so nothing reaches the
// verify step and the devils advocate gate opens; the devils advocate then
// raises a HIGH of its own.
function run(daVerdict) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push(opts.label);
    if (opts.label.startsWith('find:')) {
      return { findings: [
        { claim: 'cache never repaired', severity: 'MEDIUM', confidence: 0.8, evidence: [{ kind: 'file', ref: 'edge.py:708' }] },
        { claim: 'sync skips existing dest', severity: 'MEDIUM', confidence: 0.8, evidence: [{ kind: 'test', ref: 'tests/test_edge.py:40' }] },
      ] };
    }
    if (opts.label === 'devils-advocate') {
      return { findings: [{ claim: 'CI never runs the new tests', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'tests/test_edge.py:19' }], dissent: 'module skip' }] };
    }
    if (opts.label.startsWith('verify-da:')) return daVerdict;
    return null;
  };
  const parallel = (thunks) => Promise.all(thunks.map((fn) => fn()));
  const pipeline = (items, stage) => Promise.all(items.map((v, i) => stage(v, v, i)));
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body);
  return fn(agent, parallel, pipeline, () => {}, () => {}, {
    diff: 'x', changedFiles: ['edge.py'], devilsAdvocate: true, runId: 'r', stage: 'review',
    providers: [{ id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] }, { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] }],
  }).then((result) => ({ result, calls }));
}

const daRecord = (result) => result.records.find((r) => r.agent === 'spine:devils-advocate' && r.claim === 'CI never runs the new tests');

test('a HIGH raised by the devils advocate is sent to a verifier', async () => {
  const { calls } = await run({ refuted: false, reason: 'confirmed: module-level skip', evidence: [] });
  assert.ok(calls.includes('verify-da:0'), `calls: ${calls.join(', ')}`);
});

test('a confirmed devils advocate HIGH keeps its severity and is marked verified', async () => {
  const { result } = await run({ refuted: false, reason: 'confirmed', evidence: [] });
  const r = daRecord(result);
  assert.equal(r.severity, 'HIGH');
  assert.equal(r.verified, true);
});

test('a devils advocate HIGH the verifier refutes or cannot check drops to MEDIUM with a note', async () => {
  for (const verdict of [{ refuted: true, reason: 'skip is per-test', evidence: [] }, null]) {
    const { result } = await run(verdict);
    const r = daRecord(result);
    assert.equal(r.severity, 'MEDIUM');
    assert.equal(r.verified, false);
    assert.match(r.verifier_note, /devils advocate HIGH not confirmed/);
  }
});
