// tests/cross-author-parity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ca = require('../scripts/lib/cross-author');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const text = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review.workflow.js'), 'utf8');
const workflow = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', text.replace(/^export /, ''));
const parallel = (thunks) => Promise.all(thunks.map((fn) => fn()));
const pipeline = async (items, ...stages) => {
  let values = items;
  for (const s of stages) values = await Promise.all(values.map((v, i) => Promise.resolve(s(v, items[i], i))));
  return values;
};
const noop = () => {};

const PROVIDERS = [
  { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
  { id: 'mattpocock-skills:code-review', kind: 'skill', author: 'mattpocock', rank: 2, strengths: [] },
  { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] },
];

async function runWorkflow(findingsByProvider, { providers = PROVIDERS, refuted = false, devilsAdvocate = false } = {}) {
  const verifiers = [];
  let daCalled = false;
  const agent = async (prompt, opts) => {
    if (opts.label.startsWith('find:')) return { findings: findingsByProvider[opts.label.slice(5)] || [] };
    if (opts.label.startsWith('verify:')) {
      const skill = /Invoke the skill (\S+) with/.exec(prompt);
      verifiers.push(opts.agentType !== 'general-purpose' ? opts.agentType : skill ? skill[1] : null);
      return { refuted, reason: 'stub', evidence: [] };
    }
    if (opts.label === 'devils-advocate') { daCalled = true; return { findings: [] }; }
    return null;
  };
  await workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers, devilsAdvocate, runId: 'r', stage: 'review' });
  return { verifiers, daCalled };
}

function toRecords(findingsByProvider, providers = PROVIDERS) {
  let n = 0;
  return Object.entries(findingsByProvider).flatMap(([id, list]) => list.map((f) => ({ ...f, id: `R-${String(++n).padStart(4, '0')}`, stage: 'review', agent: id, provider: id, author: providers.find((p) => p.id === id).author })));
}

const HIGH = (ref, kinds = ['file']) => ({ claim: 'c', severity: 'HIGH', confidence: 0.9, evidence: kinds.map((k, i) => ({ kind: k, ref: i ? `t${i}` : ref })) });

const CASES = {
  'single author': { 'ecc:code-review': [HIGH('a.py:1')] },
  'two authors on one location': { 'ecc:code-review': [HIGH('a.py:1')], 'mattpocock-skills:code-review': [HIGH('a.py:1')] },
  'every author raised it': { 'ecc:code-review': [HIGH('a.py:1')], 'mattpocock-skills:code-review': [HIGH('a.py:1')], 'feature-dev:code-reviewer': [HIGH('a.py:1')] },
};

for (const [name, findings] of Object.entries(CASES)) {
  test(`pickVerifier matches review.workflow.js: ${name}`, async () => {
    const { verifiers } = await runWorkflow(findings);
    const plan = ca.verifierPlan(toRecords(findings), PROVIDERS);
    assert.deepEqual(plan.map((p) => (p.verifier ? p.verifier.id : null)), verifiers);
  });
}

const GATE_CASES = {
  'verified, two evidence kinds, flag on': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: false, devilsAdvocate: true }],
  'refuted': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: true, devilsAdvocate: true }],
  'one evidence kind': [{ 'ecc:code-review': [HIGH('a.py:1')] }, { refuted: false, devilsAdvocate: true }],
  'flag off': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: false, devilsAdvocate: false }],
};

for (const [name, [findings, opts]] of Object.entries(GATE_CASES)) {
  test(`daGateOpen matches review.workflow.js: ${name}`, async () => {
    const { daCalled } = await runWorkflow(findings, opts);
    const records = toRecords(findings);
    const plan = ca.verifierPlan(records, PROVIDERS);
    const verifications = plan.map((p, i) => ({ id: `R-9${String(i).padStart(3, '0')}`, stage: 'review', agent: p.verifier.id, provider: p.verifier.id, author: p.verifier.author, verifies: p.record_id, verified: !opts.refuted, claim: 'v', evidence: [{ kind: 'unverified', ref: 'v' }], confidence: 1, severity: 'INFO' }));
    assert.equal(ca.daGateOpen([...records, ...verifications], opts.devilsAdvocate).open, daCalled);
  });
}
