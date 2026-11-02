'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const load = (name) => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args',
  fs.readFileSync(path.join(__dirname, '..', 'workflows', `${name}.workflow.js`), 'utf8').replace(/^export /, ''));
const parallel = (thunks) => Promise.all(thunks.map((fn) => Promise.resolve().then(fn).catch(() => null)));
const pipeline = async (items, ...stages) => {
  let values = items;
  for (const s of stages) values = await Promise.all(values.map((v, i) => (v === null && s !== stages[0] ? null : Promise.resolve().then(() => s(v, items[i], i)).catch(() => null))));
  return values;
};
const noop = () => {};
const PROVIDERS = [
  { id: 'ecc:code-review', kind: 'skill', author: 'ecc', rank: 1, strengths: [] },
  { id: 'mattpocock-skills:code-review', kind: 'skill', author: 'mattpocock', rank: 2, strengths: [] },
];
const HIGH = { claim: 'c', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'a.js:1' }, { kind: 'test', ref: 't' }] };
const MODELS = (over = {}) => ({
  tier: 'trunk', tier_source: 'tree', kill_switch: false, class_ids: { cheap: 'haiku', mid: 'sonnet', top: 'opus' },
  roles: { implementer: { class: 'mid', model: 'sonnet', source: 'requested' }, finder: { class: 'top', model: 'opus', source: 'requested' },
    verifier: { class: 'top', model: 'opus', source: 'requested' }, devils_advocate: { class: 'top', model: 'opus', source: 'requested' },
    spec_lens: { class: 'top', model: 'opus', source: 'requested' }, synthesis: { class: 'mid', model: 'sonnet', source: 'requested' },
    boundary_checker: { class: 'mid', model: 'sonnet', source: 'requested' }, ...over },
});

function recorder(answer) {
  const calls = [];
  const agent = async (prompt, opts) => { calls.push({ label: opts.label, opts }); return answer(opts, calls); };
  return { agent, calls };
}
const reviewAnswer = (opts) => {
  if (opts.label.startsWith('find:')) return { findings: opts.label === 'find:ecc:code-review' ? [HIGH] : [] };
  if (opts.label.startsWith('verify:')) return { refuted: false, reason: 'ok', evidence: [] };
  return { findings: [] };
};
const reviewArgs = (extra) => ({ diff: 'x', changedFiles: [], providers: PROVIDERS, devilsAdvocate: true, runId: 'r', stage: 'review', ...extra });

test('review: without args.models every agent() option equals 0.3.0 and the return is unchanged (REQ-24)', async () => {
  const a = recorder(reviewAnswer);
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({}));
  assert.deepEqual(a.calls.map((c) => c.opts), [
    { label: 'find:ecc:code-review', phase: 'Find', schema: a.calls[0].opts.schema, agentType: 'general-purpose' },
    { label: 'find:mattpocock-skills:code-review', phase: 'Find', schema: a.calls[1].opts.schema, agentType: 'general-purpose' },
    { label: 'verify:0', phase: 'Verify', schema: a.calls[2].opts.schema, agentType: 'general-purpose' },
    { label: 'devils-advocate', phase: 'Dissent', schema: a.calls[3].opts.schema, agentType: 'spine:devils-advocate' },
  ]);
  for (const r of out.records) for (const k of ['model', 'verifier_model', 'model_note']) assert.ok(!(k in r), k);
  for (const f of out.findings) assert.ok(!('verify_label' in f));
});

test('review: opts.model per label from args.models (REQ-24)', async () => {
  const a = recorder(reviewAnswer);
  await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS({ verifier: { class: 'mid', model: 'sonnet', source: 'requested' } }) }));
  const byLabel = Object.fromEntries(a.calls.map((c) => [c.label, c.opts.model]));
  assert.deepEqual(byLabel, { 'find:ecc:code-review': 'opus', 'find:mattpocock-skills:code-review': 'opus', 'verify:0': 'opus', 'devils-advocate': 'opus' });
  // verify:0 was raised from sonnet to opus by the in-workflow floor (REQ-25)
});

