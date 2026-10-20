'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { makeRun, run, RUN_ID } = require('./helpers/model-run');
const { cleanEnv, ROOT } = require('./helpers/claude-cases');
const { validateRecord } = require('../scripts/lib/validate');
const { writeRecords } = require('../scripts/lib/record-writer');
const mp = require('../scripts/lib/model-policy');

const rec = (extra = {}) => ({ id: 'R-XXXX', stage: 'review', agent: 'ecc:code-reviewer', claim: 'c', evidence: [{ kind: 'file', ref: 'a.py:1' }, { kind: 'test', ref: 't' }], confidence: 0.9, severity: 'HIGH', ...extra });
const fence = (r) => ['```json spine-record', JSON.stringify(r), '```'].join('\n');

// A run with a models.json planned for review at the given size.
function planned(t, { size = 'L', config } = {}) {
  const r = makeRun(t, { size, config });
  const res = run(['--run', r.dir, '--stage', 'review', '--size', size], r);
  assert.equal(res.status, 0, res.stderr);
  return r;
}

function wr(r, record, flags = [], via = 'file') {
  const file = path.join(tmpDir('spine-rm-in-', null), 'in.txt');
  fs.writeFileSync(file, via === 'text' ? `text\n${fence(record)}\n` : JSON.stringify(record));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'write-record.js'), r.dir, via === 'text' ? '--from-text' : '--file', file, ...flags], { encoding: 'utf8', env: cleanEnv() });
  return res;
}
const stored = (r, id) => JSON.parse(fs.readFileSync(path.join(r.dir, 'records', `${id}.json`), 'utf8'));

test('old records without model fields still validate and write unchanged (REQ-32)', (t) => {
  const original = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'records', 'valid.json'), 'utf8'));
  assert.deepEqual(validateRecord(original), []);
  const r = makeRun(t);
  const [id] = writeRecords(r.dir, [original]);
  const { id: _a, ...saved } = stored(r, id);
  const { id: _b, ...expected } = original;
  assert.deepEqual(saved, expected);
});

