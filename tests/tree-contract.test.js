'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateTree, validateJson, loadSchema, schemaFor, validateArtifactFile } = require('../scripts/lib/validate');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');
const { STAGE_ARTIFACTS } = require('../scripts/lib/gate');
const { cleanEnv, ROOT } = require('./helpers/claude-cases');

const GOLDEN = path.join(__dirname, 'fixtures', 'tree-golden.json');
const golden = () => JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const schema = loadSchema('tree');

test('the golden tree.json validates', () => {
  assert.deepEqual(validateTree(golden()), []);
  assert.equal(schemaFor('.spine/20261015-x/tree.json'), 'tree');
  assert.deepEqual(validateArtifactFile(GOLDEN, 'tree.json'), []);
});

test('AC-8 consumer fields exist in the schema and the golden file', () => {
  assert.deepEqual(schema.consumer_fields, ['schema_version', 'tier', 'files[].path', 'files[].tier']);
  const g = golden();
  assert.equal(g.schema_version, 1);
  assert.ok(schema.enums.tier.includes(g.tier));
  for (const f of g.files) {
    assert.equal(typeof f.path, 'string');
    assert.ok(schema.arrays.files.enums.tier.includes(f.tier));
  }
});

const MUTATIONS = {
  'missing top-level tier': [(t) => { delete t.tier; }, 'missing required key tier'],
  'unknown file tier': [(t) => { t.files[1].tier = 'core'; }, 'files[1].tier must be one of leaf, branch, trunk'],
  'missing signal': [(t) => { delete t.files[0].signals.gated; }, 'files[0].signals missing gated'],
  'fan_in without resolved': [(t) => { delete t.files[1].signals.fan_in.resolved; }, 'files[1].signals.fan_in.resolved must be a boolean'],
  'empty reasons': [(t) => { t.files[0].reasons = []; }, 'files[0].reasons must be a non-empty array of strings'],
  'path with ..': [(t) => { t.files[0].path = '../README.md'; }, 'files[0].path must be repo-relative with forward slashes'],
  'backslash path': [(t) => { t.files[1].path = 'src\\lib\\math.ts'; }, 'files[1].path must be repo-relative with forward slashes'],
  'top tier below file maximum': [(t) => { t.tier = 'branch'; }, 'tier must equal the highest file tier'],
  'unsorted files': [(t) => { t.files.reverse(); }, 'files must be sorted by path without duplicates'],
  'unknown schema version': [(t) => { t.schema_version = 2; }, 'schema_version must be 1'],
  'missing input': [(t) => { delete t.inputs.diff_sha256; }, 'inputs missing diff_sha256'],
  'missing knob': [(t) => { delete t.knobs.gated; }, 'knobs missing gated'],
  'bad knob answer': [(t) => { t.knobs.is_trunk.answer = 'maybe'; }, 'knobs.is_trunk.answer must be yes, no or unknown'],
  'knob without evidence': [(t) => { t.knobs.is_trunk.evidence = []; }, 'knobs.is_trunk.evidence must be a non-empty array'],
};

for (const [name, [mutate, message]] of Object.entries(MUTATIONS)) {
  test(`tree.json mutation fails with a named error: ${name}`, () => {
    const t = golden();
    mutate(t);
    const errors = validateTree(t);
    assert.ok(errors.includes(message), JSON.stringify(errors));
    assert.ok(errors.every((e) => !e.includes(', got ')), 'errors never quote artifact values');
  });
}

test('class.json: old files validate, the optional tier key is checked', () => {
  const cls = { size: 'S', blast_radius: 'low', signals: {}, lenses: [], devils_advocate: false, workflows: {} };
  assert.deepEqual(validateJson(cls, loadSchema('class')), []);
  assert.deepEqual(validateJson({ ...cls, tier: 'trunk' }, loadSchema('class')), []);
  assert.equal(validateJson({ ...cls, tier: 'core' }, loadSchema('class')).length, 1);
});

test('the Stop gate never requires tree.json, reading-map.md or proof', () => {
  assert.deepEqual(STAGE_ARTIFACTS.review, ['review.json']);
  assert.deepEqual(STAGE_ARTIFACTS.plan, ['plan.md', 'tickets.json']);
});

function hookRepo() {
  const root = tmpDir('spine-tree-hook-');
  const home = tmpDir('spine-tree-home-');
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), '{}');
  const id = '20261015-tree-hook';
  const dir = path.join(root, '.spine', id);
  writeState(dir, { id, stage: 'review', status: 'active', awaiting: null, size: 'M', updated: '2026-10-15T00:00:00Z' });
  setActive(root, loadConfig(root, home), id);
  return { root, home, dir };
}

function postToolUse(r, file) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-artifact.js')], {
    input: JSON.stringify({ cwd: r.root, tool_input: { file_path: file } }),
    encoding: 'utf8',
    env: cleanEnv({ SPINE_HOME: r.home }),
    timeout: 10000,
  });
}

test('PostToolUse fails open on a malformed or unknown-version tree.json', () => {
  const r = hookRepo();
  const file = path.join(r.dir, 'tree.json');
  fs.writeFileSync(file, '{ not json');
  assert.equal(postToolUse(r, file).status, 0);
  fs.writeFileSync(file, JSON.stringify({ ...golden(), schema_version: 2 }));
  const v2 = postToolUse(r, file);
  assert.equal(v2.status, 0);
  assert.match(v2.stdout, /tree\.json has 1 problem/);
  assert.match(fs.readFileSync(path.join(r.dir, 'hooks.log'), 'utf8'), /PostToolUse warn/);
});

test('PostToolUse validates a 5 MB tree.json within the 10 s hook timeout', () => {
  const r = hookRepo();
  const g = golden();
  const template = g.files[1];
  const files = [];
  let size = 0;
  for (let i = 0; size < 5 * 1024 * 1024; i += 1) {
    const entry = { ...template, path: `src/gen/f${String(i).padStart(6, '0')}.ts` };
    size += JSON.stringify(entry).length + 1;
    files.push(entry);
  }
  const file = path.join(r.dir, 'tree.json');
  fs.writeFileSync(file, JSON.stringify({ ...g, files }));
  const started = Date.now();
  const out = postToolUse(r, file);
  assert.equal(out.status, 0);
  assert.ok(Date.now() - started < 10000);
  assert.equal(out.stdout, '');
});