test('review: records carry model, verifier_model with floor-raised source (REQ-27)', async () => {
  const a = recorder(reviewAnswer);
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS({ verifier: { class: 'cheap', model: 'haiku', source: 'requested' } }) }));
  const r = out.records.find((x) => x.severity === 'HIGH');
  assert.deepEqual(r.model, { role: 'finder', tier: 'trunk', tier_source: 'tree', class: 'top', requested: 'opus', source: 'requested' });
  assert.deepEqual(r.verifier_model, { role: 'verifier', tier: 'trunk', tier_source: 'tree', class: 'top', requested: 'opus', source: 'floor-raised', reason: 'policy_clamped: raised from cheap to top (finder class)' });
  assert.equal('model_note' in r, false);
});

test('review: kill switch passes no model anywhere and records source inherit (REQ-22)', async () => {
  const inherit = Object.fromEntries(['implementer', 'finder', 'verifier', 'devils_advocate', 'spec_lens', 'synthesis', 'boundary_checker'].map((k) => [k, { class: 'inherit', model: null, source: 'inherit' }]));
  const a = recorder(reviewAnswer);
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: { tier: 'trunk', tier_source: 'tree', kill_switch: true, class_ids: { cheap: 'haiku', mid: 'sonnet', top: 'opus' }, roles: inherit } }));
  assert.ok(a.calls.every((c) => !('model' in c.opts)));
  assert.ok(out.records.every((r) => !r.model || r.model.source === 'inherit'));
});

test('review: unavailable model retries once on the session model (owner decision)', async () => {
  for (const failure of ['throw', 'null']) {
    const a = recorder((opts) => {
      if (opts.label === 'verify:0' && opts.model) { if (failure === 'throw') throw new Error('unknown model'); return null; }
      return reviewAnswer(opts);
    });
    const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS() }));
    const v = a.calls.filter((c) => c.label === 'verify:0');
    assert.equal(v.length, 2);
    assert.equal(v[0].opts.model, 'opus');
    assert.ok(!('model' in v[1].opts));
    const r = out.records.find((x) => x.severity === 'HIGH');
    assert.equal(r.verifier_model.source, 'session-fallback');
    assert.equal(r.model_note, 'verifier below finder strength'); // REQ-28: trunk, finder top, verifier on session
    assert.equal(a.calls.some((c) => c.label === 'devils-advocate'), false); // weak verification closes the DA gate
  }
});

test('review: an agent that returns null after the retry becomes an INFO did-not-run record (REQ-36)', async () => {
  const a = recorder((opts) => (opts.label === 'find:mattpocock-skills:code-review' ? null : reviewAnswer(opts)));
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS() }));
  const dn = out.records.filter((r) => /^agent did not run/.test(r.claim));
  assert.equal(dn.length, 1);
  assert.equal(dn[0].severity, 'INFO');
  assert.equal(dn[0].claim, 'agent did not run: find:mattpocock-skills:code-review');
  assert.equal(dn[0].model.source, 'session-fallback');
});

test('review: malformed args.models is ignored (Review Focus 1)', async () => {
  for (const models of ['opus', ['x'], { roles: 'x' }, { roles: { finder: { model: 42 } } }]) {
    const base = recorder(reviewAnswer);
    const bad = recorder(reviewAnswer);
    const outBase = await load('review')(base.agent, parallel, pipeline, noop, noop, reviewArgs({}));
    const outBad = await load('review')(bad.agent, parallel, pipeline, noop, noop, reviewArgs({ models }));
    assert.deepEqual(bad.calls.map((c) => ('model' in c.opts)), base.calls.map(() => false));
    if (typeof models !== 'object' || Array.isArray(models) || typeof models.roles !== 'object') assert.deepEqual(outBad, outBase);
  }
});

