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
