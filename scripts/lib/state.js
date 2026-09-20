'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  strictness: 'block',
  artifacts_dir: '.spine',
  lens_budget: 6,
  second_model: false,
  render_artifacts: false,
  critical_paths: [],
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadConfig(cwd, homeDir = process.env.SPINE_HOME || os.homedir()) {
  const global = readJson(path.join(homeDir, '.spine', 'config.json')) || {};
  const artifactsDir = global.artifacts_dir || DEFAULTS.artifacts_dir;
  const repo = readJson(path.join(cwd, artifactsDir, 'config.json')) || {};
  return { ...DEFAULTS, ...global, ...repo, artifacts_dir: artifactsDir };
}

function findActiveRun(cwd, config) {
  const base = path.join(cwd, config.artifacts_dir);
  const active = readJson(path.join(base, 'active.json'));
  if (!active || typeof active.id !== 'string') return null;
  const dir = path.join(base, active.id);
  const state = readJson(path.join(dir, 'state.json'));
  if (!state) return null;
  return { id: active.id, dir, state };
}

function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

function setActive(cwd, config, id) {
  const base = path.join(cwd, config.artifacts_dir);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'active.json'), JSON.stringify({ id }, null, 2) + '\n');
}

module.exports = { DEFAULTS, loadConfig, findActiveRun, writeState, setActive, readJson };