test('review: model choice never changes which provider verifies (REQ-29)', async () => {
  const a = recorder(reviewAnswer);
  const b = recorder(reviewAnswer);
  await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({}));
  await load('review')(b.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS() }));
  const who = (calls) => calls.filter((c) => c.label.startsWith('verify:')).map((c) => c.opts.agentType);
  assert.deepEqual(who(b.calls).slice(0, 1), who(a.calls));
});

test('review: a weak verification is not recorded as verified (REQ-28)', async () => {
  const a = recorder((opts) => {
    if (opts.label === 'verify:0' && opts.model) return null;
    return reviewAnswer(opts);
  });
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS() }));
  const r = out.records.find((x) => x.severity === 'HIGH');
  assert.equal(r.verified, false);
  assert.equal(r.model_note, 'verifier below finder strength');
});

test('review: did-not-run records name a real agent and carry a valid model block', async () => {
  const { validateRecord } = require('../scripts/lib/validate');
  const { validateModelBlock } = require('../scripts/lib/model-policy');
  const a = recorder((opts) => (opts.label === 'verify:0' ? null : reviewAnswer(opts)));
  const out = await load('review')(a.agent, parallel, pipeline, noop, noop, reviewArgs({ models: MODELS() }));
  const dn = out.records.filter((r) => /^agent did not run/.test(r.claim));
  assert.deepEqual(dn.map((r) => r.agent), ['spine:verifier']);
  for (const r of dn) {
    assert.deepEqual(validateRecord(r), []);
    assert.deepEqual(validateModelBlock(r.model), []);
  }
});

const implArgs = (extra) => ({ tickets: [{ id: 'T-1', title: 't', spec_section: 's', acceptance: ['REQ-1'], files: [] }], specText: 's', planText: 'p', runId: 'r',
  implementProviders: [], reviewProviders: PROVIDERS, ...extra });
const implAnswer = (opts) => (opts.label.startsWith('implement:')
  ? { implemented: true, summary: 's', commits: ['abc'], tests_run: 't', blockers: [] }
  : { pass: false, issues: [{ claim: 'x', severity: 'MEDIUM', evidence: [{ kind: 'file', ref: 'a.js:1' }] }] });

test('implement: without args.models options and return equal 0.3.0 (REQ-24)', async () => {
  const a = recorder(implAnswer);
  const out = await load('implement')(a.agent, parallel, pipeline, noop, noop, implArgs({}));
  assert.deepEqual(a.calls.map((c) => [c.label, Object.keys(c.opts).sort()]), [
    ['implement:T-1', ['agentType', 'label', 'phase', 'schema']],
    ['spec-review:T-1', ['agentType', 'label', 'phase', 'schema']],
    ['quality-review:T-1', ['agentType', 'label', 'phase', 'schema']],
  ]);
  assert.ok(out.results[0].records.every((r) => !('model' in r)));
});

test('implement: implementer and both reviewers get their role models (REQ-10, REQ-24)', async () => {
  const a = recorder(implAnswer);
  const out = await load('implement')(a.agent, parallel, pipeline, noop, noop, implArgs({ models: MODELS() }));
  assert.deepEqual(Object.fromEntries(a.calls.map((c) => [c.label, c.opts.model])), { 'implement:T-1': 'sonnet', 'spec-review:T-1': 'opus', 'quality-review:T-1': 'opus' });
  assert.ok(out.results[0].records.every((r) => r.model.role === 'finder' && r.model.requested === 'opus'));
});

test('implement: an implementer that never ran yields a did-not-run record (REQ-36)', async () => {
  const a = recorder((opts) => (opts.label.startsWith('implement:') ? null : implAnswer(opts)));
  const out = await load('implement')(a.agent, parallel, pipeline, noop, noop, implArgs({ models: MODELS() }));
  assert.equal(out.results[0].records.filter((r) => r.claim === 'agent did not run: implement:T-1').length, 1);
});

