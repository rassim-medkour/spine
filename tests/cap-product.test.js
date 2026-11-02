'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmpDir } = require('./helpers/tmp');
const { writeState } = require('../scripts/lib/state');
const { parseProduct } = require('../scripts/lib/product-context');
const { runStatus } = require('../scripts/run-status');
const { writeRecords } = require('../scripts/lib/record-writer');
const cap = require('../scripts/lib/cap-record');

const PRODUCT = [
  '## Users', 'Shoppers.', '', '## Goals', 'Fast checkout.', '', '## Glossary', 'Cart: items.', '',
  '## Invariants', 'A paid order is never deleted.', '', '## Key flows', '### Checkout', 'weight: critical', 'paths: src/**', '1. Pay', '', '## UX principles', 'Say what happened.',
].join('\n');
const sectionsOf = (text) => parseProduct(text).sections;
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

const ctx = (text = PRODUCT, files = ['README.md', 'docs/x.md']) => ({ productSections: sectionsOf(text), repoHas: (p) => files.includes(p) });
const rec = (evidence, extra = {}) => ({
  id: 'R-0001', stage: 'review', agent: 'spine:ux-finder', claim: 'Form field has no label', evidence,
  confidence: 0.9, severity: 'HIGH', dissent: null, resolution: null, alternatives: [], ...extra,
});
const FILE = { kind: 'file', ref: 'src/Form.tsx:10' };

test('a product record with only file evidence is capped to 0.5, MEDIUM and a question', () => {
  const out = cap.capProductRecord(rec([FILE]), ctx());
  assert.equal(out.confidence, 0.5);
  assert.equal(out.severity, 'MEDIUM');
  assert.equal(out.resolution.kind, 'question');
  assert.ok(out.resolution.text.startsWith('assumption to confirm: '));
  assert.equal(cap.isCapped(out), true);
});

test('doc to README.md, docs/x.md:4, #12, owner/repo#3 and a WCAG URL each pass', () => {
  for (const ref of ['README.md', 'docs/x.md:4', '#12', 'owner/repo#3', 'https://www.w3.org/TR/WCAG22/#labels-or-instructions']) {
    const r = rec([FILE, { kind: 'doc', ref }]);
    assert.equal(cap.capProductRecord(r, ctx()), r, ref);
  }
});

test('doc to a .js path, or to a doc file that does not exist, is capped', () => {
  assert.equal(cap.isCapped(cap.capProductRecord(rec([{ kind: 'doc', ref: 'src/a.js:3' }]), ctx())), true);
  assert.equal(cap.isCapped(cap.capProductRecord(rec([{ kind: 'doc', ref: 'docs/missing.md' }]), ctx())), true);
});

test('file, test and command entries never qualify even with a doc-looking ref', () => {
  for (const kind of ['file', 'test', 'command']) {
    assert.equal(cap.isCapped(cap.capProductRecord(rec([{ kind, ref: 'README.md' }]), ctx())), true, kind);
  }
});

test('product.md:<line> to a blank or heading line is capped, to a body line in the named section passes', () => {
  const blank = lineOf(PRODUCT, 'A paid order') + 1;
  const heading = lineOf(PRODUCT, '## Invariants');
  const body = lineOf(PRODUCT, 'A paid order');
  const cite = (line, note = '§Invariants') => rec([FILE, { kind: 'doc', ref: `product.md:${line}`, note }]);
  assert.equal(cap.isCapped(cap.capProductRecord(cite(blank), ctx())), true);
  assert.equal(cap.isCapped(cap.capProductRecord(cite(heading), ctx())), true);
  assert.equal(cap.isCapped(cap.capProductRecord(cite(9999), ctx())), true);
  const ok = cite(body);
  assert.equal(cap.capProductRecord(ok, ctx()), ok);
});

test('product.md:<line> outside the named section, with no section note, or with no sections is capped', () => {
  const body = lineOf(PRODUCT, 'A paid order');
  assert.equal(cap.isCapped(cap.capProductRecord(rec([FILE, { kind: 'doc', ref: `product.md:${body}`, note: '§Goals' }]), ctx())), true);
  assert.equal(cap.isCapped(cap.capProductRecord(rec([FILE, { kind: 'doc', ref: `product.md:${body}` }]), ctx())), true);
  assert.equal(cap.isCapped(cap.capProductRecord(rec([FILE, { kind: 'doc', ref: `product.md:${body}`, note: '§Invariants' }]), { productSections: null, repoHas: () => false })), true);
});

