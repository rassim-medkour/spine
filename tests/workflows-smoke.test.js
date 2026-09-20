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