test('implement: a reviewer that threw or returned nothing yields a did-not-run record (REQ-36, REQ-37)', async () => {
  const { validateRecord } = require('../scripts/lib/validate');
  const { validateModelBlock } = require('../scripts/lib/model-policy');
  for (const fail of [() => null, () => { throw new Error('boom'); }]) {
    const a = recorder((opts) => (opts.label === 'spec-review:T-1' || opts.label === 'quality-review:T-1' ? fail() : implAnswer(opts)));
    const out = await load('implement')(a.agent, parallel, pipeline, noop, noop, implArgs({ models: MODELS() }));
    const dn = out.results[0].records.filter((r) => /^agent did not run/.test(r.claim));
    assert.deepEqual(dn.map((r) => r.claim).sort(), ['agent did not run: quality-review:T-1', 'agent did not run: spec-review:T-1']);
    assert.equal(new Set(dn.map((r) => r.id)).size, 2);
    for (const r of dn) {
      assert.deepEqual(validateRecord(r), []);
      assert.deepEqual(validateModelBlock(r.model), []);
    }
  }
});

test('under inherit no model was requested, so an agent that did not run gets no record (0.3.0 behaviour)', async () => {
  const inherit = Object.fromEntries(['implementer', 'finder', 'verifier', 'devils_advocate', 'spec_lens', 'synthesis', 'boundary_checker'].map((r) => [r, { class: 'inherit', model: null, source: 'inherit' }]));
  const none = { tier: 'trunk', tier_source: 'tree', kill_switch: false, class_ids: {}, roles: inherit };
  const dnOf = (records) => records.filter((r) => /^agent did not run/.test(r.claim));
  const r1 = recorder((opts) => (opts.label.startsWith('find:') ? null : reviewAnswer(opts)));
  assert.equal(dnOf((await load('review')(r1.agent, parallel, pipeline, noop, noop, reviewArgs({ models: none }))).records).length, 0);
  const r2 = recorder((opts) => { if (opts.label.endsWith('-review:T-1')) throw new Error('x'); return implAnswer(opts); });
  assert.equal(dnOf((await load('implement')(r2.agent, parallel, pipeline, noop, noop, implArgs({ models: none }))).results[0].records).length, 0);
  const r3 = recorder((opts) => (opts.label.startsWith('implement:') ? null : implAnswer(opts)));
  assert.equal(dnOf((await load('implement')(r3.agent, parallel, pipeline, noop, noop, implArgs({ models: none }))).results[0].records).length, 0);
  const r4 = recorder((opts) => (opts.label === 'synthesis' ? null : specAnswer(opts)));
  assert.equal(dnOf((await load('spec')(r4.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], models: none })).records).length, 0);
});

const specAnswer = (opts) => (opts.label.startsWith('lens:')
  ? { requirements: ['r'], risks: [], questions: [], assumptions: [] }
  : { summary: 's', requirements: [], error_paths: [], data_and_migrations: [], test_anchors: [], assumptions: [], out_of_scope: [], dissent: [] });

test('spec: without args.models options and return equal 0.3.0 (REQ-24)', async () => {
  const a = recorder(specAnswer);
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain', 'security'] });
  assert.deepEqual(a.calls.map((c) => [c.label, Object.keys(c.opts).sort()]), [
    ['lens:domain', ['label', 'phase', 'schema']], ['lens:security', ['label', 'phase', 'schema']], ['synthesis', ['label', 'phase', 'schema']],
  ]);
  assert.equal(out.records.length, 2);
});

test('spec: lenses use spec_lens, the merge uses synthesis (REQ-10)', async () => {
  const a = recorder(specAnswer);
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], models: MODELS() });
  assert.deepEqual(Object.fromEntries(a.calls.map((c) => [c.label, c.opts.model])), { 'lens:domain': 'opus', synthesis: 'sonnet' });
  assert.deepEqual(out.records.map((r) => r.model.role), ['spec_lens', 'synthesis']);
});

