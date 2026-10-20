'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mp = require('../scripts/lib/model-policy');
const ca = require('../scripts/lib/cross-author');

const WF = ['review', 'implement', 'spec'];
const text = (n) => fs.readFileSync(path.join(__dirname, '..', 'workflows', `${n}.workflow.js`), 'utf8').replace(/\r\n/g, '\n');
const START = '// --- spine model routing';
const END = '// --- end spine model routing ---';
const block = (n) => {
  const t = text(n);
  const s = t.indexOf(START);
  const e = t.indexOf(END);
  assert.ok(s >= 0 && e > s, n);
  return t.slice(s, e + END.length);
};

test('the routing block is byte-identical in all three workflows', () => {
  for (const n of WF.slice(1)) assert.equal(block(n), block('review'), n);
});

// Evaluate the block in isolation with a stub args to get its functions.
function fromBlock(models) {
  const body = `${block('review')}\nreturn { MODEL_CLASS_RANK, WEAK_VERIFIER_NOTE, floorClass, isWeakVerifier, effectiveClass };`;
  return new Function('args', 'agent', 'log', body)({ models }, async () => null, () => {});
}
const roles = Object.fromEntries(mp.ROLES.map((r) => [r, { class: 'mid', model: 'sonnet', source: 'requested' }]));

test('class rank and weak note match the lib (REQ-26)', () => {
  const b = fromBlock({ tier: 'trunk', roles });
  assert.deepEqual(b.MODEL_CLASS_RANK, { ...mp.CLASS_RANK });
  assert.equal(b.WEAK_VERIFIER_NOTE, mp.WEAK_VERIFIER_NOTE);
  assert.equal(ca.WEAK_VERIFIER_NOTE, mp.WEAK_VERIFIER_NOTE);
});

const VALUES = ['cheap', 'mid', 'top', 'inherit', 'pinned', 'session'];
test('floorClass matches the lib for every pair (REQ-25)', () => {
  const b = fromBlock({ tier: 'trunk', roles });
  for (const c of VALUES) {
    for (const r1 of VALUES) {
      for (const r2 of VALUES) assert.deepEqual(b.floorClass(c, [r1, r2]), mp.floorClass(c, [r1, r2]), `${c} ${r1} ${r2}`);
    }
  }
});

const SOURCES = ['requested', 'floor-raised', 'inherit', 'session-fallback', 'unsupported-dispatch', 'fallback-error'];
test('isWeakVerifier matches the lib over all classes, sources, tiers and the kill switch (REQ-25, REQ-27)', () => {
  const blk = (c, s) => ({ role: 'x', tier: 'trunk', tier_source: 'tree', class: c, requested: null, source: s });
  for (const tier of ['leaf', 'branch', 'trunk']) {
    for (const kill of [false, true]) {
      const b = fromBlock({ tier, kill_switch: kill, roles });
      for (const vc of VALUES) for (const vs of SOURCES) for (const rc of VALUES) for (const rs of SOURCES) {
        assert.equal(b.isWeakVerifier(blk(vc, vs), [blk(rc, rs)]), mp.isWeakVerifier(blk(vc, vs), [blk(rc, rs)], { tier, killSwitch: kill }), `${tier} ${kill} ${vc}/${vs} ${rc}/${rs}`);
      }
    }
  }
});

test('every workflow dispatch label maps to exactly one role (REQ-10)', () => {
  for (const n of WF) {
    const labels = [...text(n).matchAll(/label: [`']([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(labels.length > 0, n);
    for (const l of labels) assert.ok(l in mp.DISPATCH_ROLES, `${n}: label ${l} has no role`);
    for (const m of text(n).matchAll(/routed\('([a-z_]+)'/g)) assert.ok(mp.ROLES.includes(m[1]), `${n}: routed role ${m[1]}`);
    const inBlock = (block(n).match(/\bagent\(/g) || []).length;
    assert.equal((text(n).match(/\bagent\(/g) || []).length, inBlock, `${n}: agent() is called only inside the routing block`);
  }
});
