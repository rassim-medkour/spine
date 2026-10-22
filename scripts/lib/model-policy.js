'use strict';
// Model routing policy: roles, classes, the Balanced table, policy parsing and
// merging, the verifier floor and the weak-verifier rule. Pure: no I/O, no env.
// Never required by a hook (tests/model-isolation.test.js pins that).
const crypto = require('node:crypto');
const { TIERS } = require('./tier-config');

const ROLES = Object.freeze(['implementer', 'finder', 'verifier', 'devils_advocate', 'spec_lens', 'synthesis', 'boundary_checker']);
const CLASSES = Object.freeze(['cheap', 'mid', 'top']);
const CLASS_RANK = Object.freeze({ cheap: 0, mid: 1, top: 2 });
const SOURCES = Object.freeze(['requested', 'inherit', 'session-fallback', 'unsupported-dispatch', 'floor-raised', 'fallback-error']);
const HOSTS = Object.freeze(['claude-code', 'cursor']);
const SIZE_TIER = Object.freeze({ S: 'leaf', M: 'branch', L: 'trunk' });
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WEAK_VERIFIER_NOTE = 'verifier below finder strength';
const TIER_SOURCES = Object.freeze(['tree', 'size']);
const BLOCK_CLASSES = Object.freeze([...CLASSES, 'inherit', 'pinned']);
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const WHOLE_IGNORED = 'whole model_policy ignored, Balanced used';

const row = (leaf, branch, trunk) => Object.freeze({ leaf, branch, trunk });
const BALANCED = Object.freeze({
  implementer: row('mid', 'mid', 'mid'),
  finder: row('mid', 'mid', 'top'),
  verifier: row('mid', 'top', 'top'),
  devils_advocate: row('mid', 'top', 'top'),
  spec_lens: row('mid', 'mid', 'top'),
  synthesis: row('cheap', 'mid', 'mid'),
  boundary_checker: row('cheap', 'cheap', 'mid'),
});
const DEFAULT_CLASS_IDS = Object.freeze({ 'claude-code': Object.freeze({ cheap: 'haiku', mid: 'sonnet', top: 'opus' }) });

// Label prefix or agent name -> role (REQ-10). Labels are what workflows pass as opts.label.
const DISPATCH_ROLES = Object.freeze({
  find: 'finder',
  verify: 'verifier',
  'verify-da': 'verifier',
  merge: 'synthesis',
  'devils-advocate': 'devils_advocate',
  implement: 'implementer',
  'spec-review': 'finder',
  'quality-review': 'finder',
  lens: 'spec_lens',
  synthesis: 'synthesis',
  'spine:synthesis': 'synthesis',
  'spine:boundary-checker': 'boundary_checker',
  'spine:devils-advocate': 'devils_advocate',
});

// Dispatch sites that cannot take a model (REQ-34). Ids are stable; both skills list them.
const LIMITATIONS = Object.freeze({
  'not-routed': 'planner, grilling and the size L council run on the session model and are not routed',
  'inline-skill': 'a provider of kind skill run inline (size S, or the workflow-unavailable fallback) runs in the main session: record source unsupported-dispatch',
  'cursor-task-model': 'Cursor: when the Task tool has no model parameter, every subagent runs on the session model: record source unsupported-dispatch',
});

const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const policyError = (path, reason) => `model_policy${path}: ${reason}; ${WHOLE_IGNORED}`;

function parseString(raw) {
  if (raw === 'inherit') return { kind: 'inherit', cells: {}, pin: { class: 'inherit', id: null }, errors: [] };
  if (CLASSES.includes(raw)) return { kind: 'pin', cells: {}, pin: { class: raw, id: null }, errors: [] };
  if (MODEL_ID_RE.test(raw)) return { kind: 'pin', cells: {}, pin: { class: 'pinned', id: raw }, errors: [] };
  return { kind: 'none', cells: {}, pin: null, errors: [policyError('', 'invalid value')] };
}

function parseRow(role, rawRow, cells, errors) {
  if (!isObj(rawRow)) {
    errors.push(policyError(`.${safeKey(role)}`, 'not an object'));
    return;
  }
  const out = {};
  for (const tier of Object.keys(rawRow)) {
    if (UNSAFE_KEYS.includes(tier)) continue;
    const where = `.${safeKey(role)}.${safeKey(tier)}`;
    if (!TIERS.includes(tier)) errors.push(policyError(where, 'unknown tier'));
    else if (typeof rawRow[tier] !== 'string' || !(CLASSES.includes(rawRow[tier]) || rawRow[tier] === 'inherit')) errors.push(policyError(where, 'unknown class'));
    else out[tier] = { class: rawRow[tier], id: null };
  }
  cells[role] = out;
}

function parseObject(raw) {
  const cells = {};
  const errors = [];
  for (const role of Object.keys(raw)) {
    if (UNSAFE_KEYS.includes(role)) continue;
    if (!ROLES.includes(role)) errors.push(policyError(`.${safeKey(role)}`, 'unknown role'));
    else parseRow(role, raw[role], cells, errors);
  }
  return { kind: 'cells', cells, pin: null, errors };
}

function parsePolicyLayer(raw) {
  if (raw === undefined || raw === null) return { kind: 'none', cells: {}, pin: null, errors: [] };
  if (typeof raw === 'string') return parseString(raw);
  if (isObj(raw)) return parseObject(raw);
  return { kind: 'none', cells: {}, pin: null, errors: [policyError('', 'invalid value')] };
}

