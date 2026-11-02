const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseProduct, loadProduct, MAX_BYTES } = require('../scripts/lib/product-context');
const { tmpDir } = require('./helpers/tmp');

const flow = (name, weight, paths) => `### ${name}\nweight: ${weight}\npaths: ${paths}\n1. one\n2. two\n3. three\n`;
const doc = (flows = flow('Checkout', 'critical', 'src/checkout/**, src/pay*.js'), users = 'owners') =>
  `## Users\n${users}\n## Goals\nship\n## Glossary\nterm: meaning\n## Invariants\nnever lose money\n## Key flows\n${flows}## UX principles\nbe clear\n`;

function repo(text) {
  const root = tmpDir('spine-prod-');
  fs.mkdirSync(path.join(root, '.spine'), { recursive: true });
  if (text !== undefined) fs.writeFileSync(path.join(root, '.spine', 'product.md'), text);
  return root;
}

test('parseProduct never throws on empty, binary, CRLF, BOM and heading-only input', () => {
  const inputs = ['', Buffer.alloc(64, 0xff).toString('latin1'), doc().replace(/\n/g, '\r\n'), '﻿# x', '## Key flows', '### x', null, undefined, 42];
  for (const input of inputs) assert.doesNotThrow(() => parseProduct(input));
  assert.equal(parseProduct(doc().replace(/\n/g, '\r\n')).ok, true);
  assert.equal(parseProduct('﻿' + doc()).ok, true);
});

test('a valid six-heading file parses ok with flows', () => {
  const p = parseProduct(doc());
  assert.equal(p.ok, true);
  assert.deepEqual(p.flows[0], { name: 'Checkout', weight: 'critical', paths: ['src/checkout/**', 'src/pay*.js'], steps: ['one', 'two', 'three'], line: 10 });
});

test('missing heading yields ok false and an issue naming the heading', () => {
  const p = parseProduct(doc().replace('## Invariants\n', ''));
  assert.equal(p.ok, false);
  assert.match(p.issues[0].message, /## Invariants/);
});

test('unknown weight or empty paths drops the flow with its 1-based line', () => {
  const p = parseProduct(doc(flow('A', 'huge', 'src/**') + flow('B', 'minor', '')));
  assert.deepEqual(p.flows, []);
  assert.deepEqual(p.issues.map((i) => i.line), [10, 16]);
});

test('loadProduct states: absent, malformed, ok, trimmed', () => {
  assert.equal(loadProduct(repo(), {}, []).state, 'absent');
  const bad = loadProduct(repo('## Users\n'), {}, []);
  assert.equal(bad.state, 'malformed');
  assert.equal(bad.text, '');
  assert.equal(loadProduct(repo(doc()), {}, []).state, 'ok');
  const big = doc(flow('Checkout', 'critical', 'src/checkout/**') + flow('Other', 'minor', 'lib/**'), 'u\n'.repeat(30));
  const t = loadProduct(repo(big), { product_context_max_lines: 20 }, ['src/checkout/a.js']);
  assert.equal(t.state, 'trimmed');
  assert.ok(t.text.includes('## Glossary') && t.text.includes('## Invariants'));
  assert.ok(t.text.includes('### Checkout') && !t.text.includes('### Other'));
  assert.ok(t.leftOut.includes('## Users'));
  assert.ok(t.loadedLines <= 20);
});

test('loadProduct over 256 KiB is malformed with a size issue', () => {
  const r = loadProduct(repo(doc() + 'x'.repeat(MAX_BYTES)), {}, []);
  assert.equal(r.state, 'malformed');
  assert.match(r.issue.message, /size/);
});

test('non-UTF-8 is malformed and sha256 is over the raw bytes of a CRLF file', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.spine', 'product.md'), Buffer.from([0xff, 0xfe, 0x41]));
  assert.equal(loadProduct(root, {}, []).state, 'malformed');
  const crlf = repo('﻿' + doc().replace(/\n/g, '\r\n'));
  const r = loadProduct(crlf, {}, []);
  assert.equal(r.state, 'ok');
  const raw = fs.readFileSync(path.join(crlf, '.spine', 'product.md'));
  assert.equal(r.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('CLI: malformed writes one MEDIUM naming the heading and no INFO', (t) => {
  const { main } = require('../scripts/product-context');
  const { writeState } = require('../scripts/lib/state');
  const root = tmpDir('spine-pcli-', t);
  const runDir = path.join(root, '.spine', '20261101-cli-test');
  writeState(runDir, { id: '20261101-cli-test', stage: 'spec', status: 'active', awaiting: null, size: 'M', updated: '2026-11-01T00:00:00Z', host: 'claude-code', spine_version: '0.4.0' });
  fs.writeFileSync(path.join(root, '.spine', 'product.md'), doc().replace('## Invariants\n', ''));
  const out = main(['--run', runDir], root);
  main(['--run', runDir], root);
  assert.equal(out.state, 'malformed');
  const recs = fs.readdirSync(path.join(runDir, 'records')).map((f) => JSON.parse(fs.readFileSync(path.join(runDir, 'records', f), 'utf8')));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].severity, 'MEDIUM');
  assert.match(recs[0].claim, /## Invariants/);
});

test('CLI: product-context.md equals loadProduct().text', (t) => {
  const { main } = require('../scripts/product-context');
  const { writeState } = require('../scripts/lib/state');
  const root = repo(doc());
  const runDir = path.join(root, '.spine', '20261101-cli-test');
  writeState(runDir, { id: '20261101-cli-test', stage: 'spec', status: 'active', awaiting: null, size: 'M', updated: '2026-11-01T00:00:00Z', host: 'claude-code', spine_version: '0.4.0' });
  main(['--run', runDir], root);
  assert.equal(fs.readFileSync(path.join(runDir, 'product-context.md'), 'utf8'), loadProduct(root, { artifacts_dir: '.spine' }, []).text);
});

test('T-2b: cut sections and flows are named in leftOut, partial cuts marked', () => {
  const big = doc(flow('Checkout', 'critical', 'src/checkout/**'), 'u\n').replace('term: meaning\n', 'g\n'.repeat(40));
  const r = loadProduct(repo(big), { product_context_max_lines: 20 }, ['src/checkout/a.js']);
  assert.equal(r.state, 'trimmed');
  assert.ok(r.loadedLines <= 20);
  assert.ok(r.leftOut.includes('## Glossary (cut)'), r.leftOut.join('|'));
  assert.ok(r.leftOut.includes('## Invariants'));
  assert.ok(r.leftOut.includes('flow Checkout'));
  assert.ok(r.leftOut.includes('## Users'));
});

test('T-2b: flows dropped by parseProduct reach loadProduct flowIssues with glob null and line', () => {
  const r = loadProduct(repo(doc(flow('A', 'huge', 'src/**') + flow('B', 'minor', ''))), {}, []);
  const dropped = r.flowIssues.filter((i) => i.glob === null);
  assert.deepEqual(dropped.map((i) => [i.flow, i.line]), [['A', 10], ['B', 16]]);
  assert.match(dropped[0].message, /weight/);
});

test('T-2b: a flow is an issue only when no repo file matches, not when the change leaves it untouched', () => {
  const root = repo(doc(flow('Live', 'minor', 'lib/**') + flow('Ghost', 'minor', 'nowhere/**')));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'x.js'), '');
  const r = loadProduct(root, {}, ['unrelated.js']);
  assert.deepEqual(r.flowIssues.map((i) => i.flow), ['Ghost']);
  assert.equal(r.flowIssues[0].message, 'no matching files');
});

