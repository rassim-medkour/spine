'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mp = require('../scripts/lib/model-policy');

// Written out literally from intent.md (REQ-3). Never import this table from the module.
const OWNER_TABLE = {
  implementer: ['sonnet', 'sonnet', 'sonnet'],
  finder: ['sonnet', 'sonnet', 'opus'],
  verifier: ['sonnet', 'opus', 'opus'],
  devils_advocate: ['sonnet', 'opus', 'opus'],
  spec_lens: ['sonnet', 'sonnet', 'opus'],
  synthesis: ['haiku', 'sonnet', 'sonnet'],
  boundary_checker: ['haiku', 'haiku', 'sonnet'],
};
const ALIAS_CLASS = { haiku: 'cheap', sonnet: 'mid', opus: 'top' };
const RANK = { cheap: 0, mid: 1, top: 2 }; // independent constant (REQ-27)

test('roles and classes are exactly the spec vocabulary', () => {
  assert.deepEqual([...mp.ROLES], Object.keys(OWNER_TABLE));
  assert.deepEqual([...mp.CLASSES], ['cheap', 'mid', 'top']);
  assert.deepEqual({ ...mp.CLASS_RANK }, RANK);
  assert.deepEqual({ ...mp.SIZE_TIER }, { S: 'leaf', M: 'branch', L: 'trunk' });
});

for (const [role, ids] of Object.entries(OWNER_TABLE)) {
  ['leaf', 'branch', 'trunk'].forEach((tier, i) => {
    test(`Balanced ${role}/${tier} is ${ids[i]}`, () => {
      const m = mp.mergePolicies(undefined, undefined);
      assert.equal(m.kind, 'balanced');
      assert.equal(m.table[role][tier].class, ALIAS_CLASS[ids[i]]);
      assert.equal(mp.DEFAULT_CLASS_IDS['claude-code'][m.table[role][tier].class], ids[i]);
      assert.equal(m.table[role][tier].policy_source, 'default');
    });
  });
}

const INVALID = {
  'unknown role': { reviewer: { leaf: 'top' } },
  'unknown tier': { verifier: { core: 'top' } },
  'unknown class': { verifier: { leaf: 'huge' } },
  'non-object row': { verifier: 'top' },
  'array policy': ['top'],
  'number policy': 7,
  'bad id string': 'bad id with spaces',
};
for (const [name, raw] of Object.entries(INVALID)) {
  test(`invalid policy falls back to Balanced and names the key: ${name}`, () => {
    const m = mp.mergePolicies(raw, undefined);
    assert.equal(m.invalid, true);
    assert.equal(m.kind, 'balanced');
    assert.ok(m.errors.length >= 1 && m.errors.every((e) => /^model_policy/.test(e) && !e.includes('\n')));
    assert.equal(m.table.verifier.leaf.class, 'mid');
  });
}

test('one bad cell drops the whole policy, including a valid override (owner decision)', () => {
  const m = mp.mergePolicies({ synthesis: { leaf: 'top' }, verifier: { leaf: 'huge' } }, undefined);
  assert.equal(m.invalid, true);
  assert.equal(m.table.synthesis.leaf.class, 'cheap');
  assert.deepEqual(m.errors, ['model_policy.verifier.leaf: unknown class; whole model_policy ignored, Balanced used']);
});

test('an invalid repo layer also drops a valid global layer', () => {
  const m = mp.mergePolicies({ synthesis: { leaf: 'top' } }, { verifier: 'top' });
  assert.equal(m.invalid, true);
  assert.equal(m.table.synthesis.leaf.class, 'cheap');
});

test('cell override changes only that cell (REQ-15)', () => {
  const m = mp.mergePolicies({ synthesis: { leaf: 'top' } }, undefined);
  assert.equal(m.kind, 'cells');
  assert.equal(m.table.synthesis.leaf.class, 'top');
  assert.equal(m.table.synthesis.leaf.policy_source, 'global');
  assert.equal(m.table.synthesis.branch.class, 'mid');
  assert.equal(m.table.synthesis.branch.policy_source, 'default');
});

test('repo cells merge over global cells cell by cell (REQ-16)', () => {
  const m = mp.mergePolicies({ synthesis: { leaf: 'top' } }, { implementer: { trunk: 'top' } });
  assert.equal(m.table.synthesis.leaf.policy_source, 'global');
  assert.equal(m.table.implementer.trunk.policy_source, 'repo');
  const lower = mp.mergePolicies({ verifier: { leaf: 'top' } }, { verifier: { leaf: 'cheap' } });
  assert.equal(lower.table.verifier.leaf.class, 'cheap');
  assert.equal(lower.table.verifier.leaf.policy_source, 'repo');
});

test('a repo string value replaces the global policy', () => {
  assert.equal(mp.mergePolicies({ synthesis: { leaf: 'top' } }, 'inherit').kind, 'inherit');
  const pin = mp.mergePolicies({ synthesis: { leaf: 'top' } }, 'mid');
  assert.equal(pin.kind, 'pin');
  for (const role of mp.ROLES) for (const tier of ['leaf', 'branch', 'trunk']) assert.equal(pin.table[role][tier].class, 'mid');
});