test('--model-role stamps the block from models.json (REQ-30, REQ-31)', (t) => {
  const r = planned(t);
  const res = wr(r, rec(), ['--model-role', 'finder']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(stored(r, 'R-0001').model, { role: 'finder', tier: 'trunk', tier_source: 'size', class: 'top', requested: 'opus', source: 'requested' });
});

test('an agent claiming opus in its body is stored with the dispatcher value (REQ-30)', (t) => {
  const r = makeRun(t, { size: 'S' });
  assert.equal(run(['--run', r.dir, '--stage', 'review', '--size', 'S'], r).status, 0);
  for (const model of [{ role: 'synthesis', class: 'top', requested: 'opus', source: 'requested' }, 'opus']) {
    const res = wr(r, rec({ model, verifier_model: model, model_note: 'verifier below finder strength' }), ['--model-role', 'synthesis'], 'text');
    assert.equal(res.status, 0, res.stderr);
  }
  for (const id of ['R-0001', 'R-0002']) {
    const s = stored(r, id);
    assert.deepEqual(s.model, { role: 'synthesis', tier: 'leaf', tier_source: 'size', class: 'cheap', requested: 'haiku', source: 'requested' });
    assert.equal('verifier_model' in s, false);
    assert.equal('model_note' in s, false);
  }
});

test('an agent-written model field is dropped when no --model-role is given (REQ-30)', (t) => {
  const r = planned(t);
  const res = wr(r, rec({ model: 'opus', verifier_model: { role: 'verifier' }, model_note: 'x' }), [], 'text');
  assert.equal(res.status, 0, res.stderr);
  const s = stored(r, 'R-0001');
  for (const k of ['model', 'verifier_model', 'model_note']) assert.equal(k in s, false, k);
});

test('workflow JSON passed with --file keeps a valid model block and drops an invalid one', (t) => {
  const r = planned(t);
  const block = { role: 'finder', tier: 'trunk', tier_source: 'tree', class: 'top', requested: 'opus', source: 'requested' };
  assert.equal(wr(r, rec({ model: block, verifier_model: { ...block, role: 'verifier' } })).status, 0);
  assert.deepEqual(stored(r, 'R-0001').model, block);
  assert.equal(stored(r, 'R-0001').verifier_model.role, 'verifier');
  assert.equal(wr(r, rec({ model: 'opus', model_note: 'nope' })).status, 0);
  assert.equal('model' in stored(r, 'R-0002'), false);
  assert.equal('model_note' in stored(r, 'R-0002'), false);
});

test('--model-source overrides the source; session-fallback keeps requested (REQ-31)', (t) => {
  const r = planned(t);
  assert.equal(wr(r, rec(), ['--model-role', 'verifier', '--model-source', 'session-fallback']).status, 0);
  const m = stored(r, 'R-0001').model;
  assert.equal(m.source, 'session-fallback');
  assert.equal(m.requested, 'opus');
});

test('a floor-raised plan entry keeps its source and reason', (t) => {
  const r = planned(t, { config: { model_policy: { verifier: { trunk: 'cheap' } } } });
  assert.equal(wr(r, rec(), ['--model-role', 'verifier']).status, 0);
  const m = stored(r, 'R-0001').model;
  assert.equal(m.source, 'floor-raised');
  assert.equal(m.reason, 'policy_clamped: raised from cheap to top (finder class)');
  assert.deepEqual(mp.validateModelBlock(m), []);
});

test('missing models.json gives a fallback-error block (REQ-23)', (t) => {
  const r = makeRun(t);
  assert.equal(wr(r, rec(), ['--model-role', 'finder', '--model-source', 'fallback-error']).status, 0);
  assert.deepEqual(stored(r, 'R-0001').model, { role: 'finder', tier: null, tier_source: null, class: null, requested: null, source: 'fallback-error' });
  assert.equal(wr(r, rec(), ['--model-role', 'finder']).status, 0);
  assert.equal(stored(r, 'R-0002').model.source, 'fallback-error');
});

const verifyFlags = (extra) => ['--model-role', 'verifier', '--verifies', 'R-0001', '--verified', 'true', ...extra];
const verification = () => rec({ agent: 'mattpocock-skills:code-review', claim: 'v', severity: 'INFO', evidence: [{ kind: 'file', ref: 'a.py:1' }] });

test('a trunk verification whose verifier fell back below the finder gets model_note (REQ-28)', (t) => {
  const r = planned(t);
  assert.equal(wr(r, rec(), ['--model-role', 'finder', '--provider', 'ecc:code-review', '--author', 'ecc']).status, 0);
  const res = wr(r, verification(), verifyFlags(['--model-source', 'session-fallback']));
  assert.equal(res.status, 0, res.stderr);
  const v = stored(r, 'R-0002');
  assert.equal(v.model_note, 'verifier below finder strength');
  assert.equal(v.verified, true);
});

test('a verifier at finder strength gets no model_note', (t) => {
  const r = planned(t);
  assert.equal(wr(r, rec(), ['--model-role', 'finder']).status, 0);
  assert.equal(wr(r, verification(), verifyFlags([])).status, 0);
  assert.equal('model_note' in stored(r, 'R-0002'), false);
});

test('no model_note under the kill switch or on branch', (t) => {
  const inherit = planned(t, { config: { model_policy: 'inherit' } });
  assert.equal(wr(inherit, rec(), ['--model-role', 'finder']).status, 0);
  assert.equal(wr(inherit, verification(), verifyFlags(['--model-source', 'session-fallback'])).status, 0);
  assert.equal('model_note' in stored(inherit, 'R-0002'), false);
  const branch = planned(t, { size: 'M', config: { model_policy: { finder: { branch: 'top' } } } });
  assert.equal(wr(branch, rec(), ['--model-role', 'finder']).status, 0);
  assert.equal(wr(branch, verification(), verifyFlags(['--model-source', 'session-fallback'])).status, 0);
  assert.equal('model_note' in stored(branch, 'R-0002'), false);
});

test('bad --model-role or --model-source exits 1 naming the flag', (t) => {
  const r = planned(t);
  for (const flags of [['--model-role', 'reviewer'], ['--model-role', 'finder', '--model-source', 'self']]) {
    const res = wr(r, rec(), flags);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /bad flag --model-(role|source)/);
  }
  assert.equal(fs.existsSync(path.join(r.dir, 'records')), false);
});

test('requested and observed are never conflated (REQ-33)', (t) => {
  const r = planned(t);
  assert.equal(wr(r, rec(), ['--model-role', 'finder']).status, 0);
  assert.equal('observed' in stored(r, 'R-0001').model, false);
  assert.deepEqual(mp.validateModelBlock({ ...stored(r, 'R-0001').model, source: 'observed' }), ['model.source is invalid']);
});

test('the write-record flag literals equal ROLES and SOURCES', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'write-record.js'), 'utf8');
  const alt = (flag) => new RegExp(`'${flag}': /\\^\\(([^)]*)\\)\\$/`).exec(text)[1].split('|');
  assert.deepEqual(alt('--model-role'), [...mp.ROLES]);
  assert.deepEqual(alt('--model-source'), [...mp.SOURCES]);
});

test('RUN_ID fixture is a valid run id', () => {
  assert.match(RUN_ID, /^\d{8}-[a-z0-9-]+$/);
});