// Serial execution: with parallel false every ticket's implementer and both reviews finish before the
// next implementer starts, because all implementers share one checkout. pipeline() has no barrier.
const tick = () => new Promise((r) => setImmediate(r));
function slowRecorder(answer) {
  const calls = [];
  const agent = async (prompt, opts) => { calls.push(opts.label); await tick(); await tick(); return answer(opts, calls); };
  return { agent, calls };
}
const twoTickets = { tickets: [{ id: 'T-1', title: 't', spec_section: 's', acceptance: [], files: [] }, { id: 'T-2', title: 't', spec_section: 's', acceptance: [], files: [] }] };

test('implement: parallel false runs tickets one at a time, implementer then both reviews', async () => {
  const a = slowRecorder(implAnswer);
  const out = await load('implement')(a.agent, parallel, pipeline, noop, noop, implArgs({ ...twoTickets, parallel: false }));
  assert.deepEqual(a.calls.slice(0, 3).sort(), ['implement:T-1', 'quality-review:T-1', 'spec-review:T-1']);
  assert.equal(a.calls[0], 'implement:T-1');
  assert.equal(a.calls[3], 'implement:T-2');
  assert.deepEqual(out.results.map((r) => r.ticket_id), ['T-1', 'T-2']);
  assert.ok(a.calls.every((l) => !l.includes('worktree')));
});

test('implement: parallel true overlaps tickets in isolated worktrees', async () => {
  const a = slowRecorder(implAnswer);
  const calls = [];
  const agent = async (p, opts) => { calls.push(opts); return a.agent(p, opts); };
  await load('implement')(agent, parallel, pipeline, noop, noop, implArgs({ ...twoTickets, parallel: true }));
  assert.deepEqual(a.calls.slice(0, 2), ['implement:T-1', 'implement:T-2']);
  assert.ok(calls.filter((o) => o.label.startsWith('implement:')).every((o) => o.isolation === 'worktree'));
});

// --- T-8: product lens in the spec workflow (REQ-35) ---
const PRODUCT_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'product', 'product.md'), 'utf8');
const SECTIONS = JSON.parse(JSON.stringify(require('../scripts/lib/cap-record').sectionMapOf(require('../scripts/lib/product-context').parseProduct(PRODUCT_TEXT).sections)));
const productAnswer = (opts) => (opts.label === 'product-lens'
  ? { invariants_touched: ['An order total is never negative.'], flows_touched: [{ name: 'Checkout', weight: 'critical' }], states_missing: ['empty cart'], conflicts: [],
    user_impact: { before: 'b', after: 'a' },
    records: [{ claim: 'empty cart state is not specified', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'file', ref: 'intent.md:3' }] }] }
  : specAnswer(opts));

test('spec: without productText no product-lens agent runs and the result has no user_impact (AC-12)', async () => {
  const a = recorder(productAnswer);
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'] });
  assert.deepEqual(a.calls.map((c) => c.label), ['lens:domain', 'synthesis']);
  assert.equal('user_impact' in out, false);
  assert.equal(out.records.length, 1);
});

test('spec: with productText one product-lens agent runs on role product_lens (REQ-35)', async () => {
  const a = recorder(productAnswer);
  const models = MODELS({ product_lens: { class: 'mid', model: 'sonnet-p', source: 'requested' } });
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, models });
  const lens = a.calls.filter((c) => c.label === 'product-lens');
  assert.equal(lens.length, 1);
  assert.equal(lens[0].opts.model, 'sonnet-p');
  assert.deepEqual(out.user_impact, { before: 'b', after: 'a', invariants_touched: ['An order total is never negative.'], flows_touched: [{ name: 'Checkout', weight: 'critical' }], states_missing: ['empty cart'], conflicts: [] });
  const rec = out.records.find((r) => r.agent === 'spine:product-lens');
  assert.equal(rec.stage, 'spec');
  assert.equal(rec.model.role, 'product_lens');
  assert.match(rec.id, /^R-\d{4}$/);
});

