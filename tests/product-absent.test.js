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
  assert.equal(recs[0].claim, 'key flow paths matched nothing: Ghost: nowhere/**');
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

// T-14 (REQ-1, REQ-32): byte-identity against artifacts captured from 0.3.2.
const { capture, ARTIFACTS } = require('./fixtures/product/absent-baseline/capture');
const BASELINE = path.join(__dirname, 'fixtures', 'product', 'absent-baseline', '0.3.2');
const ROOT = path.join(__dirname, '..');
const stripVolatile = (name, buf) => {
  if (name !== 'diagnostics.json') return buf;
  const { elapsed_ms: _elapsed, ...rest } = JSON.parse(buf.toString('utf8'));
  return Buffer.from(JSON.stringify(rest));
};

test('every baseline artifact is byte-equal with the new code and no product.md', (t) => {
  const out = tmpDir('spine-absent-now-', t);
  const manifest = capture({ spineRoot: ROOT, out });
  assert.deepEqual(manifest.artifacts, ARTIFACTS);
  assert.ok(!manifest.run_folder.includes('product.json') && !manifest.run_folder.includes('records'));
  for (const name of ['manifest.json', ...ARTIFACTS]) {
    const now = stripVolatile(name, fs.readFileSync(path.join(out, name)));
    const then = stripVolatile(name, fs.readFileSync(path.join(BASELINE, name)));
    assert.ok(now.equals(then), `${name} differs from the 0.3.2 baseline`);
  }
});

test('the bootstrap step adds exactly one INFO record and changes no artifact', (t) => {
  const out = tmpDir('spine-absent-boot-', t);
  const manifest = capture({ spineRoot: ROOT, out, productContext: true });
  assert.equal(manifest.record_bodies.length, 1);
  const rec = manifest.record_bodies[0];
  assert.equal(rec.agent, 'spine:orchestrator');
  assert.equal(rec.severity, 'INFO');
  assert.equal(rec.claim, 'no product context: .spine/product.md absent');
  for (const name of ARTIFACTS) {
    const now = stripVolatile(name, fs.readFileSync(path.join(out, name)));
    const then = stripVolatile(name, fs.readFileSync(path.join(BASELINE, name)));
    assert.ok(now.equals(then), `${name} differs from the 0.3.2 baseline`);
  }
  // run-status output and the run folder layout also match (R-0183 to R-0190). models.json is not produced by this flow:
  // REQ-18 changes the policy hash by design, so it is excluded from byte-identity; product.json is the REQ-2 marker.
  const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE, 'manifest.json'), 'utf8'));
  assert.ok(baseline.run_status && Array.isArray(baseline.run_folder), 'baseline manifest holds run_status and run_folder');
  assert.deepEqual(manifest.run_status, baseline.run_status);
  const allowed = new Set(['product.json', 'records', 'records/' + manifest.records[0]]);
  assert.deepEqual(manifest.run_folder.filter((p) => !allowed.has(p)), baseline.run_folder);
  assert.deepEqual(manifest.run_folder.filter((p) => allowed.has(p)), ['product.json', 'records', 'records/' + manifest.records[0]]);
});

// T-15a
test('T-15a: a trimmed load writes one INFO naming what was left out, once per run', (t) => {
  const r = setup(t, doc().replace('term: meaning\n', 'g\n'.repeat(40)));
  fs.writeFileSync(path.join(r.root, '.spine', 'config.json'), JSON.stringify({ product_context_max_lines: 20 }));
  assert.equal(call(r).state, 'trimmed');
  call(r);
  call(r);
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].severity, 'INFO');
  assert.match(recs[0].claim, /^product context trimmed: left out .*## Users/);
  assert.equal(productJson(r.runDir).trim_record, recs[0].id);
});

test('T-15a: the unmatched-glob INFO lists flow and glob pairs; a dropped entry is named with its line', (t) => {
  const r = setup(t, doc(flow('Checkout', 'src/checkout/**, nowhere/**') + '### Bad\nweight: huge\npaths: a/**\n'));
  call(r, 'src/checkout/a.js');
  const recs = records(r.runDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].claim, 'key flow paths matched nothing: Checkout: nowhere/**; key flow entries dropped: Bad');
  assert.ok(recs[0].evidence.some((e) => /^\.spine\/product\.md:\d+$/.test(e.ref)));
});

test('T-15a: a glob that does not compile is planned as one flow INFO', () => {
  const { plannedRecords } = require('../scripts/product-context');
  const prev = { absent_record: null, defect_record: null, trim_record: null, flow_record: null };
  const loaded = { state: 'ok', leftOut: [] };
  const issues = [{ flow: 'Pay', glob: '[', message: 'glob does not compile', line: 12 }];
  const plan = plannedRecords(prev, loaded, issues, '.spine/product.md');
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].slice(0, 3), ['flow_record', 'INFO', 'key flow paths matched nothing: Pay: [']);
  assert.equal(plan[0][3][0].ref, '.spine/product.md:12');
  assert.deepEqual(plannedRecords({ ...prev, flow_record: 'R-0001' }, loaded, issues, '.spine/product.md'), []);
});

test('T-15a: argument errors throw with the flag named', (t) => {
  const r = setup(t);
  assert.throws(() => main([], r.root), /--run <run dir> is required/);
  assert.throws(() => main(['--run'], r.root), /missing value for --run/);
  assert.throws(() => main(['--run', r.runDir, '--files'], r.root), /missing value for --files/);
  assert.throws(() => main(['--run', r.runDir, '--bogus', 'x'], r.root), /unknown flag --bogus/);
  assert.throws(() => main(['--run', r.runDir, '--decide'], r.root), /--decide needs/);
});

test('T-15a: a corrupt product.json is a defect: no new record and ok false', (t) => {
  const r = setup(t);
  fs.writeFileSync(path.join(r.runDir, 'product.json'), '{nope');
  const out = call(r);
  assert.deepEqual([out.ok, out.error], [false, 'product.json unreadable']);
  assert.deepEqual(records(r.runDir), []);
  assert.equal(fs.readFileSync(path.join(r.runDir, 'product.json'), 'utf8'), '{nope');
});

test('product.json carries the section map of the full product.md and the tracked doc list (R-0129, R-0124)', (t) => {
  const text = doc();
  const r = setup(t, text);
  fs.writeFileSync(path.join(r.root, 'README.md'), '# r\n');
  fs.mkdirSync(path.join(r.root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'docs', 'guide.md'), 'g\n');
  call(r);
  const pj = productJson(r.runDir);
  const { sectionMapOf } = require('../scripts/lib/cap-record');
  const { parseProduct } = require('../scripts/lib/product-context');
  assert.deepEqual(pj.sections, JSON.parse(JSON.stringify(sectionMapOf(parseProduct(text).sections))));
  assert.deepEqual(Object.keys(pj.sections['## Invariants']).sort(), ['blank', 'end', 'headings', 'start']);
  assert.ok(pj.repo_docs.includes('README.md') && pj.repo_docs.includes('docs/guide.md'));
  assert.ok(pj.repo_docs.every((f) => /(\.(md|markdown|rst|txt)$)|(^|\/)docs\//i.test(f)));
});

test('an absent product.md leaves sections null and repo_docs empty', (t) => {
  const r = setup(t);
  call(r);
  const pj = productJson(r.runDir);
  assert.equal(pj.sections, null);
  assert.deepEqual(pj.repo_docs, []);
});
