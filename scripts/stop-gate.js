'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readStdinSync, readHookInput, emitContext, block, allow, appendHookLog } = require('./lib/hook-io');
const { loadConfig, findActiveRun } = require('./lib/state');
const { validateArtifactFile } = require('./lib/validate');
const { latestBoundaryPass } = require('./lib/records');

const STAGE_ARTIFACTS = {
  intent: ['intent.md'],
  spec: ['spec.md'],
  plan: ['plan.md', 'tickets.json'],
  implement: ['tickets.json'],
  review: ['review.json'],
  done: [],
};

function collectErrors(run) {
  const errors = [];
  const stage = run.state.stage;
  if (!Object.prototype.hasOwnProperty.call(STAGE_ARTIFACTS, stage)) {
    return [`unknown stage ${stage}`];
  }
  for (const rel of STAGE_ARTIFACTS[stage]) {
    const abs = path.join(run.dir, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`${rel} is missing for stage ${stage}`);
      continue;
    }
    for (const e of validateArtifactFile(abs, rel)) errors.push(`${rel}: ${e}`);
  }
  if (!latestBoundaryPass(run.dir, stage)) {
    errors.push(`no PASS record from spine:boundary-checker for stage ${stage}`);
  }
  return errors;
}

function main() {
  const input = readHookInput(readStdinSync());
  if (input.stop_hook_active) allow();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  if (!run) allow();
  if (run.state.status !== 'active') {
    appendHookLog(run, 'Stop', 'allow');
    allow();
  }
  if (['G1', 'G2', 'G3', 'human'].includes(run.state.awaiting)) {
    appendHookLog(run, 'Stop', 'allow');
    allow();
  }
  if (run.state.stage === 'done') {
    appendHookLog(run, 'Stop', 'allow');
    allow();
  }
  const errors = collectErrors(run);
  if (!errors.length) {
    appendHookLog(run, 'Stop', 'allow');
    allow();
  }
  const reason = `run ${run.id} stage ${run.state.stage} is not gate-clean: ${errors.join('; ')}. Finish the stage artifact and run the boundary checker.`;
  if (config.strictness === 'warn') {
    appendHookLog(run, 'Stop', 'warn');
    process.stdout.write(emitContext('Stop', reason));
    allow();
  }
  appendHookLog(run, 'Stop', 'block');
  block(reason);
}

try {
  main();
} catch (e) {
  // Fail open: a bug in spine must never trap the user in a turn.
  process.stderr.write(`spine: stop gate error: ${e && e.message}\n`);
  allow();
}