test('a line inside the named section passes after the section moved', () => {
  const moved = ['# Product', 'a', 'b', 'c', 'd', 'e', PRODUCT].join('\n');
  const body = lineOf(moved, 'A paid order');
  const r = rec([FILE, { kind: 'doc', ref: `.spine/product.md:${body}`, note: '§Invariants' }]);
  assert.equal(cap.capProductRecord(r, ctx(moved)), r);
  // cited at the pre-move number, which is now inside the Goals/Glossary area of the moved text: not in Invariants
  const stale = rec([FILE, { kind: 'doc', ref: `.spine/product.md:${lineOf(PRODUCT, 'A paid order')}`, note: '§Invariants' }]);
  assert.equal(cap.isCapped(cap.capProductRecord(stale, ctx(moved))), true);
});

test('capping twice equals capping once', () => {
  const once = cap.capProductRecord(rec([FILE]), ctx());
  assert.deepEqual(cap.capProductRecord(once, ctx()), once);
});

test('a record from spine:synthesis is returned unchanged', () => {
  const r = rec([FILE], { agent: 'spine:synthesis' });
  assert.equal(cap.capProductRecord(r, ctx()), r);
});

test('an uncited record that already carries a question resolution keeps its text behind the prefix', () => {
  const r = rec([FILE], { resolution: { kind: 'question', text: 'Is guest checkout allowed?' } });
  const out = cap.capProductRecord(r, ctx());
  assert.equal(out.resolution.text, 'assumption to confirm: Is guest checkout allowed?');
  assert.equal(cap.isCapped(out), true);
  assert.equal(r.resolution.text, 'Is guest checkout allowed?', 'input not mutated');
});

test('the cap never raises confidence or severity', () => {
  const out = cap.capProductRecord(rec([FILE], { confidence: 0.2, severity: 'LOW' }), ctx());
  assert.equal(out.confidence, 0.2);
  assert.equal(out.severity, 'LOW');
});

function productRun(productText, sha) {
  const root = tmpDir('spine-cap-');
  const dir = path.join(root, '.spine', '20260920-demo');
  writeState(dir, { id: '20260920-demo', stage: 'review', status: 'active', awaiting: null });
  fs.writeFileSync(path.join(root, 'README.md'), '# r\n');
  if (productText !== null) {
    fs.writeFileSync(path.join(root, '.spine', 'product.md'), productText);
    const hash = sha || crypto.createHash('sha256').update(productText).digest('hex');
    fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ state: 'ok', sha256: hash }));
  }
  return dir;
}
const readRec = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'));

test('writeRecords applies the cap on write and lets a verified citation through', () => {
  const dir = productRun(PRODUCT);
  const body = lineOf(PRODUCT, 'A paid order');
  const [a, b, c] = writeRecords(dir, [
    rec([FILE]),
    rec([FILE, { kind: 'doc', ref: `product.md:${body}`, note: '§Invariants' }]),
    rec([FILE, { kind: 'doc', ref: 'README.md' }]),
  ]);
  assert.equal(readRec(dir, a).severity, 'MEDIUM');
  assert.equal(readRec(dir, b).severity, 'HIGH');
  assert.equal(readRec(dir, c).severity, 'HIGH');
});

test('cap applies to a product.md citation when product.md hash differs from product.json', () => {
  const dir = productRun(PRODUCT, 'deadbeef');
  const body = lineOf(PRODUCT, 'A paid order');
  const [id] = writeRecords(dir, [rec([FILE, { kind: 'doc', ref: `product.md:${body}`, note: '§Invariants' }])]);
  assert.equal(readRec(dir, id).severity, 'MEDIUM');
});

test('cap_fired counts per role and cap_line names the ratio', () => {
  const dir = productRun(null);
  writeRecords(dir, [rec([FILE]), rec([FILE, { kind: 'doc', ref: 'README.md' }]), rec([FILE], { agent: 'spine:product-lens' })]);
  const s = runStatus(dir);
  assert.deepEqual(s.cap_fired, { product_lens: 1, ux_finder: 1 });
  assert.equal(s.cap_line, 'product cap: 1 of 1 product_lens findings uncited, 1 of 2 ux_finder findings uncited, no product.md');
});

test('cap_line and cap_fired are omitted when no product record exists', () => {
  const dir = productRun(null);
  const s = runStatus(dir);
  assert.equal('cap_line' in s, false, 'key omitted so absent-product output stays 0.3.2');
});
