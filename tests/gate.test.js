'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const gate = require('../scripts/lib/gate');

const FIX = path.join(__dirname, 'fixtures');

function run(stage, extra = {}) {
  const dir = tmpDir('spine-gate-');
  return { id: '20260920-demo', dir, state: { stage, status: 'active', awaiting: null, ...extra } };
}

function pass(dir, stage) {
  fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records', 'R-0001.json'), JSON.stringify({ id: 'R-0001', stage, agent: 'spine:boundary-checker', claim: 'PASS', evidence: [{ kind: 'doc', ref: 'x:1' }], confidence: 1, severity: 'INFO' }));
}

test('collectIssues reports a missing artifact and a missing boundary PASS', () => {
  assert.deepEqual(gate.collectIssues(run('intent')), [{ kind: 'missing', artifact: 'intent.md' }, { kind: 'no-boundary-pass' }]);
});

test('collectIssues returns only unknown-stage for an unknown or prototype stage name', () => {
  assert.deepEqual(gate.collectIssues(run('constructor')), [{ kind: 'unknown-stage' }]);
});

test('formatIssues reproduces the Claude Stop hook strings exactly', () => {
  const r = run('intent');
  fs.writeFileSync(path.join(r.dir, 'intent.md'), '---\nid: x\n---\n');
  assert.deepEqual(gate.collectErrors(r), [
    'intent.md: missing frontmatter key stage',
    'intent.md: missing frontmatter key upstream_id',
    'intent.md: missing frontmatter key status',
    'intent.md: missing heading "## Problem"',
    'intent.md: missing heading "## Acceptance criteria"',
    'intent.md: missing heading "## Constraints"',
    'intent.md: missing heading "## Out of scope"',
    'no PASS record from spine:boundary-checker for stage intent',
  ]);
});

test('evaluateStop allows for awaiting gates, human, non-active status, done and clean stages', () => {
  for (const awaiting of gate.HUMAN_WAIT) assert.equal(gate.evaluateStop(run('intent', { awaiting }), { strictness: 'block' }).decision, 'allow');
  assert.equal(gate.evaluateStop(run('intent', { status: 'paused' }), { strictness: 'block' }).decision, 'allow');
  assert.equal(gate.evaluateStop(run('done'), { strictness: 'block' }).decision, 'allow');
  const clean = run('intent');
  fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(clean.dir, 'intent.md'));
  pass(clean.dir, 'intent');
  assert.equal(gate.evaluateStop(clean, { strictness: 'block' }).decision, 'allow');
  assert.equal(gate.evaluateStop(null, { strictness: 'block' }).decision, 'allow');
});

test('evaluateStop blocks, or warns under strictness warn', () => {
  assert.equal(gate.evaluateStop(run('intent'), { strictness: 'block' }).decision, 'block');
  assert.equal(gate.evaluateStop(run('intent'), { strictness: 'warn' }).decision, 'warn');
});

test('extractRecordBlocks returns every block and extractRecordBlock the last', () => {
  const text = '```json spine-record\n{"a":1}\n```\nmid\n```json spine-record\n{"b":2}\n```';
  assert.deepEqual(gate.extractRecordBlocks(text), ['{"a":1}', '{"b":2}']);
  assert.equal(gate.extractRecordBlock(text), '{"b":2}');
  assert.equal(gate.extractRecordBlock('no block'), null);
});

test('evaluateSubagentText: no block allows, bad JSON and invalid records fail with Claude reasons', () => {
  assert.equal(gate.evaluateSubagentText('plain', { strictness: 'block' }).decision, 'allow');
  const bad = gate.evaluateSubagentText('```json spine-record\n{nope\n```', { strictness: 'block' });
  assert.equal(bad.decision, 'block');
  assert.equal(gate.subagentReason(bad), 'spine-record block is not valid JSON');
  const rec = { id: 'R-1', stage: 'review', agent: 'x', claim: 'c', evidence: [{ kind: 'unverified', ref: 'h' }], confidence: 0.3, severity: 'CRITICAL' };
  const invalid = gate.evaluateSubagentText('```json spine-record\n' + JSON.stringify(rec) + '\n```', { strictness: 'warn' });
  assert.equal(invalid.decision, 'warn');
  assert.equal(gate.subagentReason(invalid), 'spine-record invalid: severity CRITICAL requires at least one evidence item that is not unverified');
});
