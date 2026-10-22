'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, readJson } = require('./lib/state');
const { tierConfig } = require('./lib/tier-config');
const { checkRollbackPlan } = require('./lib/proof');
const { writeRecords } = require('./lib/record-writer');
const { KINDS, PLAN_KINDS, parseCounts, parseScope, proofRecord, planRecord } = require('./lib/record-proof');
const { saveEvidence } = require('./save-evidence');
const { hollowRecords } = require('./test-quality');
const { activeWorktree } = require('./lib/worktree');

const USAGE = 'usage: record-proof.js --run <run dir> --kind <proof_kind> [--command "<cmd>"] [--from <file>] [--scope a,b] [--exit-code N] [--target <t>]';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

function revisionOf(runDir) {
  const tree = readJson(path.join(runDir, 'tree.json'));
  const inputs = tree && tree.inputs;
  if (!inputs || typeof inputs.head_sha !== 'string' || typeof inputs.diff_sha256 !== 'string') {
    throw new Error(`tree.json is missing or has no inputs in ${runDir}; run scripts/tree.js --run first`);
  }
  return { tree, revision: `${inputs.head_sha}:${inputs.diff_sha256}` };
}

function execute(command, root, timeoutSeconds) {
  const r = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: MAX_OUTPUT_BYTES });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error && !timedOut) return { output: `${output}${r.error.message}\n`, exitCode: 1, status: 'error' };
  return { output, exitCode: Number.isInteger(r.status) ? r.status : 1, status: timedOut ? 'timeout' : 'ok' };
}

function saveOutput({ runDir, kind, output, cap }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-proof-'));
  try {
    const file = path.join(tmp, 'output.log');
    fs.writeFileSync(file, output);
    const saved = saveEvidence({ runDir, from: file, name: `${kind}-${Date.now()}.log`, cap });
    return { evidencePath: saved.path, payload: { path: saved.path, sha256: saved.sha256, bytes: saved.bytes } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function capturedRun(argv) {
  const output = fs.readFileSync(flag(argv, '--from'), 'utf8');
  const given = flag(argv, '--exit-code');
  const counts = parseCounts(output);
  if (given === undefined && !counts) throw new Error('--from output has no "# pass"/"# fail" totals; pass --exit-code N');
  const exitCode = given !== undefined ? Number(given) : (counts.fail > 0 ? 1 : 0);
  if (!Number.isInteger(exitCode)) throw new Error('--exit-code must be an integer');
  return { output, exitCode, status: 'ok' };
}

function commandRecord({ argv, runDir, root, kind, revision, scope, tc }) {
  const command = flag(argv, '--command');
  if (!command) throw new Error(`--command is required for ${kind}`);
  const run = flag(argv, '--from') ? capturedRun(argv) : execute(command, root, tc.proof_timeout_seconds);
  const saved = saveOutput({ runDir, kind, output: run.output, cap: tc.evidence_cap_bytes });
  const record = proofRecord({ kind, revision, scope, command, exitCode: run.exitCode, counts: parseCounts(run.output), status: run.status, target: flag(argv, '--target'), ...saved });
  return { records: [record], passed: run.exitCode === 0 && run.status === 'ok' };
}

function planRecords({ argv, tree, kind, revision, scope }) {
  const from = flag(argv, '--from');
  if (!from) throw new Error(`--from <markdown file with a ## Rollback section> is required for ${kind}`);
  const plan = fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n');
  const oneWayDoor = tree.files.some((f) => f.signals && f.signals.one_way_door && f.signals.one_way_door.value === true);
  const check = checkRollbackPlan(plan, { oneWayDoor });
  if (!check.ok) throw new Error(`${check.reason} in ${path.basename(from)}; write a "## Rollback" heading with a backticked revert command or flag, or the words "not instantly reversible"`);
  return { records: [planRecord({ kind, revision, scope, plan, source: path.basename(from) })], passed: true };
}

function main(argv, root = process.cwd()) {
  const runArg = flag(argv, '--run');
  const kind = flag(argv, '--kind');
  if (!runArg || !kind) throw new Error(USAGE);
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  const runDir = path.resolve(root, runArg);
  const { tree, revision } = revisionOf(runDir);
  const scope = parseScope(flag(argv, '--scope'));
  const tc = tierConfig(loadConfig(root));
  // Proof runs against the reviewed code: the review worktree when one exists.
  const codeRoot = activeWorktree(runDir) || root;
  let built;
  if (kind === 'test_quality') built = { records: hollowRecords({ runDir, root: codeRoot }), passed: true };
  else if (PLAN_KINDS.includes(kind)) built = planRecords({ argv, tree, kind, revision, scope });
  else built = commandRecord({ argv, runDir, root: codeRoot, kind, revision, scope, tc });
  return { ids: writeRecords(runDir, built.records), revision, passed: built.passed };
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.passed ? 0 : 1);
  } catch (e) {
    process.stderr.write(`spine: record-proof: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}

module.exports = { main };
