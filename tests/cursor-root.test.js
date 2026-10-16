// tests/cursor-root.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectRoot, locateRun } = require('../scripts/lib/root');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');

const tmp = () => tmpDir('spine-root-');
// Isolate from the developer's real ~/.spine/config.json (artifacts_dir could differ).
process.env.SPINE_HOME = tmp();
function withRun() {
  const root = tmp();
  writeState(path.join(root, '.spine', '20260920-demo'), { id: '20260920-demo', stage: 'intent', status: 'active', awaiting: null });
  setActive(root, loadConfig(root, tmp()), '20260920-demo');
  return root;
}
const noEnv = {};

test('workspace_roots wins when absolute and existing', () => {
  const a = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: [a], env: { CURSOR_PROJECT_DIR: tmp() }, cwd: tmp() }), path.resolve(a));
});
test('CURSOR_PROJECT_DIR is used when workspace_roots is absent', () => {
  const c = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: [], env: { CURSOR_PROJECT_DIR: c, CLAUDE_PROJECT_DIR: tmp() }, cwd: tmp() }), path.resolve(c));
});
test('CLAUDE_PROJECT_DIR is used after CURSOR_PROJECT_DIR', () => {
  const c = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: [], env: { CLAUDE_PROJECT_DIR: c }, cwd: tmp() }), path.resolve(c));
});
test('cwd is the last resort', () => {
  const c = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: [], env: noEnv, cwd: c }), path.resolve(c));
});
test('a relative root is ignored', () => {
  const c = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: ['relative/dir'], env: noEnv, cwd: c }), path.resolve(c));
});
test('a missing root is ignored', () => {
  const c = tmp();
  assert.equal(resolveProjectRoot({ workspaceRoots: [path.join(c, 'nope')], env: noEnv, cwd: c }), path.resolve(c));
});
test('with two roots, the one holding a valid active.json wins', () => {
  const plain = tmp();
  const runRoot = withRun();
  assert.equal(resolveProjectRoot({ workspaceRoots: [plain, runRoot], env: noEnv, cwd: tmp() }), path.resolve(runRoot));
});
test('a root whose active.json has a bad id does not win', () => {
  const plain = tmp();
  const bad = tmp();
  setActive(bad, loadConfig(bad, tmp()), '../../etc');
  assert.equal(resolveProjectRoot({ workspaceRoots: [plain, bad], env: noEnv, cwd: tmp() }), path.resolve(plain));
});
test('no usable root returns null', () => {
  assert.equal(resolveProjectRoot({ workspaceRoots: ['rel'], env: noEnv, cwd: 'also-rel' }), null);
});
test('forward-slash Windows root resolves', { skip: process.platform !== 'win32' }, () => {
  const runRoot = withRun();
  const fwd = runRoot.replace(/\\/g, '/').replace(/^([A-Z]):/, (m, d) => `${d.toLowerCase()}:`);
  assert.equal(resolveProjectRoot({ workspaceRoots: [fwd], env: noEnv, cwd: tmp() }).toLowerCase(), path.resolve(runRoot).toLowerCase());
});
test('locateRun honors enabled:false', () => {
  const runRoot = withRun();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify({ enabled: false }));
  const prev = process.env.SPINE_HOME;
  process.env.SPINE_HOME = home;
  try {
    const located = locateRun({ workspaceRoots: [runRoot] }, noEnv, tmp());
    assert.equal(located.run, null);
    assert.equal(located.disabled, true);
  } finally {
    if (prev === undefined) delete process.env.SPINE_HOME; else process.env.SPINE_HOME = prev;
  }
});