function balancedTable() {
  const table = {};
  for (const role of ROLES) {
    const cells = {};
    for (const tier of TIERS) cells[tier] = { class: BALANCED[role][tier], id: null, policy_source: 'default' };
    table[role] = cells;
  }
  return table;
}

function applyLayer(table, layer, source) {
  if (layer.kind === 'none') return;
  if (layer.pin) {
    for (const role of ROLES) for (const tier of TIERS) table[role][tier] = { class: layer.pin.class, id: layer.pin.id, policy_source: source };
    return;
  }
  for (const role of Object.keys(layer.cells)) {
    for (const tier of Object.keys(layer.cells[role])) {
      const cell = layer.cells[role][tier];
      table[role][tier] = { class: cell.class, id: cell.id, policy_source: source };
    }
  }
}

function freezeTable(table) {
  for (const role of ROLES) {
    for (const tier of TIERS) Object.freeze(table[role][tier]);
    Object.freeze(table[role]);
  }
  return Object.freeze(table);
}

function tableHash(table) {
  const tuples = [];
  for (const role of ROLES) for (const tier of TIERS) tuples.push([role, tier, table[role][tier].class, table[role][tier].id]);
  return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex').slice(0, 16);
}

function mergePolicies(globalRaw, repoRaw) {
  const g = parsePolicyLayer(globalRaw);
  const r = parsePolicyLayer(repoRaw);
  const errors = [...g.errors, ...r.errors];
  if (errors.length) {
    const table = freezeTable(balancedTable());
    return Object.freeze({ kind: 'balanced', table, invalid: true, errors: Object.freeze(errors), hash: tableHash(table) });
  }
  const table = balancedTable();
  applyLayer(table, g, 'global');
  applyLayer(table, r, 'repo');
  const last = [r, g].find((l) => l.kind !== 'none');
  freezeTable(table);
  return Object.freeze({ kind: last ? last.kind : 'balanced', table, invalid: false, errors: Object.freeze([]), hash: tableHash(table) });
}

// Returns only the valid overrides; the caller merges them over DEFAULT_CLASS_IDS[host].
function parseClassIds(raw, host) {
  const ids = {};
  const errors = [];
  const own = isObj(raw) && Object.prototype.hasOwnProperty.call(raw, host) ? raw[host] : null;
  if (isObj(own)) {
    for (const key of Object.keys(own)) {
      if (UNSAFE_KEYS.includes(key)) continue;
      if (CLASSES.includes(key) && typeof own[key] === 'string' && MODEL_ID_RE.test(own[key])) ids[key] = own[key];
      else errors.push(`model_ids.${safeKey(host)}.${safeKey(key)}: invalid id, default kept`);
    }
  }
  return Object.freeze({ ids: Object.freeze(ids), errors: Object.freeze(errors) });
}

function floorClass(cls, raiserClasses) {
  if (!(cls in CLASS_RANK)) return Object.freeze({ class: cls, raised: false });
  let best = cls;
  for (const c of raiserClasses) if (c in CLASS_RANK && CLASS_RANK[c] > CLASS_RANK[best]) best = c;
  return Object.freeze({ class: best, raised: best !== cls });
}

function effectiveClass(block) {
  return block && (block.source === 'requested' || block.source === 'floor-raised') ? block.class : 'session';
}

function isWeakVerifier(verifierBlock, raiserBlocks, { tier, killSwitch } = {}) {
  if (tier !== 'trunk' || killSwitch) return false;
  const v = effectiveClass(verifierBlock);
  if (v === 'pinned') return false;
  const raisers = raiserBlocks.map(effectiveClass).filter((c) => c in CLASS_RANK);
  if (!(v in CLASS_RANK)) return raisers.some((c) => CLASS_RANK[c] > 0);
  return raisers.some((c) => CLASS_RANK[c] > CLASS_RANK[v]);
}

function validateModelBlock(b) {
  if (!isObj(b)) return ['model is invalid'];
  const bad = [];
  if (!ROLES.includes(b.role)) bad.push('role');
  if (!(b.tier === null || TIERS.includes(b.tier))) bad.push('tier');
  if (!(b.tier_source === null || TIER_SOURCES.includes(b.tier_source))) bad.push('tier_source');
  if (!(b.class === null || BLOCK_CLASSES.includes(b.class))) bad.push('class');
  if (!(b.requested === null || (typeof b.requested === 'string' && MODEL_ID_RE.test(b.requested)))) bad.push('requested');
  if (!SOURCES.includes(b.source)) bad.push('source');
  if (b.reason !== undefined && !(typeof b.reason === 'string' && b.reason.length <= 200 && !b.reason.includes('\n'))) bad.push('reason');
  return bad.map((k) => `model.${k} is invalid`);
}

module.exports = {
  ROLES, CLASSES, CLASS_RANK, SOURCES, HOSTS, SIZE_TIER, MODEL_ID_RE, BALANCED, DEFAULT_CLASS_IDS,
  DISPATCH_ROLES, WEAK_VERIFIER_NOTE, LIMITATIONS,
  parsePolicyLayer, mergePolicies, parseClassIds, floorClass, effectiveClass, isWeakVerifier, validateModelBlock,
};
