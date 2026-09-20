const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'subagent-gate.js');
const FIX = path.join(__dirname, 'fixtures', 'transcripts');

function run(payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-'));
  const cfg = loadConfig(cwd, home);
  writeState(path.join(cwd, '.spine', '20260920-demo'), { id: '20260920-demo', stage: 'review', status: 'active', awaiting: null, size: 'M', updated: '2026-09-20T10:00:00Z' });
  setActive(cwd, cfg, '20260920-demo');
  return { cwd, home };
}

test('exits 0 without agent_transcript_path', () => {
  const { cwd, home } = repo();
  assert.equal(run({ cwd }, { SPINE_HOME: home }).status, 0);
});

test('exits 0 when transcript has no spine-record block', () => {
  const { cwd, home } = repo();
  const t = path.join(os.tmpdir(), `spine-t-${process.pid}.jsonl`);
  fs.writeFileSync(t, '{"type":"assistant","message":{"content":[{"type":"text","text":"plain answer"}]}}\n');
  assert.equal(run({ cwd, agent_transcript_path: t }, { SPINE_HOME: home }).status, 0);
});

test('exits 0 for a valid record', () => {
  const { cwd, home } = repo();
  assert.equal(run({ cwd, agent_transcript_path: path.join(FIX, 'record-ok.jsonl') }, { SPINE_HOME: home }).status, 0);
});

test('blocks for an invalid record', () => {
  const { cwd, home } = repo();
  const r = run({ cwd, agent_transcript_path: path.join(FIX, 'record-bad.jsonl') }, { SPINE_HOME: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /severity CRITICAL requires/);
});
