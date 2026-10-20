'use strict';
const { TEST_FILE } = require('./graph');
const { DOCS_RE } = require('./tiers');

const PROOF_KINDS = Object.freeze(['test_run', 'lint', 'typecheck', 'integration', 'runtime_log', 'live_verify', 'rollback_plan', 'flag_plan', 'migration_dry_run', 'test_quality']);
const REQUIREMENTS = Object.freeze({
  test_run: Object.freeze(['test_run']),
  static_check: Object.freeze(['lint', 'typecheck']),
  integration_or_runtime: Object.freeze(['integration', 'runtime_log']),
  rollback_or_flag_plan: Object.freeze(['rollback_plan', 'flag_plan']),
  test_quality: Object.freeze(['test_quality']),
  migration_dry_run: Object.freeze(['migration_dry_run']),
  live_verify: Object.freeze(['live_verify']),
});
const BY_TIER = Object.freeze({
  leaf: Object.freeze(['test_run', 'static_check']),
  branch: Object.freeze(['test_run', 'static_check', 'integration_or_runtime']),
  trunk: Object.freeze(['test_run', 'static_check', 'integration_or_runtime', 'rollback_or_flag_plan', 'test_quality']),
});
const RUNTIME = new Set(['test_run', 'static_check', 'integration_or_runtime', 'test_quality', 'migration_dry_run', 'live_verify']);
const NEEDS_PAYLOAD = new Set(['runtime_log', 'live_verify']);
const HINTS = Object.freeze({
  test_run: 'run the test suite and record it with scripts/record-proof.js --kind test_run',
  static_check: 'run lint or a type check and record it as lint or typecheck proof',
  integration_or_runtime: 'run integration tests or capture runtime logs with save-evidence.js',
  rollback_or_flag_plan: 'add a ## Rollback section to review.md naming a revert command, a flag name, or "not instantly reversible"',
  test_quality: 'run node <root>/scripts/test-quality.js --run <run> and write its records',
  migration_dry_run: 'run the migration in dry-run mode against a non-production target and record the command',
  live_verify: 'run the project verify skill and record its evidence files',
});
const DRY_RUN_RE = /--dry-run\b|--plan\b|--sql\b|\bsqlmigrate\b|--check\b|\bdry_run\b|--pretend\b/i;
const NON_PROD_RE = /\b(local|localhost|127\.0\.0\.1|dev|development|test|testing|staging|sandbox|sqlite|ci)\b/i;
const PROD_RE = /\bprod(uction)?\b/i;
const PLAN_HEADING = /^#{2,3}\s*(rollback|rollback plan|flag plan|rollback or flag plan)\s*$/im;
const REVERT_WORDS = /\b(revert|roll ?back|downgrade|restore)\b/i;

function requiredEvidence(tier, ctx = {}) {
  if (ctx.docsOnly) return [];
  if (ctx.testOnly) return ['test_run'];
  const list = [...(BY_TIER[tier] || BY_TIER.branch)];
  if (ctx.migration) list.push('migration_dry_run');
  if (ctx.liveVerify) list.push('live_verify');
  return list;
}

function changeContext(treeFiles) {
  const docsOnly = treeFiles.every((f) => DOCS_RE.test(f.path));
  const testOnly = !docsOnly && treeFiles.every((f) => TEST_FILE.test(f.path) || DOCS_RE.test(f.path));
  const migration = treeFiles.some((f) => f.signals.one_way_door.value === true && /^migration/.test(f.signals.one_way_door.rule));
  return { docsOnly, testOnly, migration };
}

const isInt = Number.isInteger;

function checkCommand(result) {
  if (!result || typeof result.command !== 'string' || !result.command.trim()) return { ok: false, reason: 'proof has no command' };
  if (!isInt(result.exit_code)) return { ok: false, reason: 'proof has no integer exit_code' };
  if (result.exit_code !== 0) return { ok: false, reason: 'command failed' };
  return { ok: true, reason: 'command passed' };
}

function checkTestRun(result) {
  if (!result || typeof result.command !== 'string' || !result.command.trim()) return { ok: false, reason: 'test run has no command' };
  if (!isInt(result.exit_code)) return { ok: false, reason: 'test run has no integer exit_code' };
  const c = result.counts;
  if (!c || !isInt(c.pass) || !isInt(c.fail) || (c.skip !== undefined && !isInt(c.skip))) return { ok: false, reason: 'test run has no integer counts {pass, fail}' };
  if (result.exit_code !== 0 || c.fail > 0) return { ok: false, reason: 'test run failed' };
  return { ok: true, reason: 'test run passed' };
}

