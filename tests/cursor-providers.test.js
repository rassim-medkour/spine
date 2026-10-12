// tests/cursor-providers.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectProviders, loadRegistry, pluginOf } = require('../scripts/lib/providers');
const { installedProvidersCursor } = require('../scripts/lib/cursor-providers');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const cursorReg = JSON.parse(fs.readFileSync(path.join(ROOT, 'providers.cursor.json'), 'utf8'));
const claudeReg = JSON.parse(fs.readFileSync(path.join(ROOT, 'providers.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spine-cp-'));
const pluginName = (p) => p.plugin || pluginOf(p.id);

test('every Cursor registry id is unique per stage and has author, rank and kind', () => {
  for (const [stage, list] of Object.entries(cursorReg)) {
    assert.equal(new Set(list.map((p) => p.id)).size, list.length, `${stage} has duplicate ids`);
    for (const p of list) {
      assert.ok(p.author && Number.isInteger(p.rank) && ['skill', 'agent', 'tool'].includes(p.kind), JSON.stringify(p));
    }
  }
});

test('the Cursor registry mirrors providers.json ids, authors, ranks and kinds', () => {
  const pick = (reg) => Object.fromEntries(Object.entries(reg).map(([s, l]) => [s, l.map(({ id, author, rank, kind }) => ({ id, author, rank, kind }))]));
  assert.deepEqual(pick(cursorReg), pick(claudeReg));
});

test('Cursor selection gives the same picks as Claude for the same available set, distinct authors first', () => {
  for (const stage of Object.keys(claudeReg)) {
    for (const size of ['S', 'M', 'L']) {
      const claudeInstalled = [...new Set(claudeReg[stage].map((p) => pluginOf(p.id)))];
      const cursorInstalled = [...new Set(cursorReg[stage].map(pluginName))];
      const a = selectProviders(stage, size, claudeInstalled, claudeReg).map((p) => p.id);
      const b = selectProviders(stage, size, cursorInstalled, cursorReg).map((p) => p.id);
      assert.deepEqual(b, a, `${stage} ${size}`);
    }
  }
  const m = selectProviders('review', 'M', [...new Set(cursorReg.review.map(pluginName))], cursorReg);
  assert.notEqual(m[0].author, m[1].author);
});

test('an unresolvable provider is not available and is skipped', () => {
  const sel = selectProviders('review', 'M', [], cursorReg);
  assert.deepEqual(sel, []);
});

test('installedProvidersCursor reads the config list first', () => {
  const spineHome = tmp();
  fs.mkdirSync(path.join(spineHome, '.spine'));
  fs.writeFileSync(path.join(spineHome, '.spine', 'config.json'), JSON.stringify({ cursor_providers: ['superpowers', '../evil', 5] }));
  assert.deepEqual(installedProvidersCursor({ cursorHome: tmp(), spineHome }), ['superpowers']);
});

test('installedProvidersCursor reads cache/<marketplace>/<plugin>/<ref> and local/<plugin>', () => {
  const cursorHome = tmp();
  fs.mkdirSync(path.join(cursorHome, 'plugins', 'cache', 'cursor-public', 'superpowers', 'abc123'), { recursive: true });
  fs.mkdirSync(path.join(cursorHome, 'plugins', 'cache', 'cursor-public', 'emptyplugin'), { recursive: true });
  fs.mkdirSync(path.join(cursorHome, 'plugins', 'local', 'caveman'), { recursive: true });
  assert.deepEqual(installedProvidersCursor({ cursorHome, spineHome: tmp() }), ['caveman', 'superpowers']);
});

test('absent or malformed plugin dirs return []', () => {
  assert.deepEqual(installedProvidersCursor({ cursorHome: path.join(tmp(), 'nope'), spineHome: tmp() }), []);
  const cursorHome = tmp();
  fs.mkdirSync(path.join(cursorHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cursorHome, 'plugins', 'cache'), 'not a dir');
  assert.deepEqual(installedProvidersCursor({ cursorHome, spineHome: tmp() }), []);
});

test('detection never executes files found in the plugin cache', () => {
  const cursorHome = tmp();
  const marker = path.join(tmp(), 'executed');
  const dir = path.join(cursorHome, 'plugins', 'cache', 'm', 'evil', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"main":"index.js"}');
  installedProvidersCursor({ cursorHome, spineHome: tmp() });
  assert.equal(fs.existsSync(marker), false);
});

test('cursor_import_claude adds plugins resolved through installed_plugins.json', () => {
  const spineHome = tmp();
  fs.mkdirSync(path.join(spineHome, '.spine'));
  fs.writeFileSync(path.join(spineHome, '.spine', 'config.json'), JSON.stringify({ cursor_import_claude: true }));
  const claudeHome = tmp();
  fs.mkdirSync(path.join(claudeHome, 'plugins'));
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'mattpocock-skills@m': {} } }));
  assert.deepEqual(installedProvidersCursor({ cursorHome: tmp(), spineHome, claudeHome }), ['mattpocock-skills']);
});

test('select-providers --host cursor uses the Cursor registry and detection', () => {
  const cursorHome = tmp();
  for (const p of ['superpowers', 'caveman']) fs.mkdirSync(path.join(cursorHome, 'plugins', 'local', p), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'select-providers.js'), 'review', 'M', '--host', 'cursor'], {
    encoding: 'utf8', cwd: tmp(), env: cleanEnv({ SPINE_CURSOR_HOME: cursorHome, SPINE_HOME: tmp() }),
  });
  assert.equal(r.status, 0, r.stderr);
  const ids = JSON.parse(r.stdout).map((p) => p.id);
  assert.ok(ids.length === 2 && ids.every((id) => /^(superpowers|caveman):/.test(id)), ids.join(','));
});

test('select-providers rejects an unknown host', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'select-providers.js'), 'review', 'M', '--host', 'vim'], { encoding: 'utf8', cwd: tmp(), env: cleanEnv() });
  assert.equal(r.status, 1);
});

test('loadRegistry defaults to the Claude registry', () => {
  assert.deepEqual(loadRegistry(), claudeReg);
  assert.deepEqual(loadRegistry('cursor'), cursorReg);
});
