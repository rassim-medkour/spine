const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'validate-artifact.js');

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

function repoWithRun() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-'));
  const cfg = loadConfig(cwd, home);
  const dir = path.join(cwd, '.spine', '20260920-demo');
  writeState(dir, { id: '20260920-demo', stage: 'intent', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z' });
  setActive(cwd, cfg, '20260920-demo');
  return { cwd, home, dir };
}

test('exits 0 silently when no active run', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.md') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('reports problems for an invalid artifact inside the run dir', () => {
  const { cwd, home, dir } = repoWithRun();
  const file = path.join(dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\n---\n\n# no headings\n');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /intent\.md has \d+ problem/);
  assert.match(out.hookSpecificOutput.additionalContext, /missing heading "## Problem"/);
});

test('stays silent for a valid artifact', () => {
  const { cwd, home, dir } = repoWithRun();
  const file = path.join(dir, 'intent.md');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'artifacts', 'intent-valid.md'), file);
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('ignores files outside the run dir', () => {
  const { cwd, home } = repoWithRun();
  const file = path.join(cwd, 'README.md');
  fs.writeFileSync(file, 'hi');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Edit', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
