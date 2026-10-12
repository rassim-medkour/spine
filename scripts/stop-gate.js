'use strict';
const { readStdinSync, readHookInput, emitContext, block, allow, appendHookLog } = require('./lib/hook-io');
const { yieldToCursorCopy } = require('./lib/host/detect');
const { loadConfig, findActiveRun } = require('./lib/state');
const { evaluateStop, stopReason } = require('./lib/gate');

function main() {
  const input = readHookInput(readStdinSync());
  if (yieldToCursorCopy(process.env, input)) allow();
  if (input.stop_hook_active) allow();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  if (!run) allow();
  const verdict = evaluateStop(run, config);
  if (verdict.decision === 'allow') {
    appendHookLog(run, 'Stop', 'allow');
    allow();
  }
  const reason = stopReason(run, verdict.errors);
  if (verdict.decision === 'warn') {
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