test('T-2b: sha256 covers the whole oversize file', () => {
  const root = repo(doc() + 'x'.repeat(MAX_BYTES + 10));
  const r = loadProduct(root, {}, []);
  assert.equal(r.state, 'malformed');
  const raw = fs.readFileSync(path.join(root, '.spine', 'product.md'));
  assert.equal(r.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
});

// T-15a
test('T-15a: leftOut names the preamble, the Key flows intro and a repeated heading', () => {
  const body = doc('intro prose\n' + flow('Checkout', 'critical', 'src/checkout/**'), 'u\n').replace('term: meaning\n', 'g\n'.repeat(40));
  const r = loadProduct(repo('preamble words\n' + body + '## Glossary\nsecond\n'), { product_context_max_lines: 20 }, ['src/checkout/a.js']);
  assert.equal(r.state, 'trimmed');
  for (const name of ['preamble', '## Key flows (intro)', '## Glossary (2)']) assert.ok(r.leftOut.includes(name), `${name} in ${r.leftOut.join('|')}`);
});

test('T-15a: flow globs are judged one by one; the flow keeps its other globs', () => {
  const root = repo(doc(flow('Mixed', 'important', 'lib/**, nowhere/**')));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'x.js'), '');
  const r = loadProduct(root, {}, ['lib/x.js']);
  assert.deepEqual(r.flowIssues.map((i) => [i.flow, i.glob, i.message]), [['Mixed', 'nowhere/**', 'no matching files']]);
  assert.equal(r.flowIssues[0].line, 10);
  assert.deepEqual(r.flowsTouched.map((f) => f.name), ['Mixed']);
});

test('T-15a: productContextFor separates absent, unreadable, and a readable product.json', () => {
  const { productContextFor } = require('../scripts/lib/product-context');
  const run = (state, pj) => {
    const d = tmpDir('spine-pcf-');
    if (state !== undefined) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
    if (pj !== undefined) fs.writeFileSync(path.join(d, 'product.json'), pj);
    return productContextFor(d);
  };
  assert.deepEqual(run({ spine_version: '0.4.0' }), { productContext: false, spineVersion: '0.4.0', state: null, unreadable: false });
  assert.equal(run({ spine_version: '0.4.0' }, JSON.stringify({ state: 'ok' })).productContext, true);
  assert.equal(run({ spine_version: '0.4.0' }, JSON.stringify({ state: 'trimmed' })).productContext, true);
  assert.equal(run({ spine_version: '0.4.0' }, JSON.stringify({ state: 'absent' })).productContext, false);
  assert.equal(run({ spine_version: '0.4.0' }, JSON.stringify({ state: 'malformed' })).productContext, false);
  assert.equal(run({}, JSON.stringify({ state: 'ok' })).spineVersion, null);
  const bad = run({ spine_version: '0.4.0' }, '{not json');
  assert.deepEqual([bad.productContext, bad.unreadable], [false, true]);
});

// T-15c item 1 (R-0220)
test('T-15c: every product line in the text carries its 1-based file line number, in ok and trimmed states', () => {
  const ok = loadProduct(repo(doc()), {}, []);
  const raw = doc().split('\n');
  ok.text.split('\n').forEach((l, i) => assert.equal(l, `${i + 1}| ${raw[i]}`));
  const big = doc(flow('Checkout', 'critical', 'src/checkout/**') + flow('Other', 'minor', 'lib/**'), 'u\n'.repeat(30));
  const all = big.split('\n');
  const t = loadProduct(repo(big), { product_context_max_lines: 20 }, ['src/checkout/a.js']);
  assert.equal(t.state, 'trimmed');
  for (const l of t.text.split('\n')) {
    const m = /^(\d+)\| (.*)$/.exec(l);
    assert.ok(m, l);
    assert.equal(all[Number(m[1]) - 1], m[2]);
  }
  assert.ok(t.text.split('\n').some((l) => /^\d+\| ## Invariants$/.test(l)));
});
