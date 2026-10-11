'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, findActiveRun } = require('./state');

// Order decided by spike T-1 (spec REQ-48 default).
const ROOT_SOURCES = Object.freeze(['workspace_roots', 'CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'cwd']);

function isUsableDir(p) {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function candidates({ workspaceRoots = [], env = process.env, cwd = process.cwd() }) {
  const bySource = {
    workspace_roots: workspaceRoots,
    CURSOR_PROJECT_DIR: [env.CURSOR_PROJECT_DIR],
    CLAUDE_PROJECT_DIR: [env.CLAUDE_PROJECT_DIR],
    cwd: [cwd],
  };
  return ROOT_SOURCES.flatMap((s) => bySource[s] || []);
}

function resolveProjectRoot(opts) {
  const usable = [...new Set(candidates(opts).filter(isUsableDir).map((p) => path.resolve(p)))];
  if (!usable.length) return null;
  const withRun = usable.find((root) => findActiveRun(root, loadConfig(root)));
  return withRun || usable[0];
}

function locateRun(input, env = process.env, cwd = process.cwd()) {
  const root = resolveProjectRoot({ workspaceRoots: input.workspaceRoots, env, cwd });
  if (!root) return { root: null, config: null, run: null, disabled: false };
  const config = loadConfig(root);
  if (config.enabled === false) return { root, config, run: null, disabled: true };
  return { root, config, run: findActiveRun(root, config), disabled: false };
}

module.exports = { ROOT_SOURCES, resolveProjectRoot, locateRun };
