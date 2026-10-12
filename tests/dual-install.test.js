'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE, ROOT, tmp, cursorRepo, fixture, runCursor, readLog } = require('./helpers/cursor-repo');
const { cleanEnv } = require('./helpers/claude-cases');
const { CURSOR_SIGNALS, runningUnderCursor } = require('../scripts/lib/host/detect');

function cursorHomeWithSpine() {
  const home = tmp('spine-dual-');
  fs.mkdirSync(path.join(home, 'plugins', 'cache', 'spine', 'spine', 'v0'), { recursive: true });
  return home;
}

function claudeUnderCursor(script, payload, env) {
  const { __cwd, ...rest } = env;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { input: JSON.stringify(payload), encoding: 'utf8', env: cleanEnv(rest), cwd: __cwd });
}

test('CURSOR_SIGNALS lists the Cursor-only env keys and never CLAUDE_PROJECT_DIR', () => {
  assert.deepEqual([...CURSOR_SIGNALS], ['CURSOR_VERSION', 'CURSOR_PROJECT_DIR']);
});

test('runningUnderCursor reads env signals and Cursor-only stdin keys', () => {
  assert.equal(runningUnderCursor({}, {}), false);
  assert.equal(runningUnderCursor({ CLAUDE_PROJECT_DIR: '/x' }, {}), false);
  assert.equal(runningUnderCursor({ CURSOR_VERSION: '1.0' }, {}), false);
  assert.equal(runningUnderCursor({ CURSOR_PROJECT_DIR: '/x' }, {}), false);
  assert.equal(runningUnderCursor({ CURSOR_VERSION: '1.0', CURSOR_PROJECT_DIR: '/x' }, {}), true);
  assert.equal(runningUnderCursor({ CURSOR_VERSION: '1.0', CLAUDE_PROJECT_DIR: '/x' }, {}), true);
  assert.equal(runningUnderCursor({ CURSOR_VERSION: '1.0', CLAUDE_PROJECT_DIR: '' }, {}), false);
  for (const key of ['cursor_version', 'conversation_id', 'workspace_roots']) {
    assert.equal(runningUnderCursor({}, { [key]: 'x' }), true, key);
  }
});

test('with both copies active in Cursor, each gate takes effect once and hooks.log has one entry', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const cursorHome = cursorHomeWithSpine();
  const payload = { ...fixture('stop.json'), workspace_roots: [r.root], cwd: r.root };
  const claude = claudeUnderCursor('stop-gate.js', payload, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: cursorHome, CURSOR_VERSION: '1.0', CLAUDE_PROJECT_DIR: r.root, __cwd: r.root });
  assert.equal(claude.status, 0);
  assert.equal(claude.stderr, '');
  const cursor = runCursor('stop.js', payload, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: cursorHome });
  assert.ok(JSON.parse(cursor.stdout).followup_message);
  assert.equal(readLog(r.dir).trim().split('\n').length, 1);
});

test('Cursor-only stdin keys alone make the Claude copy yield', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const res = claudeUnderCursor('stop-gate.js', { cwd: r.root, conversation_id: 'c1' }, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: cursorHomeWithSpine(), __cwd: r.root });
  assert.equal(res.status, 0);
  assert.equal(readLog(r.dir), '');
});

for (const script of ['subagent-gate.js', 'session-start.js', 'validate-artifact.js']) {
  test(`${script} no-ops under Cursor when the Cursor spine copy is installed`, () => {
    const r = cursorRepo({ ...BASE, stage: 'intent' });
    const res = claudeUnderCursor(script, { cwd: r.root }, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: cursorHomeWithSpine(), CURSOR_VERSION: '1.0', CURSOR_PROJECT_DIR: r.root, __cwd: r.root });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(readLog(r.dir), '');
  });
}

test('the imported Claude copy still gates when the Cursor spine copy is absent', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const res = claudeUnderCursor('stop-gate.js', { cwd: r.root, stop_hook_active: false }, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: tmp('spine-none-'), CURSOR_VERSION: '1.0', CLAUDE_PROJECT_DIR: r.root, __cwd: r.root });
  assert.equal(res.status, 2);
});

test('a config cursor_providers entry alone does not make the Claude copy yield', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' }, { cursor_providers: ['spine'] });
  const res = claudeUnderCursor('stop-gate.js', { cwd: r.root }, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: tmp('spine-none-'), CURSOR_VERSION: '1.0', CLAUDE_PROJECT_DIR: r.root, __cwd: r.root });
  assert.equal(res.status, 2);
});

test('a stray CURSOR_VERSION alone does not make the Claude copy yield', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const res = claudeUnderCursor('stop-gate.js', { cwd: r.root }, { SPINE_HOME: r.home, SPINE_CURSOR_HOME: cursorHomeWithSpine(), CURSOR_VERSION: '1.0', __cwd: r.root });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /intent.md is missing/);
});
