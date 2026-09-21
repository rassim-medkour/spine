'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadWorkflow(name) {
  const file = path.join(WORKFLOWS_DIR, `${name}.workflow.js`);
  const text = fs.readFileSync(file, 'utf8');
  const body = text.replace(/^export /, '');
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body);
}

// Stub agent() result chosen by inspecting opts.schema.required, per the finding's
// fixed shapes for each schema used across the three workflows.
const STUBS = {
  findings: { findings: [] },
  'evidence,reason,refuted': { refuted: true, reason: 'stub', evidence: [] },
  'blockers,commits,implemented,summary,tests_run': {
    implemented: true, summary: 's', commits: [], tests_run: 't', blockers: []
  },
  'issues,pass': { pass: true, issues: [] },
  'assumptions,questions,requirements,risks': {
    requirements: [], risks: [], questions: [], assumptions: []
  },
  'assumptions,data_and_migrations,dissent,error_paths,out_of_scope,requirements,summary,test_anchors': {
    summary: 's', requirements: [], error_paths: [], data_and_migrations: [], test_anchors: [],
    assumptions: [], out_of_scope: [], dissent: []
  }
};

function schemaKey(schema) {
  return ((schema && schema.required) || []).slice().sort().join(',');
}

async function stubAgent(_prompt, opts) {
  const key = schemaKey(opts && opts.schema);
  return Object.prototype.hasOwnProperty.call(STUBS, key) ? STUBS[key] : null;
}

async function stubParallel(thunks) {
  return Promise.all(thunks.map((fn) => fn()));
}

async function stubPipeline(items, ...stages) {
  const originals = items;
  let values = items;
  for (const stage of stages) {
    values = await Promise.all(values.map((value, i) => Promise.resolve(stage(value, originals[i], i))));
  }
  return values;
}

function noop() {}

function run(name, args) {
  const fn = loadWorkflow(name);
  return fn(stubAgent, stubParallel, stubPipeline, noop, noop, args);
}

test('review.workflow.js with fixture args returns an object with a records array', async () => {
  const result = await run('review', {
    diff: 'x',
    changedFiles: ['a.py'],
    providers: [
      { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
      { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] }
    ],
    devilsAdvocate: false,
    runId: 'r',
    stage: 'review'
  });
  assert.ok(Array.isArray(result.records));
});

test('implement.workflow.js does not throw when a ticket lacks files and acceptance', async () => {
  const result = await run('implement', {
    tickets: [{ id: 'T-1', title: 'Do x', spec_section: '3', kind: 'feature', status: 'todo' }],
    specText: 'spec text',
    planText: 'plan text',
    runId: 'r',
    implementProviders: [],
    reviewProviders: []
  });
  assert.ok(Array.isArray(result.results));
});

test('spec.workflow.js with fixture args returns sections and records', async () => {
  const result = await run('spec', { intentText: 'x', lenses: ['domain'], providers: [], runId: 'r' });
  assert.ok(Array.isArray(result.sections));
  assert.ok(Array.isArray(result.records));
});

test('review.workflow.js throws on missing required args', async () => {
  await assert.rejects(run('review', {}), /args\.diff is required/);
});

test('implement.workflow.js throws on missing required args', async () => {
  await assert.rejects(run('implement', {}), /args\.tickets is required/);
});

test('spec.workflow.js throws on missing required args', async () => {
  await assert.rejects(run('spec', {}), /args\.intentText is required/);
});

// A stub agent() that throws for any label containing "fail" simulates a
// provider crashing. Workflows must survive that (finding 8) rather than
// letting the rejection propagate and fail the whole run.
async function flakyAgent(_prompt, opts) {
  if (opts && typeof opts.label === 'string' && opts.label.includes('fail')) {
    throw new Error('boom');
  }
  return stubAgent(_prompt, opts);
}

function runFlaky(name, args) {
  const fn = loadWorkflow(name);
  return fn(flakyAgent, stubParallel, stubPipeline, noop, noop, args);
}

