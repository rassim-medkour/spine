// tests/cross-author.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ca = require('../scripts/lib/cross-author');

const P = [
  { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1 },
  { id: 'mattpocock-skills:code-review', kind: 'skill', author: 'mattpocock', rank: 2 },
  { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5 },
];
const f = (id, author, severity, ref, extra = {}) => ({ id, stage: 'review', agent: `${author}:x`, provider: `${author}:x`, author, claim: 'c', evidence: [{ kind: 'file', ref }], confidence: 0.9, severity, ...extra });

test('evidenceKey normalizes file:line refs like the workflow', () => {
  assert.equal(ca.evidenceKey({ evidence: [{ ref: 'a.py:10-20' }], claim: 'x' }), 'a.py:10');
  assert.equal(ca.evidenceKey({ evidence: [{ ref: 'Some Doc' }], claim: 'x' }), 'some doc');
});
test('pickVerifier picks the best-ranked provider whose author differs from every raising author', () => {
  const groups = ca.groupFindings([f('R-0001', 'ecc', 'HIGH', 'a.py:1'), f('R-0002', 'mattpocock', 'MEDIUM', 'a.py:1')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].severity, 'HIGH');
  assert.equal(ca.pickVerifier(groups[0], P).id, 'feature-dev:code-reviewer');
});
test('pickVerifier returns null when no independent author exists', () => {
  const [g] = ca.groupFindings([f('R-0001', 'ecc', 'HIGH', 'a.py:1'), f('R-0002', 'anthropic', 'HIGH', 'a.py:1')]);
  assert.equal(ca.pickVerifier(g, P.filter((p) => p.author !== 'mattpocock')), null);
});
test('verifierPlan covers only CRITICAL and HIGH groups and notes missing authors', () => {
  const plan = ca.verifierPlan([f('R-0001', 'ecc', 'HIGH', 'a.py:1'), f('R-0002', 'ecc', 'LOW', 'b.py:1')], [P[0]]);
  assert.deepEqual(plan, [{ record_id: 'R-0001', record_ids: ['R-0001'], severity: 'HIGH', verifier: null, note: 'no independent author available' }]);
});
test('checkCrossAuthor fails when a verifier shares an author with any raising author', () => {
  const recs = [f('R-0001', 'ecc', 'HIGH', 'a.py:1'), f('R-0002', 'mattpocock', 'HIGH', 'a.py:1'), { ...f('R-0003', 'mattpocock', 'INFO', 'a.py:1'), verifies: 'R-0001', verified: true }];
  assert.deepEqual(ca.checkCrossAuthor(recs), ['R-0003 verifies R-0001 with the same author mattpocock']);
});
test('checkCrossAuthor passes a different-author verifier and flags unknown targets', () => {
  const ok = [f('R-0001', 'ecc', 'HIGH', 'a.py:1'), { ...f('R-0002', 'anthropic', 'INFO', 'a.py:1'), verifies: 'R-0001', verified: true }];
  assert.deepEqual(ca.checkCrossAuthor(ok), []);
  assert.deepEqual(ca.checkCrossAuthor([{ ...f('R-0002', 'anthropic', 'INFO', 'x:1'), verifies: 'R-0009' }]), ['R-0002 verifies unknown record R-0009']);
});
test('checkCrossAuthor flags a no-independent-author finding counted as verified', () => {
  const recs = [f('R-0001', 'ecc', 'HIGH', 'a.py:1'), { ...f('R-0002', 'spine', 'INFO', 'a.py:1'), verifies: 'R-0001', verified: true, verifier_note: 'no independent author available' }];
  assert.deepEqual(ca.checkCrossAuthor(recs), ['R-0002 counts R-0001 as verified without an independent author']);
});
test('checkCrossAuthor resolves authors from provider ids when records lack author', () => {
  const authorOf = ca.authorIndex([{ review: P }]);
  const recs = [{ ...f('R-0001', 'ecc', 'HIGH', 'a.py:1'), author: undefined, provider: 'ecc:code-review' }, { ...f('R-0002', 'ecc', 'INFO', 'a.py:1'), author: undefined, provider: 'ecc:code-review', verifies: 'R-0001' }];
  assert.deepEqual(ca.checkCrossAuthor(recs, authorOf), ['R-0002 verifies R-0001 with the same author ecc']);
});
test('daGateOpen needs the flag, no refuted strong finding, and two evidence kinds', () => {
  const hi = { ...f('R-0001', 'ecc', 'HIGH', 'a.py:1'), evidence: [{ kind: 'file', ref: 'a.py:1' }, { kind: 'test', ref: 't' }] };
  const ver = (ok, note) => ({ ...f('R-0002', 'anthropic', 'INFO', 'a.py:1'), verifies: 'R-0001', verified: ok, verifier_note: note || null });
  assert.equal(ca.daGateOpen([hi, ver(true)], true).open, true);
  assert.equal(ca.daGateOpen([hi, ver(true)], false).open, false);
  assert.equal(ca.daGateOpen([hi, ver(false)], true).open, false);
  assert.equal(ca.daGateOpen([f('R-0001', 'ecc', 'LOW', 'a.py:1')], true).open, false);
});
test('finding with no independent author is unverified but not refuted', () => {
  const hi = { ...f('R-0001', 'ecc', 'HIGH', 'a.py:1'), evidence: [{ kind: 'file', ref: 'a.py:1' }, { kind: 'test', ref: 't' }] };
  const none = { ...f('R-0002', 'spine', 'INFO', 'a.py:1'), verifies: 'R-0001', verified: false, verifier_note: 'no independent author available' };
  assert.equal(ca.daGateOpen([hi, none], true).open, true);
});
