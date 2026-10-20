'use strict';
// Resolves the model plan for a stage: tier (tree.json, else size), policy, class ids.
// Offline and deterministic. Writes <run>/models.json once per stage and prints one JSON object.
// Exit 0 valid, 2 bad flag, 1 internal error. Never required by a hook.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULTS, loadConfigLayers, readJson } = require('./lib/state');
const mp = require('./lib/model-policy');
const { validateTree } = require('./lib/validate');
const { tierConfig, tierConfigHash } = require('./lib/tier-config');

const STAGES = ['intent', 'spec', 'plan', 'implement', 'review'];
const FLAG_RULES = {
  '--run': /./,
  '--stage': new RegExp(`^(${STAGES.join('|')})$`),
  '--host': /^(claude-code|cursor)$/,
  '--role': new RegExp(`^(${mp.ROLES.join('|')})$`),
  '--tier': /^(leaf|branch|trunk|S|M|L)$/,
  '--size': /^[SML]$/,
};
const ENTRY_KEYS = ['role', 'tier', 'tier_source', 'class', 'model', 'host', 'source', 'reason', 'policy_source'];
const FLOORED_ROLES = ['verifier', 'devils_advocate'];

class BadFlag extends Error {
  constructor(flag) {
    super(`bad flag ${flag}`);
    this.flag = flag;
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const rule = Object.prototype.hasOwnProperty.call(FLAG_RULES, flag) ? FLAG_RULES[flag] : null;
    if (!rule || argv[i + 1] === undefined || !rule.test(argv[i + 1])) throw new BadFlag(flag);
    flags[flag.slice(2)] = argv[i + 1];
  }
  if (flags.run && flags.stage) return { ...flags, mode: 'run' };
  if (flags.tier && flags.role) return { ...flags, mode: 'query' };
  throw new BadFlag(flags.run ? '--stage' : flags.stage ? '--run' : flags.tier ? '--role' : flags.role ? '--tier' : '--run');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sizeOk = (v) => (typeof v === 'string' && /^[SML]$/.test(v) ? v : null);

function sizeTier(size, reason) {
  return { tier: mp.SIZE_TIER[size], tier_source: 'size', tier_reason: reason };
}

function resolveTier({ runDir, size, config }) {
  const fromRun = (name) => { const j = readJson(path.join(runDir, name)); return isObj(j) ? sizeOk(j.size) : null; };
  const s = sizeOk(size) || fromRun('class.json') || fromRun('state.json') || 'M';
  const treeFile = path.join(runDir, 'tree.json');
  if (!fs.existsSync(treeFile)) return sizeTier(s, 'no tree.json');
  const tree = readJson(treeFile);
  if (!isObj(tree) || !isObj(tree.inputs)) return sizeTier(s, 'tree.json invalid');
  let errors;
  try {
    errors = validateTree(tree);
  } catch {
    errors = ['unreadable'];
  }
  if (errors.length) return sizeTier(s, 'tree.json invalid');
  if (tree.inputs.config_sha256 !== tierConfigHash(tierConfig(config))) return sizeTier(s, 'tree.json stale: tier config changed');
  const diffFile = path.join(runDir, 'diff.patch');
  if (fs.existsSync(diffFile) && sha256(fs.readFileSync(diffFile)) !== tree.inputs.diff_sha256) return sizeTier(s, 'tree.json stale: diff changed');
  return { tier: tree.tier, tier_source: 'tree', tier_reason: 'tree.json' };
}

function inheritEntry(base, reason) {
  return { ...base, class: base.class, model: null, source: 'inherit', reason };
}

function baseEntry({ role, tier, tier_source, host, cell }) {
  return { role, tier, tier_source, class: cell.class, model: null, host, source: 'requested', reason: null, policy_source: cell.policy_source };
}

function cellEntry(args, noIdReason) {
  const { cell, classIds } = args;
  const base = baseEntry(args);
  if (cell.class === 'inherit') return inheritEntry(base, 'model_policy inherit');
  if (cell.class === 'pinned') return { ...base, model: cell.id, reason: 'model_policy pin' };
  const model = classIds[cell.class];
  if (typeof model !== 'string' || !model) return inheritEntry(base, noIdReason(cell.class));
  return { ...base, model };
}

function applyFloor(entry, finder, classIds) {
  if (!FLOORED_ROLES.includes(entry.role) || entry.tier !== 'trunk') return entry;
  const floored = mp.floorClass(entry.class, [finder.class]);
  if (!floored.raised || typeof classIds[floored.class] !== 'string') return entry;
  return { ...entry, class: floored.class, model: classIds[floored.class], source: 'floor-raised', reason: `policy_clamped: raised from ${entry.class} to ${floored.class} (finder class)` };
}

function limitationsFor(host) {
  const ids = ['not-routed', 'inline-skill', ...(host === 'cursor' ? ['cursor-task-model'] : [])];
  return ids.map((id) => ({ id, text: mp.LIMITATIONS[id] }));
}

function buildRoles({ tier, tier_source, host, merged, classIds, noIdReason }) {
  const reasonFor = noIdReason || ((cls) => `no model id for class ${cls} on ${host}`);
  const entries = {};
  for (const role of mp.ROLES) entries[role] = cellEntry({ role, tier, tier_source, host, cell: merged.table[role][tier], classIds }, reasonFor);
  const roles = {};
  for (const role of mp.ROLES) {
    const e = merged.kind === 'inherit' ? entries[role] : applyFloor(entries[role], entries.finder, classIds);
    roles[role] = Object.fromEntries(ENTRY_KEYS.map((k) => [k, e[k]]));
  }
  return roles;
}

function buildStagePlan({ tier, tier_source, tier_reason, host, merged, classIds, discovery, noIdReason }) {
  const roles = buildRoles({ tier, tier_source, host, merged, classIds, noIdReason });
  const workflowRoles = {};
  for (const role of mp.ROLES) workflowRoles[role] = { class: roles[role].class, model: roles[role].model, source: roles[role].source };
  return {
    tier,
    tier_source,
    tier_reason,
    roles,
    workflow_args: { tier, tier_source, kill_switch: merged.kind === 'inherit', class_ids: { ...classIds }, roles: workflowRoles },
    limitations: limitationsFor(host),
  };
}

function policySource(merged) {
  const seen = new Set();
  for (const role of mp.ROLES) for (const cell of Object.values(merged.table[role])) seen.add(cell.policy_source);
  const parts = ['global', 'repo'].filter((s) => seen.has(s));
  return parts.length ? parts.join('+') : 'default';
}

function policySummary(merged) {
  return { kind: merged.kind, source: policySource(merged), hash: merged.hash, invalid: merged.invalid, errors: [...merged.errors] };
}

function stageReusable(entry) {
  if (!isObj(entry) || !isObj(entry.roles) || !isObj(entry.workflow_args)) return false;
  return mp.ROLES.every((role) => {
    const e = entry.roles[role];
    return isObj(e) && (e.model === null || (typeof e.model === 'string' && mp.MODEL_ID_RE.test(e.model)));
  });
}

function readModelsFile(file) {
  const j = readJson(file);
  return isObj(j) && j.schema_version === 1 && isObj(j.stages) ? j : null;
}

function classIdsFor(config, host) {
  const parsed = mp.parseClassIds(config.model_ids, host);
  return { classIds: { ...(mp.DEFAULT_CLASS_IDS[host] || {}), ...parsed.ids }, errors: parsed.errors };
}

function runMode(flags, ctx) {
  const runDir = path.resolve(ctx.cwd, flags.run);
  if (!fs.existsSync(path.join(runDir, 'state.json'))) throw new Error('run directory not found');
  const host = flags.host || 'claude-code';
  const file = path.join(runDir, 'models.json');
  const existing = readModelsFile(file);
  const merged = mp.mergePolicies(ctx.layers.global.model_policy, ctx.layers.repo.model_policy);
  for (const e of merged.errors) ctx.stderr(`spine: ${e}\n`);
  const policy = policySummary(merged);
  if (existing && existing.host === host && stageReusable(existing.stages[flags.stage])) {
    return { ok: true, stage: flags.stage, host, ...existing.stages[flags.stage], policy: existing.policy || policy };
  }
  const { classIds, errors } = classIdsFor(ctx.config, host);
  for (const e of errors) ctx.stderr(`spine: ${e}\n`);
  const tier = resolveTier({ runDir, size: flags.size, config: ctx.config });
  const plan = buildStagePlan({ stage: flags.stage, ...tier, host, merged, classIds });
  const keep = existing && existing.host === host ? existing.stages : {};
  const next = { schema_version: 1, host, policy, discovery: null, stages: { ...keep, [flags.stage]: plan } };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, stage: flags.stage, host, ...plan, policy };
}

