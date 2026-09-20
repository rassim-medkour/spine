const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'stop-gate.js');
const FIX = path.join(__dirname, 'fixtures');

function run(payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

function repo(state, globalConfig = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-'));
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify(globalConfig));
  const cfg = loadConfig(cwd, home);
  const dir = path.join(cwd, '.spine', state.id);
  writeState(dir, state);
  setActive(cwd, cfg, state.id);
  return { cwd, home, dir };
}

function passRecord(dir, stage) {
  fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records', 'R-0001.json'), JSON.stringify({
    id: 'R-0001', stage, agent: 'spine:boundary-checker', claim: 'PASS',
    evidence: [{ kind: 'doc', ref: `${stage}.md:1` }], confidence: 1, severity: 'INFO',
  }));
}

const base = { id: '20260920-demo', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z' };

test('exits 0 when stop_hook_active', () => {
  const { cwd, home } = repo({ ...base, stage: 'intent' });
  const r = run({ cwd, stop_hook_active: true }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
});

test('exits 0 when no active run', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const r = run({ cwd, stop_hook_active: false });
  assert.equal(r.status, 0);
});

test('exits 0 when awaiting a human gate', () => {
  const { cwd, home } = repo({ ...base, stage: 'spec', awaiting: 'G1' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
});

test('exits 0 when awaiting human with a missing artifact', () => {
  const { cwd, home } = repo({ ...base, stage: 'intent', awaiting: 'human' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
});

test('blocks when the stage artifact is missing', () => {
  const { cwd, home } = repo({ ...base, stage: 'intent' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /intent\.md/);
});

test('the block reason does not coach setting awaiting to a gate', () => {
  const { cwd, home } = repo({ ...base, stage: 'intent' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /set awaiting/);
});

test('blocks with "unknown stage" for a stage not in STAGE_ARTIFACTS, including prototype names', () => {
  const { cwd, home } = repo({ ...base, stage: 'constructor' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown stage constructor/);
});

test('a blocked run appends to hooks.log', () => {
  const { cwd, home, dir } = repo({ ...base, stage: 'intent' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  const logPath = path.join(dir, 'hooks.log');
  assert.ok(fs.existsSync(logPath));
  assert.match(fs.readFileSync(logPath, 'utf8'), /Stop block/);
});

test('blocks when artifact is valid but boundary checker has not passed', () => {
  const { cwd, home, dir } = repo({ ...base, stage: 'intent' });
  fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(dir, 'intent.md'));
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /boundary-checker/);
});

test('allows when artifact is valid and boundary checker passed', () => {
  const { cwd, home, dir } = repo({ ...base, stage: 'intent' });
  fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(dir, 'intent.md'));
  passRecord(dir, 'intent');
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
});

test('warn mode exits 0 with context instead of blocking', () => {
  const { cwd, home } = repo({ ...base, stage: 'intent' }, { strictness: 'warn' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /intent\.md/);
});

test('exits 0 when stage is done', () => {
  const { cwd, home } = repo({ ...base, stage: 'done', status: 'done' });
  const r = run({ cwd, stop_hook_active: false }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
});
