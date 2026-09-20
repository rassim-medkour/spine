const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'session-start.js');
const FULL = ['ecc', 'superpowers', 'mattpocock-skills', 'code-review', 'coderabbit', 'feature-dev', 'caveman'];

function fakeClaudeHome(pluginNames) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ch-'));
  fs.mkdirSync(path.join(home, 'plugins'));
  const plugins = Object.fromEntries(pluginNames.map((n) => [`${n}@m`, {}]));
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
  return home;
}

function run(cwd, claudeHome, spineHome) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: { ...process.env, SPINE_CLAUDE_HOME: claudeHome, SPINE_HOME: spineHome },
  });
}

test('silent when everything installed and no active run', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const r = run(cwd, fakeClaudeHome(FULL), fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('warns about missing plugins', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const r = run(cwd, fakeClaudeHome(['ecc']), fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-')));
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /missing plugins: .*mattpocock-skills/);
});

test('exits 0 with no stdout when the registry cannot be read', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const badRegistry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spine-reg-')), 'does-not-exist.json');
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SPINE_CLAUDE_HOME: fakeClaudeHome(FULL),
      SPINE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-')),
      SPINE_REGISTRY_PATH: badRegistry,
    },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('mentions the active run', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-home-'));
  const cfg = loadConfig(cwd, home);
  writeState(path.join(cwd, '.spine', '20260920-demo'), { id: '20260920-demo', stage: 'plan', status: 'active', awaiting: 'G2', size: 'M', updated: '2026-09-20T10:00:00Z' });
  setActive(cwd, cfg, '20260920-demo');
  const r = run(cwd, fakeClaudeHome(FULL), home);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /active run 20260920-demo at stage plan, awaiting G2/);
});
