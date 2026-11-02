const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers/tmp');
const { writeState } = require('../scripts/lib/state');
const { main } = require('../scripts/product-context');

const RUN_ID = '20261101-product-test';
const flow = (name, paths) => `### ${name}\nweight: critical\npaths: ${paths}\n1. one\n`;
const doc = (flows = flow('Checkout', 'src/checkout/**')) =>
  `## Users\nowners\n## Goals\nship\n## Glossary\nterm: meaning\n## Invariants\nnever lose money\n## Key flows\n${flows}## UX principles\nbe clear\n`;

function setup(t, productText) {
  const root = tmpDir('spine-pabs-', t);
  const runDir = path.join(root, '.spine', RUN_ID);
  writeState(runDir, { id: RUN_ID, stage: 'spec', status: 'active', awaiting: null, size: 'M', updated: '2026-11-01T00:00:00Z', host: 'claude-code', spine_version: '0.4.0' });
  if (productText !== undefined) fs.writeFileSync(path.join(root, '.spine', 'product.md'), productText);
  fs.mkdirSync(path.join(root, 'src', 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'checkout', 'a.js'), '');
  return { root, runDir };
}

const records = (runDir) => {
  const dir = path.join(runDir, 'records');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};
const productJson = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'product.json'), 'utf8'));
const call = (r, files = '') => main(['--run', r.runDir, ...(files ? ['--files', files] : [])], r.root);

test('first call writes product.json and one INFO with the exact claim', (t) => {
  const r = setup(t);
  const out = call(r);
  assert.equal(out.state, 'absent');
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].agent, 'spine:orchestrator');
  assert.equal(recs[0].severity, 'INFO');
  assert.equal(recs[0].claim, 'no product context: .spine/product.md absent');
  assert.equal(productJson(r.runDir).absent_record, recs[0].id);
  assert.equal(fs.existsSync(path.join(r.runDir, 'product-context.md')), false);
});

test('second call writes no new record', (t) => {
  const r = setup(t);
  call(r);
  call(r);
  call(r, 'src/a.js');
  assert.equal(records(r.runDir).length, 1);
});

test('with product.md present the absent record is never written', (t) => {
  const r = setup(t, doc());
  call(r);
  assert.equal(productJson(r.runDir).state, 'ok');
  assert.deepEqual(records(r.runDir), []);
});

test('a changed sha256 on a second call writes one INFO and keeps product.json state', (t) => {
  const r = setup(t, doc());
  call(r);
  const before = productJson(r.runDir);
  fs.writeFileSync(path.join(r.root, '.spine', 'product.md'), doc() + 'extra\n');
  call(r);
  call(r);
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].claim, 'product.md changed since run start');
  assert.equal(recs[0].severity, 'INFO');
  const after = productJson(r.runDir);
  assert.equal(after.state, before.state);
  assert.equal(after.sha256, before.sha256);
  assert.equal(after.resume_record, recs[0].id);
});

test('a flow whose glob matches nothing writes one INFO naming the flow, once', (t) => {
  const r = setup(t, doc(flow('Checkout', 'src/checkout/**') + flow('Ghost', 'nowhere/**')));
  fs.mkdirSync(path.join(r.root, 'src', 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'src', 'checkout', 'a.js'), '');
  const out = call(r, 'src/checkout/a.js');
  assert.equal(out.flows_touched, 1);
  call(r, 'src/checkout/a.js');
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].severity, 'INFO');
  assert.equal(recs[0].claim, 'key flow paths matched nothing: Ghost');
  assert.match(recs[0].evidence[0].ref, /^\.spine\/product\.md:\d+$/);
});

test('loaded_lines lands in diagnostics.json when it exists', (t) => {
  const r = setup(t, doc());
  fs.writeFileSync(path.join(r.runDir, 'diagnostics.json'), JSON.stringify({ elapsed_ms: 5 }));
  const out = call(r);
  const diag = JSON.parse(fs.readFileSync(path.join(r.runDir, 'diagnostics.json'), 'utf8'));
  assert.equal(diag.elapsed_ms, 5);
  assert.equal(diag.product.loaded_lines, out.loaded_lines);
  assert.equal(diag.product.state, 'ok');
});

test('diagnostics.json is not created when absent', (t) => {
  const r = setup(t);
  call(r);
  assert.equal(fs.existsSync(path.join(r.runDir, 'diagnostics.json')), false);
});

test('T-2b: absent and malformed leave diagnostics.json byte-identical', (t) => {
  for (const text of [undefined, '## Users\n']) {
    const r = setup(t, text);
    const file = path.join(r.runDir, 'diagnostics.json');
    fs.writeFileSync(file, '{"elapsed_ms":5}');
    call(r);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"elapsed_ms":5}');
  }
});

test('T-2b: a dropped flow is named in one INFO with its line', (t) => {
  const r = setup(t, doc('### Bad\nweight: huge\npaths: src/**\n1. one\n'));
  call(r);
  call(r);
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.match(recs[0].claim, /Bad/);
  assert.match(recs[0].evidence[0].ref, /^\.spine\/product\.md:\d+$/);
});

test('T-2b: an untouched flow with repo files writes no record', (t) => {
  const r = setup(t, doc());
  fs.mkdirSync(path.join(r.root, 'src', 'checkout'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'src', 'checkout', 'a.js'), '');
  call(r, 'README.md');
  assert.deepEqual(records(r.runDir), []);
});

test('T-2b: a corrupt product.json is a defect: no new record, ok false', (t) => {
  const r = setup(t);
  fs.writeFileSync(path.join(r.runDir, 'product.json'), '{not json');
  const out = call(r);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'product.json unreadable');
  assert.deepEqual(records(r.runDir), []);
  assert.equal(fs.readFileSync(path.join(r.runDir, 'product.json'), 'utf8'), '{not json');
});