test('spec: uncited product-lens records come back capped, cited ones pass (REQ-11, REQ-12)', async () => {
  const cited = { claim: 'total must not go negative', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'doc', ref: 'product.md:20', note: '§Invariants' }] };
  const heading = { claim: 'x', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'doc', ref: 'product.md:18', note: '§Invariants' }] };
  const base = productAnswer({ label: 'product-lens' });
  const a = recorder((opts) => (opts.label === 'product-lens' ? { ...base, records: [...base.records, cited, heading] } : specAnswer(opts)));
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, productSections: SECTIONS });
  const [uncited, ok, onHeading] = out.records.filter((r) => r.agent === 'spine:product-lens');
  assert.equal(uncited.severity, 'MEDIUM');
  assert.equal(uncited.confidence, 0.5);
  assert.equal(uncited.resolution.kind, 'question');
  assert.match(uncited.resolution.text, /^assumption to confirm: /);
  assert.equal(ok.severity, 'HIGH');
  assert.equal(ok.resolution, null);
  assert.equal(onHeading.severity, 'MEDIUM');
});

test('spec: a product-lens that returns nothing under a requested model yields a did-not-run record', async () => {
  const a = recorder((opts) => (opts.label === 'product-lens' ? null : specAnswer(opts)));
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, models: MODELS({ product_lens: { class: 'mid', model: 'sonnet-p', source: 'requested' } }) });
  const dn = out.records.filter((r) => /^agent did not run/.test(r.claim));
  assert.deepEqual(dn.map((r) => [r.claim, r.agent]), [['agent did not run: product-lens', 'spine:product-lens']]);
});

test('spec: the workflow copy of capProductRecord equals scripts/lib/cap-record.js on the shared fixture (REQ-23)', async () => {
  const { capProductRecord } = require('../scripts/lib/cap-record');
  const repoDocs = ['README.md', 'docs/x.md'];
  const ctx = { productSections: SECTIONS, repoHas: (p) => repoDocs.includes(p) };
  const ev = (kind, ref, note) => [{ kind, ref, ...(note ? { note } : {}) }];
  const inputs = [
    ev('file', 'a.js:1'), ev('doc', 'README.md'), ev('doc', 'docs/x.md:4'), ev('doc', 'missing.md'), ev('doc', '#12'), ev('doc', 'o/r#3'),
    ev('doc', 'https://www.w3.org/WAI/WCAG22/'), ev('doc', 'src/a.js'), ev('doc', 'product.md:20', '§Invariants'), ev('doc', 'product.md:18', '§Invariants'),
    ev('doc', 'product.md:19', '§Invariants'), ev('doc', 'product.md:20', '§Goals'), ev('doc', 'product.md:999', '§Invariants'), ev('doc', 'product.md:20'),
  ];
  const mk = (evidence, severity = 'HIGH') => ({ claim: 'c', severity, confidence: 0.9, evidence });
  const a = recorder((opts) => (opts.label === 'product-lens' ? { ...productAnswer(opts), records: inputs.map((e) => mk(e)).concat([mk(ev('file', 'a.js:1'), 'LOW')]) } : specAnswer(opts)));
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, productSections: SECTIONS, repoDocs });
  const got = out.records.filter((r) => r.agent === 'spine:product-lens');
  const want = inputs.map((e) => mk(e)).concat([mk(ev('file', 'a.js:1'), 'LOW')]).map((r) => capProductRecord({ ...r, agent: 'spine:product-lens' }, ctx));
  assert.deepEqual(got.map((r) => [r.severity, r.confidence, r.resolution]), want.map((r) => [r.severity, r.confidence, r.resolution || null]));
});

