'use strict';
const PLAN_KINDS = Object.freeze(['rollback_plan', 'flag_plan']);
const COMMAND_KINDS = Object.freeze(['test_run', 'lint', 'typecheck', 'integration', 'runtime_log', 'migration_dry_run']);
const COUNTED_KINDS = new Set(['test_run', 'integration']);
const KINDS = Object.freeze([...COMMAND_KINDS, ...PLAN_KINDS, 'test_quality']);

// node:test prints "# pass N", "# fail N" and "# skipped N" in its TAP summary.
function parseCounts(output) {
  const total = (name) => {
    const m = new RegExp(`^# ${name} (\\d+)\\s*$`, 'm').exec(String(output || ''));
    return m ? Number(m[1]) : null;
  };
  const pass = total('pass');
  const fail = total('fail');
  if (pass === null || fail === null) return null;
  const skip = total('skipped');
  return skip ? { pass, fail, skip } : { pass, fail };
}

function parseScope(value) {
  if (value === undefined) return ['*'];
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error('--scope needs at least one path or *');
  return list;
}

function proofRecord({ kind, revision, scope, command, exitCode, counts, status, evidencePath, payload, target }) {
  const result = { command, exit_code: exitCode, status };
  if (counts && COUNTED_KINDS.has(kind)) result.counts = counts;
  if (target) result.target = target;
  const evidence = [{ kind: 'command', ref: command }];
  if (evidencePath) evidence.push({ kind: 'file', ref: evidencePath });
  const record = {
    stage: 'review', agent: 'spine:proof', claim: `${kind}: ${command}`, evidence, confidence: 1, severity: 'INFO',
    proof_kind: kind, revision, scope, result,
  };
  return payload ? { ...record, payloads: [payload] } : record;
}

function planRecord({ kind, revision, scope, plan, source }) {
  return {
    stage: 'review', agent: 'spine:proof', claim: kind, evidence: [{ kind: 'doc', ref: source }], confidence: 1, severity: 'INFO',
    proof_kind: kind, revision, scope, result: { status: 'ok', plan },
  };
}

module.exports = { KINDS, COMMAND_KINDS, PLAN_KINDS, parseCounts, parseScope, proofRecord, planRecord };
