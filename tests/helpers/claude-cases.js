// tests/helpers/claude-cases.js
'use strict';
const fs = require('node:fs');
const { tmpDir } = require('./tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../../scripts/lib/state');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const FULL = ['ecc', 'superpowers', 'mattpocock-skills', 'code-review', 'feature-dev', 'caveman'];
const BASE = { id: '20260920-demo', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z' };

const tmp = (prefix) => tmpDir(prefix);

// Strips the developer's own Cursor/Claude session vars, then applies `extra`
// (so tests can still set CURSOR_PLUGIN_ROOT or canary keys on purpose).
function cleanEnv(extra = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CURSOR_/.test(key) && key !== 'CLAUDE_PROJECT_DIR'));
  return { ...base, ...extra };
}

function repo(state, globalConfig = {}) {
  const cwd = tmp('spine-golden-');
  const home = tmp('spine-golden-home-');
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify(globalConfig));
  if (!state) return { cwd, home, dir: null };
  const dir = path.join(cwd, '.spine', state.id);
  writeState(dir, state);
  setActive(cwd, loadConfig(cwd, home), state.id);
  return { cwd, home, dir };
}

function claudeHome(names) {
  const home = tmp('spine-golden-ch-');
  fs.mkdirSync(path.join(home, 'plugins'));
  const plugins = Object.fromEntries(names.map((n) => [`${n}@m`, {}]));
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  return home;
}

function passRecord(dir, stage) {
  fs.mkdirSync(path.join(dir, 'records'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records', 'R-0001.json'), JSON.stringify({
    id: 'R-0001', stage, agent: 'spine:boundary-checker', claim: 'PASS',
    evidence: [{ kind: 'doc', ref: `${stage}.md:1` }], confidence: 1, severity: 'INFO',
  }));
}

function copyIntent(dir) {
  fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(dir, 'intent.md'));
}

function stopCase(name, state, prep = () => {}, config = {}, extraInput = {}) {
  return {
    name,
    setup() {
      const r = repo(state, config);
      if (r.dir) prep(r.dir);
      return { script: 'stop-gate.js', args: [], input: JSON.stringify({ cwd: r.cwd, stop_hook_active: false, ...extraInput }), env: { SPINE_HOME: r.home }, cwd: r.cwd, logDir: r.dir };
    },
  };
}

function subagentCase(name, transcript) {
  return {
    name,
    setup() {
      const r = repo({ ...BASE, stage: 'review', size: 'M' });
      const t = typeof transcript === 'function' ? transcript(r) : transcript;
      const payload = t ? { cwd: r.cwd, agent_transcript_path: t } : { cwd: r.cwd };
      return { script: 'subagent-gate.js', args: [], input: JSON.stringify(payload), env: { SPINE_HOME: r.home }, cwd: r.cwd, logDir: r.dir };
    },
  };
}

function validateCase(name, write) {
  return {
    name,
    setup() {
      const r = repo({ ...BASE, stage: 'intent' });
      const file = write(r);
      return { script: 'validate-artifact.js', args: [], input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: r.cwd, tool_name: 'Write', tool_input: { file_path: file } }), env: { SPINE_HOME: r.home }, cwd: r.cwd, logDir: r.dir };
    },
  };
}

const CASES = [
  stopCase('stop/no-active-run', null),
  stopCase('stop/stop-hook-active', { ...BASE, stage: 'intent' }, () => {}, {}, { stop_hook_active: true }),
  stopCase('stop/awaiting-g1', { ...BASE, stage: 'spec', awaiting: 'G1' }),
  stopCase('stop/intent-missing', { ...BASE, stage: 'intent' }),
  stopCase('stop/boundary-missing', { ...BASE, stage: 'intent' }, copyIntent),
  stopCase('stop/clean', { ...BASE, stage: 'intent' }, (d) => { copyIntent(d); passRecord(d, 'intent'); }),
  stopCase('stop/warn', { ...BASE, stage: 'intent' }, () => {}, { strictness: 'warn' }),
  stopCase('stop/unknown-stage', { ...BASE, stage: 'constructor' }),
  stopCase('stop/done', { ...BASE, stage: 'done', status: 'done' }),
  subagentCase('subagent/valid', path.join(FIX, 'transcripts', 'record-ok.jsonl')),
  subagentCase('subagent/invalid', path.join(FIX, 'transcripts', 'record-bad.jsonl')),
  subagentCase('subagent/no-block', (r) => {
    const t = path.join(r.cwd, 't.jsonl');
    fs.writeFileSync(t, '{"type":"assistant","message":{"content":[{"type":"text","text":"plain answer"}]}}\n');
    return t;
  }),
  subagentCase('subagent/no-path', null),
  {
    name: 'session/missing-plugins',
    setup() {
      const r = repo(null);
      return { script: 'session-start.js', args: [], input: JSON.stringify({ cwd: r.cwd, hook_event_name: 'SessionStart' }), env: { SPINE_HOME: r.home, SPINE_CLAUDE_HOME: claudeHome(['ecc']) }, cwd: r.cwd, logDir: null };
    },
  },
  {
    name: 'session/active-run',
    setup() {
      const r = repo({ ...BASE, stage: 'plan', awaiting: 'G2', size: 'M' });
      return { script: 'session-start.js', args: [], input: JSON.stringify({ cwd: r.cwd, hook_event_name: 'SessionStart' }), env: { SPINE_HOME: r.home, SPINE_CLAUDE_HOME: claudeHome(FULL) }, cwd: r.cwd, logDir: r.dir };
    },
  },
  validateCase('validate/invalid-intent', (r) => {
    const f = path.join(r.dir, 'intent.md');
    fs.writeFileSync(f, '---\nid: x\n---\n\n# no headings\n');
    return f;
  }),
  validateCase('validate/valid-intent', (r) => { copyIntent(r.dir); return path.join(r.dir, 'intent.md'); }),
  validateCase('validate/outside-run', (r) => { const f = path.join(r.cwd, 'README.md'); fs.writeFileSync(f, 'hi'); return f; }),
  {
    name: 'select/review-M',
    setup() {
      const r = repo(null);
      return { script: 'select-providers.js', args: ['review', 'M'], input: '', env: { SPINE_HOME: r.home, SPINE_CLAUDE_HOME: claudeHome(FULL) }, cwd: r.cwd, logDir: null };
    },
  },
];

function scrub(text) {
  const tmpRoots = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
  return tmpRoots.reduce((acc, t) => acc.split(t).join('<tmp>'), text).replace(/\\/g, '/');
}

function readLog(dir) {
  if (!dir) return '';
  try {
    return fs.readFileSync(path.join(dir, 'hooks.log'), 'utf8').split('\n').map((l) => l.replace(/^\S+ /, '')).join('\n');
  } catch {
    return '';
  }
}

function runCase(c) {
  const s = c.setup();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', s.script), ...s.args], {
    input: s.input, encoding: 'utf8', env: cleanEnv(s.env), cwd: s.cwd,
  });
  return { status: r.status, stdout: scrub(r.stdout), stderr: scrub(r.stderr), log: readLog(s.logDir) };
}

if (require.main === module && process.argv.includes('--write')) {
  const golden = Object.fromEntries(CASES.map((c) => [c.name, runCase(c)]));
  fs.writeFileSync(path.join(FIX, 'claude-golden.json'), JSON.stringify(golden, null, 2) + '\n');
  process.stdout.write(`wrote ${CASES.length} golden cases\n`);
}

module.exports = { CASES, runCase, cleanEnv, ROOT, FIX };