// --- T-15c: flows to the workflows, shared citation shapes, truncated doc list ---
const FLOWS_TOUCHED = [{ name: 'Checkout', weight: 'critical', files: ['src/checkout/a.js'] }];
const SHAPES = (ev) => [
  ev('file', 'a.js:1'), ev('doc', 'README.md'), ev('doc', 'docs/x.md:4'), ev('doc', 'missing.md'), ev('doc', '#12'), ev('doc', 'o/r#3'),
  ev('doc', 'https://www.w3.org/WAI/WCAG22/'), ev('doc', 'src/a.js'), ev('doc', 'product.md:20', '§Invariants'), ev('doc', 'product.md:18', '§Invariants'),
  ev('doc', 'product.md:19', '§Invariants'), ev('doc', 'product.md:20', '§Goals'), ev('doc', 'product.md:999', '§Invariants'), ev('doc', 'product.md:20'),
  ev('doc', '.spine/product.md:20', '§Invariants'), ev('doc', '.spine/product.md'), ev('doc', 'product.md', '§Invariants'),
  ev('doc', 'product.md:20-22', '§Invariants'), ev('doc', 'product.md:20-23', '§Invariants'), ev('doc', 'product.md:17-20', '§Invariants'),
];

test('T-15c: the product-lens prompt lists the key flows this change touches when flowsTouched is given (R-0221)', async () => {
  const prompts = [];
  const agent = async (prompt, opts) => { if (opts.label === 'product-lens') prompts.push(prompt); return productAnswer(opts); };
  await load('spec')(agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, flowsTouched: FLOWS_TOUCHED });
  assert.ok(prompts[0].includes('key flows this change touches'));
  assert.ok(prompts[0].includes('Checkout (critical)'));
  prompts.length = 0;
  await load('spec')(agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT });
  assert.equal(prompts[0].includes('key flows this change touches'), false);
});

test('T-15c: spec parity covers the same citation shapes as the review one, record by record (R-0222)', async () => {
  const { capProductRecord } = require('../scripts/lib/cap-record');
  const repoDocs = ['README.md', 'docs/x.md'];
  const ctx = { productSections: SECTIONS, repoHas: (p) => repoDocs.includes(p) };
  const ev = (kind, ref, note) => ({ kind, ref, ...(note ? { note } : {}) });
  const mk = (e, i, severity = 'HIGH') => ({ claim: 'c' + i, severity, confidence: 0.9, evidence: [ev('file', 'src/f' + i + '.ts:1'), e] });
  const all = SHAPES(ev).map((e, i) => mk(e, i));
  const a = recorder((opts) => (opts.label === 'product-lens' ? { ...productAnswer(opts), records: all } : specAnswer(opts)));
  const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, productSections: SECTIONS, repoDocs });
  const got = out.records.filter((r) => r.agent === 'spine:product-lens');
  const want = all.map((r) => capProductRecord({ ...r, agent: 'spine:product-lens' }, ctx));
  assert.equal(got.length, want.length);
  want.forEach((w, i) => assert.deepEqual([got[i].claim, got[i].severity, got[i].confidence, got[i].resolution], [w.claim, w.severity, w.confidence, w.resolution || null], w.claim));
});

test('T-15c: a doc citation outside a truncated repo_docs list qualifies; outside a complete list it is capped (R-0227)', async () => {
  const rec = { claim: 'c', severity: 'HIGH', confidence: 0.9, evidence: [{ kind: 'doc', ref: 'docs/far.md:3' }] };
  const run = async (extra) => {
    const a = recorder((opts) => (opts.label === 'product-lens' ? { ...productAnswer(opts), records: [rec] } : specAnswer(opts)));
    const out = await load('spec')(a.agent, parallel, pipeline, noop, noop, { intentText: 'i', lenses: ['domain'], productText: PRODUCT_TEXT, productSections: SECTIONS, repoDocs: ['README.md'], ...extra });
    return out.records.find((r) => r.agent === 'spine:product-lens');
  };
  assert.equal((await run({})).severity, 'MEDIUM');
  assert.equal((await run({ repoDocsTruncated: false })).severity, 'MEDIUM');
  assert.equal((await run({ repoDocsTruncated: true })).severity, 'HIGH');
});
