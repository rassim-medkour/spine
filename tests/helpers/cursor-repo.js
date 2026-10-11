// tests/helpers/cursor-repo.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../../scripts/lib/state');
const { cleanEnv } = require('./claude-cases');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const BASE = { id: '20260920-demo', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z' };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function cursorRepo(state, globalConfig = {}) {
  const root = tmp('spine-cur-');
  const home = tmp('spine-cur-home-');
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify(globalConfig));
  if (!state) return { root, home, dir: null };
  const cfg = loadConfig(root, home);
  const dir = path.join(root, cfg.artifacts_dir, state.id);
  writeState(dir, state);
  setActive(root, cfg, state.id);
  return { root, home, dir };
}

function fixture(name) {
  const data = JSON.parse(fs.readFileSync(path.join(FIX, 'cursor', name), 'utf8'));
  return Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_')));
}

function cursorEnv(extra = {}) {
  return cleanEnv({ SPINE_CURSOR_HOME: tmp('spine-cur-cursorhome-'), ...extra });
}

function runCursor(script, payload, env = {}, opts = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cursor', script)], {
    input, encoding: 'utf8', env: cursorEnv(env), cwd: opts.cwd || tmp('spine-cur-cwd-'),
  });
}

function passRecord(dir, stage, id = 'R-0001') {
  fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records', `${id}.json`), JSON.stringify({
    id, stage, agent: 'spine:boundary-checker', claim: 'PASS',
    evidence: [{ kind: 'doc', ref: `${stage}.md:1` }], confidence: 1, severity: 'INFO',
  }));
}

function readLog(dir) {
  try { return fs.readFileSync(path.join(dir, 'hooks.log'), 'utf8'); } catch { return ''; }
}

module.exports = { ROOT, FIX, BASE, tmp, cursorRepo, fixture, cursorEnv, runCursor, passRecord, readLog };