function checkMigrationDryRun(result) {
  const base = checkCommand(result);
  if (!base.ok) return base;
  const target = typeof result.target === 'string' ? result.target : '';
  if (!target || !NON_PROD_RE.test(target) || PROD_RE.test(target) || PROD_RE.test(result.command)) return { ok: false, reason: 'dry-run must name a non-production target' };
  if (!DRY_RUN_RE.test(result.command) && !result.command.includes(target)) return { ok: false, reason: 'dry-run flag or target not visible in the command' };
  return { ok: true, reason: 'dry-run against a non-production target' };
}

function planSection(markdown) {
  const text = String(markdown || '');
  const m = PLAN_HEADING.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,3}\s/m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function checkRollbackPlan(markdown, { oneWayDoor = false } = {}) {
  const body = planSection(markdown);
  if (body === null) return { ok: false, reason: 'no ## Rollback section' };
  const concrete = /not instantly reversible/i.test(body)
    || (/`[^`\n]+`/.test(body) && (REVERT_WORDS.test(body) || /\bflag\b/i.test(body)))
    || (/^\s*(\d+\.|-)\s+/m.test(body) && REVERT_WORDS.test(body));
  if (!concrete) return { ok: false, reason: 'rollback section names no revert command, flag or "not instantly reversible"' };
  if (oneWayDoor && !/\b(backup|restore|snapshot)\b/i.test(body)) return { ok: false, reason: 'one-way door needs backup or restore steps' };
  return { ok: true, reason: 'rollback section is concrete' };
}

const PLAN_KINDS = new Set(['rollback_plan', 'flag_plan']);
const PLAN_LINE_MAX = 100;

function firstPlanLine(plan) {
  const body = planSection(plan) || String(plan || '');
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  return line.length > PLAN_LINE_MAX ? `${line.slice(0, PLAN_LINE_MAX - 3)}...` : line;
}

// The knob's rollback answer, derived at render time from the proof records so
// tree.json stays deterministic.
function rollbackAnswer(tree, proof, records) {
  const base = tree && tree.knobs && tree.knobs.instant_rollback ? tree.knobs.instant_rollback.answer : 'unknown';
  if (!proof || proof.legacy) return base;
  const oneWayDoor = Boolean(tree && tree.files && tree.files.some((f) => f.signals && f.signals.one_way_door && f.signals.one_way_door.value === true));
  const plan = (records || []).find((r) => PLAN_KINDS.has(r.proof_kind) && r.revision === proof.revision && r.result
    && (!r.result.status || r.result.status === 'ok') && typeof r.result.plan === 'string' && checkRollbackPlan(r.result.plan, { oneWayDoor }).ok);
  if (plan) return `yes (${plan.id}: ${firstPlanLine(plan.result.plan)})`;
  const required = (proof.required || []).includes('rollback_or_flag_plan');
  const missing = (proof.missing || []).some((m) => m.requirement === 'rollback_or_flag_plan');
  return required && missing ? 'no plan' : base;
}

function kindOf(record) {
  if (record.proof_kind) return record.proof_kind;
  return record.agent === 'spine:live-verify' && record.severity === 'INFO' ? 'live_verify' : null;
}

function recordSatisfies(record, requirement, ctx) {
  const kind = kindOf(record);
  if (!(REQUIREMENTS[requirement] || []).includes(kind)) return { ok: false, reason: 'other proof kind' };
  if (record.revision !== ctx.revision) return { ok: false, reason: `stale: expected revision ${ctx.revision}, record has ${record.revision === undefined ? 'none' : record.revision}; record it again with record-proof.js` };
  const result = record.result || {};
  if (result.status === 'timeout') return { ok: false, reason: 'command timed out' };
  if (result.status && result.status !== 'ok') return { ok: false, reason: `status ${result.status}` };
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  if (NEEDS_PAYLOAD.has(kind) && !payloads.length) return { ok: false, reason: 'no evidence payload' };
  for (const p of payloads) {
    const v = ctx.verifyPayload(p);
    if (!v.ok) return v;
  }
  if (kind === 'test_run' || kind === 'integration') return checkTestRun(result);
  if (kind === 'lint' || kind === 'typecheck') return checkCommand(result);
  if (kind === 'migration_dry_run') return checkMigrationDryRun(result);
  return { ok: true, reason: 'present' };
}

module.exports = {
  PROOF_KINDS, REQUIREMENTS, RUNTIME, HINTS,
  requiredEvidence, changeContext, checkCommand, checkTestRun, checkMigrationDryRun, planSection, checkRollbackPlan, rollbackAnswer, recordSatisfies,
};