function queryMode(flags, ctx) {
  const host = flags.host || 'claude-code';
  const bySize = mp.SIZE_TIER[flags.tier];
  const tier = bySize || flags.tier;
  const merged = mp.mergePolicies(ctx.layers.global.model_policy, ctx.layers.repo.model_policy);
  for (const e of merged.errors) ctx.stderr(`spine: ${e}\n`);
  const { classIds, errors } = classIdsFor(ctx.config, host);
  for (const e of errors) ctx.stderr(`spine: ${e}\n`);
  const plan = buildStagePlan({ stage: 'query', tier, tier_source: bySize ? 'size' : null, tier_reason: 'query', host, merged, classIds });
  return { ok: true, ...plan.roles[flags.role] };
}

function main(argv, env = {}) {
  const stderr = env.stderr || ((s) => process.stderr.write(s));
  try {
    const flags = parseFlags(argv);
    const cwd = env.cwd || process.cwd();
    const home = env.home || process.env.SPINE_HOME || os.homedir();
    const layers = loadConfigLayers(cwd, home);
    const config = { ...DEFAULTS, ...layers.global, ...layers.repo, artifacts_dir: layers.artifactsDir };
    const ctx = { cwd, home, layers, config, stderr };
    const out = flags.mode === 'run' ? runMode(flags, ctx) : queryMode(flags, ctx);
    return { code: 0, out: flags.mode === 'run' && flags.role ? { ok: true, ...out.roles[flags.role] } : out };
  } catch (e) {
    if (e instanceof BadFlag) {
      stderr(`spine: select-model: ${e.message}\n`);
      return { code: 2, out: { ok: false, error: e.message } };
    }
    return { code: 1, out: { ok: false, error: String((e && e.message) || e).slice(0, 200) } };
  }
}

if (require.main === module) {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = code;
}

module.exports = { main, resolveTier, buildStagePlan };