test('review.workflow.js survives a failing provider and reports it', async () => {
  const result = await runFlaky('review', {
    diff: 'x',
    changedFiles: ['a.py'],
    providers: [
      { id: 'ecc:fail-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
      { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] }
    ],
    devilsAdvocate: false,
    runId: 'r',
    stage: 'review'
  });
  assert.ok(Array.isArray(result.records));
  assert.deepEqual(result.failed_providers, ['ecc:fail-review']);
});

test('implement.workflow.js survives a failing implementer and reports it', async () => {
  const result = await runFlaky('implement', {
    tickets: [{ id: 'T-fail', title: 'Do x', spec_section: '3', kind: 'feature', status: 'todo', files: [], acceptance: [] }],
    specText: 'spec text',
    planText: 'plan text',
    runId: 'r',
    implementProviders: [],
    reviewProviders: []
  });
  assert.ok(Array.isArray(result.results));
  assert.deepEqual(result.failed_tickets, ['T-fail']);
});

test('spec.workflow.js survives a failing lens and reports it', async () => {
  const result = await runFlaky('spec', { intentText: 'x', lenses: ['domain-fail'], providers: [], runId: 'r' });
  assert.ok(Array.isArray(result.sections));
  assert.deepEqual(result.failed_lenses, ['domain-fail']);
});

// Finding 2 (cross review must never be verified by its own author) and
// finding 5 (devils-advocate records must carry dissent + resolution) only
// got static substring assertions in the original fix wave. This drives the
// workflow with a stub that plays two distinct providers and the devils
// advocate, and asserts on the actual returned records instead of on prompt
// text substrings.
test('review.workflow.js verifies a HIGH finding with a different-author verifier and records devils-advocate dissent', async () => {
  const verifyCalls = [];

  async function twoProviderAgent(prompt, opts) {
    const label = (opts && opts.label) || '';
    if (label === 'find:ecc:code-review') {
      return {
        findings: [{
          claim: 'SQL built via string concatenation',
          severity: 'HIGH',
          confidence: 0.9,
          evidence: [
            { kind: 'file', ref: 'a.py:10' },
            { kind: 'test', ref: 'tests/a_test.py:1' }
          ],
          alternatives: []
        }]
      };
    }
    if (label.startsWith('find:')) return { findings: [] };
    if (label.startsWith('verify:')) {
      verifyCalls.push({ agentType: opts.agentType, prompt });
      return { refuted: false, reason: 'confirmed against the cited lines', evidence: [] };
    }
    if (label === 'devils-advocate') {
      return {
        findings: [{
          claim: 'the concatenation is safe because inputs are pre-validated upstream',
          severity: 'MEDIUM',
          confidence: 0.5,
          evidence: [{ kind: 'file', ref: 'a.py:3' }],
          alternatives: [],
          dissent: 'validation happens in a different module and could be bypassed',
          resolution: { kind: 'test', text: 'add a test that calls this path without upstream validation' }
        }]
      };
    }
    return null;
  }

  const providers = [
    { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
    { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] }
  ];

  const fn = loadWorkflow('review');
  const result = await fn(twoProviderAgent, stubParallel, stubPipeline, noop, noop, {
    diff: 'x',
    changedFiles: ['a.py'],
    providers,
    devilsAdvocate: true,
    runId: 'r',
    stage: 'review'
  });

  assert.equal(verifyCalls.length, 1, 'the HIGH finding must be verified exactly once');
  assert.equal(
    verifyCalls[0].agentType,
    'feature-dev:code-reviewer',
    'verifier must be the anthropic-author provider, never ecc (the author who raised the finding)'
  );

  assert.equal(result.dissent.length, 1);
  assert.equal(result.dissent[0].dissent, 'validation happens in a different module and could be bypassed');
  assert.deepEqual(result.dissent[0].resolution, {
    kind: 'test',
    text: 'add a test that calls this path without upstream validation'
  });

  const daRecord = result.records.find((r) => r.agent === 'spine:devils-advocate');
  assert.ok(daRecord, 'expected a record attributed to spine:devils-advocate');
  assert.equal(daRecord.dissent, 'validation happens in a different module and could be bypassed');
  assert.deepEqual(daRecord.resolution, {
    kind: 'test',
    text: 'add a test that calls this path without upstream validation'
  });
});
