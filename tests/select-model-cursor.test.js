'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRun, run } = require('./helpers/model-run');
const { makeDb, sqliteAvailable } = require('./helpers/cursor-db');
const { tmpDir } = require('./helpers/tmp');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor-models', 'application-user.json'), 'utf8'));
const AVAILABLE = ['claude-haiku-4-5', 'claude-opus-4-10', 'claude-opus-4-8', 'claude-sonnet-4-6', 'default'];
const needsSqlite = { skip: sqliteAvailable() ? false : 'node:sqlite unavailable' };

function cursorHome(t, value = FIXTURE) { // pass null for a home with no state.vscdb
  const dir = tmpDir('spine-cursor-home-', t);
  if (value !== null) makeDb(dir, value);
  return dir;
}
const cursorRun = (r, home, stage = 'review', more = []) => run(['--run', r.dir, '--stage', stage, '--host', 'cursor', ...more], r, { SPINE_CURSOR_HOME: home });

test('--host cursor records the list, the source and a reason for each class (REQ-42)', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L' });
  const { status, out } = cursorRun(r, cursorHome(t));
  assert.equal(status, 0);
  assert.deepEqual(out.discovery, undefined);
  const models = JSON.parse(fs.readFileSync(path.join(r.dir, 'models.json'), 'utf8'));
  assert.equal(models.discovery.source, 'state-db');
  assert.deepEqual(models.discovery.found, AVAILABLE);
  assert.equal(models.discovery.class_map.top.model, 'claude-opus-4-10');
  assert.equal(models.discovery.class_map.mid.model, 'claude-sonnet-4-6');
  assert.equal(models.discovery.class_map.cheap.model, 'claude-haiku-4-5');
  assert.equal(out.roles.finder.model, 'claude-opus-4-10');
  assert.equal(out.roles.finder.source, 'requested');
  assert.equal(out.roles.finder.host, 'cursor');
  const leaf = makeRun(t, { size: 'S' });
  const synth = cursorRun(leaf, cursorHome(t), 'spec').out.roles.synthesis;
  assert.equal(synth.class, 'cheap');
  assert.equal(synth.model, 'claude-haiku-4-5');
});

test('discovery failure maps every class to inherit with a recorded reason (REQ-42)', (t) => {
  const r = makeRun(t, { size: 'L' });
  const { out } = cursorRun(r, cursorHome(t, null));
  for (const e of Object.values(out.roles)) {
    assert.equal(e.model, null);
    assert.equal(e.source, 'inherit');
    assert.equal(e.reason, 'cursor: state.vscdb not found');
  }
});

test('cursor_discovery false skips discovery and inherits', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L', config: { cursor_discovery: false } });
  const { out } = cursorRun(r, cursorHome(t));
  assert.ok(Object.values(out.roles).every((e) => e.model === null && e.source === 'inherit'));
  assert.equal(out.roles.finder.reason, 'cursor: cursor_discovery disabled');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'models.json'), 'utf8')).discovery.source, 'none');
});

test('model_ids.cursor overrides discovery', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L', config: { model_ids: { cursor: { top: 'my-top-model' } } } });
  const { out } = cursorRun(r, cursorHome(t));
  assert.equal(out.roles.finder.model, 'my-top-model');
  assert.equal(out.roles.synthesis.model, 'claude-sonnet-4-6');
});

test('discovery is cached and reused until the db mtime changes (REQ-43)', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L' });
  const home = cursorHome(t);
  cursorRun(r, home, 'spec');
  const cacheFile = path.join(r.dir, 'cursor-models.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(cache.found, AVAILABLE);
  fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, found: ['claude-opus-4-99'] }));
  const second = cursorRun(r, home, 'review');
  assert.equal(second.out.roles.finder.model, 'claude-opus-4-99');
  const db = path.join(home, 'User', 'globalStorage', 'state.vscdb');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(db, later, later);
  const third = cursorRun(r, home, 'plan');
  assert.equal(third.out.roles.finder.model, 'claude-opus-4-10');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).found, AVAILABLE);
});

test('select-model never invents a Cursor id', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L' });
  const { out } = cursorRun(r, cursorHome(t));
  for (const e of Object.values(out.roles)) assert.ok(e.model === null || AVAILABLE.includes(e.model), e.model);
});

test('cursor limitations include cursor-task-model (REQ-34)', (t) => {
  const r = makeRun(t, { size: 'M' });
  const { out } = cursorRun(r, cursorHome(t, null));
  assert.ok(out.limitations.some((l) => l.id === 'cursor-task-model'));
  const cc = run(['--run', r.dir, '--stage', 'plan'], r);
  assert.ok(!cc.out.limitations.some((l) => l.id === 'cursor-task-model'));
});

test('--host claude-code never runs discovery', needsSqlite, (t) => {
  const r = makeRun(t, { size: 'L' });
  const home = cursorHome(t);
  const t0 = Date.now();
  const { out } = run(['--run', r.dir, '--stage', 'review'], r, { SPINE_CURSOR_HOME: home });
  assert.equal(out.ok, true);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(fs.existsSync(path.join(r.dir, 'cursor-models.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'models.json'), 'utf8')).discovery, null);
});

test('query mode on cursor inherits with "no run directory"', (t) => {
  const r = makeRun(t, { size: 'M' });
  const { out } = run(['--tier', 'trunk', '--role', 'finder', '--host', 'cursor'], r, { SPINE_CURSOR_HOME: cursorHome(t, null) });
  assert.equal(out.model, null);
  assert.equal(out.source, 'inherit');
  assert.equal(out.reason, 'cursor: no run directory');
});
