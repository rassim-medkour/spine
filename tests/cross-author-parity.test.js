// tests/cross-author-parity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ca = require('../scripts/lib/cross-author');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const text = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review.workflow.js'), 'utf8');
const workflow = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', text.replace(/^export /, ''));
const parallel = (thunks) => Promise.all(thunks.map((fn) => fn()));
const pipeline = async (items, ...stages) => {
  let values = items;
  for (const s of stages) values = await Promise.all(values.map((v, i) => Promise.resolve(s(v, items[i], i))));
  return values;
};
const noop = () => {};

const PROVIDERS = [
  { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
  { id: 'mattpocock-skills:code-review', kind: 'skill', author: 'mattpocock', rank: 2, strengths: [] },
  { id: 'feature-dev:code-reviewer', kind: 'agent', author: 'anthropic', rank: 5, strengths: [] },
];

async function runWorkflow(findingsByProvider, { providers = PROVIDERS, refuted = false, devilsAdvocate = false } = {}) {
  const verifiers = [];
  let daCalled = false;
  const agent = async (prompt, opts) => {
    if (opts.label.startsWith('find:')) return { findings: findingsByProvider[opts.label.slice(5)] || [] };
    if (opts.label.startsWith('verify:')) {
      const skill = /Invoke the skill (\S+) with/.exec(prompt);
      verifiers.push(opts.agentType !== 'general-purpose' ? opts.agentType : skill ? skill[1] : null);
      return { refuted, reason: 'stub', evidence: [] };
    }
    if (opts.label === 'devils-advocate') { daCalled = true; return { findings: [] }; }
    return null;
  };
  await workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers, devilsAdvocate, runId: 'r', stage: 'review' });
  return { verifiers, daCalled };
}

function toRecords(findingsByProvider, providers = PROVIDERS) {
  let n = 0;
  return Object.entries(findingsByProvider).flatMap(([id, list]) => list.map((f) => ({ ...f, id: `R-${String(++n).padStart(4, '0')}`, stage: 'review', agent: id, provider: id, author: providers.find((p) => p.id === id).author })));
}

const HIGH = (ref, kinds = ['file']) => ({ claim: 'c', severity: 'HIGH', confidence: 0.9, evidence: kinds.map((k, i) => ({ kind: k, ref: i ? `t${i}` : ref })) });

const CASES = {
  'single author': { 'ecc:code-review': [HIGH('a.py:1')] },
  'two authors on one location': { 'ecc:code-review': [HIGH('a.py:1')], 'mattpocock-skills:code-review': [HIGH('a.py:1')] },
  'every author raised it': { 'ecc:code-review': [HIGH('a.py:1')], 'mattpocock-skills:code-review': [HIGH('a.py:1')], 'feature-dev:code-reviewer': [HIGH('a.py:1')] },
};

for (const [name, findings] of Object.entries(CASES)) {
  test(`pickVerifier matches review.workflow.js: ${name}`, async () => {
    const { verifiers } = await runWorkflow(findings);
    const plan = ca.verifierPlan(toRecords(findings), PROVIDERS);
    assert.deepEqual(plan.map((p) => (p.verifier ? p.verifier.id : null)), verifiers);
  });
}

const GATE_CASES = {
  'verified, two evidence kinds, flag on': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: false, devilsAdvocate: true }],
  'refuted': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: true, devilsAdvocate: true }],
  'one evidence kind': [{ 'ecc:code-review': [HIGH('a.py:1')] }, { refuted: false, devilsAdvocate: true }],
  'flag off': [{ 'ecc:code-review': [HIGH('a.py:1', ['file', 'test'])] }, { refuted: false, devilsAdvocate: false }],
};

for (const [name, [findings, opts]] of Object.entries(GATE_CASES)) {
  test(`daGateOpen matches review.workflow.js: ${name}`, async () => {
    const { daCalled } = await runWorkflow(findings, opts);
    const records = toRecords(findings);
    const plan = ca.verifierPlan(records, PROVIDERS);
    const verifications = plan.map((p, i) => ({ id: `R-9${String(i).padStart(3, '0')}`, stage: 'review', agent: p.verifier.id, provider: p.verifier.id, author: p.verifier.author, verifies: p.record_id, verified: !opts.refuted, claim: 'v', evidence: [{ kind: 'unverified', ref: 'v' }], confidence: 1, severity: 'INFO' }));
    assert.equal(ca.daGateOpen([...records, ...verifications], opts.devilsAdvocate).open, daCalled);
  });
}

// --- T-9: ux_finder in the review workflow (REQ-14, REQ-15, REQ-23, REQ-31, REQ-36) ---
const PRODUCT_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'product', 'product.md'), 'utf8');
const { sectionMapOf } = require('../scripts/lib/cap-record');
const { parseProduct } = require('../scripts/lib/product-context');
// What the orchestrator copies from product.json.sections into the workflow args (REQ-23).
const SECTIONS = JSON.parse(JSON.stringify(sectionMapOf(parseProduct(PRODUCT_TEXT).sections)));
const UX_CITED = { claim: 'order total can go negative', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'src/cart.tsx:9' }, { kind: 'doc', ref: 'product.md:20', note: '§Invariants' }] };
const UX_UNCITED = { claim: 'the form label was removed', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'src/form.tsx:4' }] };