test('kill switch and id pin cover all 21 cells (REQ-14, REQ-22)', () => {
  const inh = mp.mergePolicies('inherit', undefined);
  const id = mp.mergePolicies('claude-opus-4-8', undefined);
  for (const role of mp.ROLES) for (const tier of ['leaf', 'branch', 'trunk']) {
    assert.equal(inh.table[role][tier].class, 'inherit');
    assert.deepEqual({ c: id.table[role][tier].class, i: id.table[role][tier].id }, { c: 'pinned', i: 'claude-opus-4-8' });
  }
});

test('prototype keys are ignored and never pollute (REQ-19)', () => {
  const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"leaf":"top"},"prototype":1,"synthesis":{"leaf":"top","__proto__":{"x":1}}}');
  const m = mp.mergePolicies(raw, undefined);
  assert.equal(m.invalid, false);
  assert.equal(m.table.synthesis.leaf.class, 'top');
  assert.equal({}.polluted, undefined);
  assert.ok(Object.isFrozen(m.table) && Object.isFrozen(m.table.synthesis));
});

const HOSTILE_IDS = ['a\nb', 'a b', 'a"b', 'a`b', '---', '../x', 'x;rm -rf /', '$(id)', '-leading', 'x'.repeat(65)];
for (const id of HOSTILE_IDS) {
  test(`model id allowlist rejects ${JSON.stringify(id).slice(0, 20)} (REQ-18)`, () => {
    assert.equal(mp.MODEL_ID_RE.test(id), false);
    const ids = mp.parseClassIds({ 'claude-code': { top: id } }, 'claude-code');
    assert.equal(ids.ids.top, undefined);
    assert.equal(ids.errors.length, 1);
    assert.match(ids.errors[0], /^model_ids\.claude-code\.top: /);
    assert.ok(!ids.errors[0].includes(id), 'the bad value is never echoed');
  });
}

test('floorClass raises to the highest known raiser class only', () => {
  assert.deepEqual(mp.floorClass('cheap', ['top', 'mid']), { class: 'top', raised: true });
  assert.deepEqual(mp.floorClass('top', ['mid']), { class: 'top', raised: false });
  assert.deepEqual(mp.floorClass('mid', ['inherit', 'session']), { class: 'mid', raised: false });
  assert.deepEqual(mp.floorClass('inherit', ['top']), { class: 'inherit', raised: false });
});

test('property: under every all-class policy, the floored trunk verifier is never below the trunk finder (REQ-27)', () => {
  const classes = ['cheap', 'mid', 'top'];
  for (const f of classes) for (const v of classes) for (const d of classes) {
    const m = mp.mergePolicies({ finder: { trunk: f }, verifier: { trunk: v }, devils_advocate: { trunk: d } }, undefined);
    const finder = m.table.finder.trunk.class;
    for (const role of ['verifier', 'devils_advocate']) {
      const out = mp.floorClass(m.table[role].trunk.class, [finder]).class;
      assert.ok(RANK[out] >= RANK[finder], `${role} ${out} < finder ${finder}`);
    }
  }
});

const B = (cls, source = 'requested') => ({ role: 'finder', tier: 'trunk', tier_source: 'tree', class: cls, requested: 'x', source });
test('weak verifier rule', () => {
  const trunk = { tier: 'trunk', killSwitch: false };
  assert.equal(mp.isWeakVerifier(B('mid'), [B('top')], trunk), true);
  assert.equal(mp.isWeakVerifier(B('top'), [B('top')], trunk), false);
  assert.equal(mp.isWeakVerifier(B('top', 'session-fallback'), [B('mid')], trunk), true);
  assert.equal(mp.isWeakVerifier(B('top', 'session-fallback'), [B('cheap')], trunk), false);
  assert.equal(mp.isWeakVerifier(B('inherit', 'inherit'), [B('inherit', 'inherit')], trunk), false);
  assert.equal(mp.isWeakVerifier(B('mid'), [B('top')], { tier: 'branch', killSwitch: false }), false);
  assert.equal(mp.isWeakVerifier(B('mid'), [B('top')], { tier: 'trunk', killSwitch: true }), false);
  assert.equal(mp.isWeakVerifier(B('pinned'), [B('top')], trunk), false);
});

test('validateModelBlock accepts the frozen shape and names bad keys', () => {
  assert.deepEqual(mp.validateModelBlock({ role: 'verifier', tier: 'trunk', tier_source: 'tree', class: 'top', requested: 'opus', source: 'floor-raised', reason: 'policy_clamped' }), []);
  assert.deepEqual(mp.validateModelBlock({ role: 'finder', tier: null, tier_source: null, class: null, requested: null, source: 'fallback-error' }), []);
  assert.deepEqual(mp.validateModelBlock({ role: 'reviewer', tier: 'x', tier_source: 'guess', class: 'huge', requested: 'a b', source: 'self' }),
    ['model.role', 'model.tier', 'model.tier_source', 'model.class', 'model.requested', 'model.source'].map((k) => `${k} is invalid`));
});
