'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE, cursorRepo, fixture } = require('./helpers/cursor-repo');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const DECLARED = ['skills', 'agents', 'rules', 'hooks', 'commands'];

test('.cursor-plugin/plugin.json parses and names the plugin spine', () => {
  const m = json('.cursor-plugin/plugin.json');
  assert.equal(m.name, 'spine');
  assert.equal(m.license, 'MIT');
  assert.equal(m.repository, 'https://github.com/rassim-medkour/spine');
});

test('every declared skills/agents/rules/hooks/commands path resolves', () => {
  const m = json('.cursor-plugin/plugin.json');
  for (const key of DECLARED) {
    if (!(key in m)) continue;
    for (const p of [].concat(m[key])) assert.ok(fs.existsSync(path.join(ROOT, p)), `${key}: ${p} does not exist`);
  }
});

test('hooks path is explicit and points to a version 1 Cursor hooks file, never hooks/hooks.json', () => {
  const m = json('.cursor-plugin/plugin.json');
  assert.equal(m.hooks, './hooks/cursor-hooks.json');
  assert.equal(json('hooks/cursor-hooks.json').version, 1);
});

test('marketplace lists spine with source ./', () => {
  const mk = json('.cursor-plugin/marketplace.json');
  assert.equal(mk.name, 'spine');
  assert.equal(mk.plugins.length, 1);
  assert.equal(mk.plugins[0].name, 'spine');
  assert.equal(mk.plugins[0].source, './');
});

test('version lockstep across package.json and all four manifests', () => {
  const v = json('package.json').version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(json('.claude-plugin/plugin.json').version, v);
  assert.equal(json('.claude-plugin/marketplace.json').plugins[0].version, v);
  assert.equal(json('.cursor-plugin/plugin.json').version, v);
  const mk = json('.cursor-plugin/marketplace.json').plugins[0];
  if ('version' in mk) assert.equal(mk.version, v);
});

test('no Cursor file references CLAUDE_PLUGIN_ROOT and no Claude file references CURSOR_PLUGIN_ROOT', () => {
  for (const rel of ['.cursor-plugin/plugin.json', '.cursor-plugin/marketplace.json', 'hooks/cursor-hooks.json']) assert.doesNotMatch(read(rel), /CLAUDE_PLUGIN_ROOT/, rel);
  for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json']) assert.doesNotMatch(read(rel), /CURSOR_PLUGIN_ROOT/, rel);
});

test('Cursor hook commands run from an install path containing spaces and shell metacharacters', () => {
  const install = path.join(tmpDir('spine-inst-'), 'a b&c');
  for (const part of ['scripts', 'schemas', 'hooks']) fs.cpSync(path.join(ROOT, part), path.join(install, part), { recursive: true });
  for (const f of ['providers.json', 'providers.cursor.json']) fs.copyFileSync(path.join(ROOT, f), path.join(install, f));
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const { hooks } = json('hooks/cursor-hooks.json');
  const command = hooks.stop[0].command.replace('${CURSOR_PLUGIN_ROOT}', install);
  const res = spawnSync(command, {
    shell: true, encoding: 'utf8', cwd: tmpDir('spine-userproj-'),
    input: JSON.stringify({ ...fixture('stop.json'), workspace_roots: [r.root] }),
    env: cleanEnv({ SPINE_HOME: r.home, CURSOR_PLUGIN_ROOT: install }),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).followup_message, /intent\.md is missing/);
});