async function runUx(extraArgs, uxFindings = [UX_CITED, UX_UNCITED]) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, agentType: opts.agentType, prompt });
    if (opts.label === 'ux-find') return { findings: uxFindings };
    if (opts.label.startsWith('find:')) return { findings: [] };
    if (opts.label.startsWith('verify:')) return { refuted: false, reason: 'stub', evidence: [] };
    return null;
  };
  const result = await workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers: PROVIDERS, devilsAdvocate: false, runId: 'r', stage: 'review', productSections: SECTIONS, ...extraArgs });
  return { result, calls };
}

test('ux-find is dispatched only with uxFinder true and productText (REQ-14)', async () => {
  for (const extra of [{}, { uxFinder: true }, { productText: PRODUCT_TEXT }, { uxFinder: false, productText: PRODUCT_TEXT }]) {
    const { calls } = await runUx(extra);
    assert.equal(calls.some((c) => c.label === 'ux-find'), false, JSON.stringify(Object.keys(extra)));
  }
  const { calls } = await runUx({ uxFinder: true, productText: PRODUCT_TEXT });
  const ux = calls.filter((c) => c.label === 'ux-find');
  assert.equal(ux.length, 1);
  assert.equal(ux[0].agentType, 'spine:ux-finder');
  assert.ok(ux[0].prompt.includes('PRODUCT CONTEXT'));
});

test('an uncited ux-find HIGH is capped and never verified; a cited one is verified by a non-spine author (REQ-15, REQ-31)', async () => {
  const { result, calls } = await runUx({ uxFinder: true, productText: PRODUCT_TEXT });
  const verifies = calls.filter((c) => c.label.startsWith('verify:'));
  assert.equal(verifies.length, 1);
  assert.ok(verifies[0].prompt.includes('order total can go negative'));
  assert.notEqual(verifies[0].agentType, 'spine:ux-finder');
  const ux = result.records.filter((r) => r.agent === 'spine:ux-finder');
  const cited = ux.find((r) => r.claim.includes('order total'));
  const capped = ux.find((r) => r.claim.includes('form label'));
  assert.equal(cited.severity, 'HIGH');
  assert.equal(cited.verified, true);
  assert.equal(capped.severity, 'MEDIUM');
  assert.equal(capped.confidence, 0.5);
  assert.equal(capped.verified, false);
  assert.match(capped.resolution.text, /^assumption to confirm: /);
});

test('the cap runs before the first verifier call (REQ-31)', async () => {
  const order = [];
  const agent = async (prompt, opts) => {
    order.push(opts.label);
    if (opts.label === 'ux-find') return { findings: [UX_UNCITED] };
    if (opts.label.startsWith('find:')) return { findings: [] };
    return null;
  };
  const { result } = { result: await workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers: PROVIDERS, runId: 'r', stage: 'review', uxFinder: true, productText: PRODUCT_TEXT, productSections: SECTIONS }) };
  assert.equal(order.some((l) => l.startsWith('verify:')), false);
  assert.equal(result.records[0].severity, 'MEDIUM');
});

test('without uxFinder the record list equals the 0.3.2 run on the same stubs (AC-12)', async () => {
  const a = await runUx({}, []);
  const b = await runUx({ productText: PRODUCT_TEXT }, []);
  assert.deepEqual(a.result.records, b.result.records);
  assert.deepEqual(a.calls.map((c) => c.label), b.calls.map((c) => c.label));
});

test('the workflow copy of the cap equals scripts/lib/cap-record.js record by record, in order (REQ-23, R-0132)', async () => {
  const { capProductRecord } = require('../scripts/lib/cap-record');
  const repoDocs = ['README.md', 'docs/x.md'];
  const ctx = { productSections: SECTIONS, repoHas: (p) => repoDocs.includes(p) };
  const ev = (kind, ref, note) => ({ kind, ref, ...(note ? { note } : {}) });
  const docs = [
    ev('file', 'a.js:1'), ev('doc', 'README.md'), ev('doc', 'docs/x.md:4'), ev('doc', 'missing.md'), ev('doc', '#12'), ev('doc', 'o/r#3'),
    ev('doc', 'https://www.w3.org/WAI/WCAG22/'), ev('doc', 'src/a.js'), ev('doc', 'product.md:20', '§Invariants'), ev('doc', 'product.md:18', '§Invariants'),
    ev('doc', 'product.md:19', '§Invariants'), ev('doc', 'product.md:20', '§Goals'), ev('doc', 'product.md:999', '§Invariants'), ev('doc', 'product.md:20'),
    ev('doc', '.spine/product.md:20', '§Invariants'), ev('doc', '.spine/product.md'), ev('doc', 'product.md', '§Invariants'),
    ev('doc', 'product.md:20-22', '§Invariants'), ev('doc', 'product.md:20-23', '§Invariants'), ev('doc', 'product.md:17-20', '§Invariants'),
  ];
  const mk = (e, i, severity = 'HIGH') => ({ claim: 'c' + i, severity, confidence: 0.9, evidence: [ev('file', 'src/f' + i + '.ts:1'), e] });
  const all = docs.map((e, i) => mk(e, i)).concat([mk(ev('file', 'a.js:1'), docs.length, 'LOW')]);
  const { result } = await runUx({ uxFinder: true, productText: PRODUCT_TEXT, repoDocs }, all);
  const got = result.records.filter((r) => r.agent === 'spine:ux-finder');
  const wants = all.map((r) => capProductRecord({ ...r, agent: 'spine:ux-finder' }, ctx));
  const strong = (r) => r.severity === 'CRITICAL' || r.severity === 'HIGH';
  const want = wants.filter(strong).concat(wants.filter((r) => !strong(r)));
  assert.equal(got.length, want.length);
  want.forEach((w, i) => {
    assert.deepEqual([got[i].claim, got[i].severity, got[i].confidence, got[i].resolution], [w.claim, w.severity, w.confidence, w.resolution || null], w.claim);
  });
});

