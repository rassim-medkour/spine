'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { makeDb, sqliteAvailable } = require('./helpers/cursor-db');
const cm = require('../scripts/lib/cursor-models');

const ROOT = path.join(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor-models', 'application-user.json'), 'utf8'));
const needsSqlite = { skip: sqliteAvailable() ? false : 'node:sqlite unavailable' };

test('cursorUserDir honours SPINE_CURSOR_HOME, then per-platform defaults', () => {
  assert.equal(cm.cursorUserDir({ SPINE_CURSOR_HOME: '/x/y' }, 'win32', '/h'), '/x/y');
  assert.equal(cm.cursorUserDir({ APPDATA: 'C:/A' }, 'win32', '/h'), path.join('C:/A', 'Cursor'));
  assert.equal(cm.cursorUserDir({}, 'darwin', '/h'), path.join('/h', 'Library', 'Application Support', 'Cursor'));
  assert.equal(cm.cursorUserDir({}, 'linux', '/h'), path.join('/h', '.config', 'Cursor'));
  assert.equal(cm.cursorUserDir({}, 'win32', '/h'), null);
});

test('parseApplicationUser keeps ids only and drops invalid ones (REQ-41)', () => {
  const p = cm.parseApplicationUser(FIXTURE);
  assert.ok(!p.found.includes('bad id; rm -rf /'));
  assert.deepEqual(cm.availableModels(p), ['claude-haiku-4-5', 'claude-opus-4-10', 'claude-opus-4-8', 'claude-sonnet-4-6', 'default']);
  const s = JSON.stringify(p);
  assert.ok(!s.includes('tok_FAKE') && !s.includes('example.invalid') && !s.includes('123'));
});

test('mapClasses picks the highest version per family and inherits otherwise (REQ-42)', () => {
  assert.deepEqual(cm.mapClasses(['claude-opus-4-8', 'claude-opus-4-10', 'claude-sonnet-4-6', 'gpt-5.4']), {
    cheap: { model: null, reason: 'no claude-haiku model found; inherit' },
    mid: { model: 'claude-sonnet-4-6', reason: 'highest claude-sonnet found' },
    top: { model: 'claude-opus-4-10', reason: 'highest claude-opus found' },
  });
});

test('captured db: found list, source state-db, mtime, hashed source path (REQ-39, REQ-43)', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, FIXTURE);
  const r = cm.discoverCursorModels({ userDir: dir });
  assert.equal(r.source, 'state-db');
  assert.equal(r.reason, null);
  assert.deepEqual(r.found, ['claude-haiku-4-5', 'claude-opus-4-10', 'claude-opus-4-8', 'claude-sonnet-4-6', 'default']);
  assert.match(r.source_hash, /^[0-9a-f]{64}$/);
  assert.equal(typeof r.mtime_ms, 'number');
  assert.ok(!JSON.stringify(r).includes(dir));
});

test('missing db: found [], reason "state.vscdb not found" (REQ-40)', (t) => {
  const r = cm.discoverCursorModels({ userDir: tmpDir('spine-cm-', t) });
  assert.deepEqual(r, { found: [], source: 'none', reason: 'state.vscdb not found', mtime_ms: null, source_hash: null });
});

test('empty db (no key): found [], reason "model list key not found"', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, null);
  const r = cm.discoverCursorModels({ userDir: dir });
  assert.deepEqual(r.found, []);
  assert.equal(r.reason, 'model list key not found');
});

test('corrupt db file: found [], reason starts "state.vscdb unreadable"', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  const g = path.join(dir, 'User', 'globalStorage');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'state.vscdb'), 'not sqlite, just bytes '.repeat(50));
  const r = cm.discoverCursorModels({ userDir: dir });
  assert.deepEqual(r.found, []);
  assert.match(r.reason, /^state\.vscdb unreadable/);
  assert.ok(!r.reason.includes(dir));
});

test('oversized value: found [], reason "model list over size cap"', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, FIXTURE);
  const r = cm.discoverCursorModels({ userDir: dir, valueCapBytes: 100 });
  assert.deepEqual(r.found, []);
  assert.equal(r.reason, 'model list over size cap');
});

test('slow reader is killed at the time budget (REQ-40, Review Focus 5)', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, FIXTURE);
  const slow = path.join(tmpDir('spine-cm-slow-', t), 'slow.js');
  fs.writeFileSync(slow, 'setTimeout(() => {}, 10000);\n');
  const t0 = Date.now();
  const r = cm.discoverCursorModels({ userDir: dir, timeoutMs: 300, readerPath: slow });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r.found, []);
  assert.equal(r.reason, 'discovery timed out');
});

test('config list is used when no db is found', (t) => {
  const r = cm.discoverCursorModels({ userDir: tmpDir('spine-cm-', t), configModels: ['claude-opus-4-8', 'bad id!'] });
  assert.equal(r.source, 'config');
  assert.deepEqual(r.found, ['claude-opus-4-8']);
});

test('discovery writes nothing and opens no network (REQ-40)', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, FIXTURE);
  const snap = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return `${f}:${st.isFile() ? st.size : 'd'}`;
  });
  const before = snap();
  const code = `const r = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'cursor-models.js'))}).discoverCursorModels({ userDir: ${JSON.stringify(dir)} }); process.stdout.write(JSON.stringify(r));`;
  const child = spawnSync(process.execPath, ['-r', path.join(ROOT, 'tests', 'helpers', 'no-network.js'), '-e', code], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).source, 'state-db');
  assert.deepEqual(snap(), before);
});

test('no output field carries a token, an email or an absolute path (REQ-41)', needsSqlite, (t) => {
  const dir = tmpDir('spine-cm-', t);
  makeDb(dir, FIXTURE);
  const s = JSON.stringify(cm.discoverCursorModels({ userDir: dir }));
  assert.ok(!s.includes('tok_FAKE') && !s.includes('example.invalid') && !s.includes(dir) && !s.includes(JSON.stringify(dir).slice(1, -1)));
});