test('cross-author.js keeps spine:ux-finder records as findings; a cited HIGH needs another author, a capped one needs none (REQ-15, R-0131)', () => {
  const rec = (id, agent, extra = {}) => ({ id, stage: 'review', agent, provider: agent, author: 'spine', claim: 'c', evidence: [{ kind: 'file', ref: 'a.tsx:1' }], confidence: 0.9, severity: 'HIGH', ...extra });
  const cited = rec('R-0001', 'spine:ux-finder');
  const capped = rec('R-0002', 'spine:ux-finder', { evidence: [{ kind: 'file', ref: 'b.tsx:2' }], severity: 'MEDIUM', resolution: { kind: 'question', text: 'assumption to confirm: x' } });
  assert.equal(ca.isFinding(cited), true);
  assert.equal(ca.isFinding(rec('R-0003', 'spine:orchestrator')), false);
  const plan = ca.verifierPlan([cited, capped], PROVIDERS);
  assert.deepEqual(plan.map((p) => p.record_id), ['R-0001']);
  assert.ok(plan[0].verifier && plan[0].verifier.author !== 'spine');
  const sameAuthor = { id: 'R-0010', stage: 'review', agent: 'spine:ux-finder', provider: 'spine:ux-finder', author: 'spine', verifies: 'R-0001', verified: true, claim: 'v', evidence: [{ kind: 'unverified', ref: 'v' }], confidence: 1, severity: 'INFO' };
  assert.equal(ca.checkCrossAuthor([cited, sameAuthor]).length, 1);
  assert.equal(ca.CAP_PREFIX, require('../scripts/lib/cap-record').CAP_PREFIX);
});

test('a capped ux-find record is never merged with an uncapped provider finding at the same file:line (R-0136)', async () => {
  const uncappedUx = { claim: 'ux cited', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'src/same.tsx:5' }, { kind: 'doc', ref: 'product.md:20', note: '§Invariants' }] };
  const cappedUx = { claim: 'ux uncited', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'src/same.tsx:5' }] };
  const prov = (ref) => ({ claim: 'provider says', severity: 'LOW', confidence: 0.8, evidence: [{ kind: 'file', ref }] });
  const run = async (ux) => {
    const agent = async (prompt, opts) => {
      if (opts.label === 'ux-find') return { findings: [ux] };
      if (opts.label === 'find:ecc:code-review') return { findings: [prov('src/same.tsx:5')] };
      if (opts.label.startsWith('find:')) return { findings: [] };
      if (opts.label.startsWith('verify:')) return { refuted: false, reason: 'stub', evidence: [] };
      return null;
    };
    return workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers: PROVIDERS, runId: 'r', stage: 'review', uxFinder: true, productText: PRODUCT_TEXT, productSections: SECTIONS });
  };
  const merged = await run(uncappedUx);
  assert.equal(merged.records.length, 1, 'two uncapped findings at one location merge');
  const apart = await run(cappedUx);
  assert.equal(apart.records.length, 2, 'a capped ux record stays apart');
});

test('a ux-find failure is listed in failed_providers and verdict_note with and without model routing (R-0135)', async () => {
  for (const models of [undefined, { tier: 'branch', tier_source: 'tree', kill_switch: false, class_ids: {}, roles: { ux_finder: { class: 'mid', model: 'sonnet', source: 'requested' } } }]) {
    const agent = async (prompt, opts) => {
      if (opts.label === 'ux-find') throw new Error('boom');
      if (opts.label.startsWith('find:')) return { findings: [] };
      return null;
    };
    const result = await workflow(agent, parallel, pipeline, noop, noop, { diff: 'x', changedFiles: [], providers: PROVIDERS, runId: 'r', stage: 'review', uxFinder: true, productText: PRODUCT_TEXT, productSections: SECTIONS, ...(models ? { models } : {}) });
    assert.deepEqual(result.failed_providers, ['ux-find']);
    assert.match(result.verdict_note, /^1 of 4 providers failed$/);
    if (models) assert.ok(result.records.some((r) => r.agent === 'spine:ux-finder' && /agent did not run: ux-find/.test(r.claim)));
  }
});
