'use strict';
const { readGuardedInput, emitContext, appendHookLog } = require('./lib/hook-io');
const { yieldToCursorCopy } = require('./lib/host/detect');
const { loadConfig, findActiveRun } = require('./lib/state');
const { installedPlugins, loadRegistry } = require('./lib/providers');
const { missingFrom, buildSessionLines } = require('./lib/session');

function main() {
  try {
    const input = readGuardedInput('session-start');
    if (yieldToCursorCopy(process.env, input)) return;
    const cwd = input.cwd || process.cwd();
    const missing = missingFrom(loadRegistry(), installedPlugins());
    const run = findActiveRun(cwd, loadConfig(cwd));
    if (run) appendHookLog(run, 'SessionStart', 'active-run');
    const lines = buildSessionLines({ missing, run });
    if (lines.length) process.stdout.write(emitContext('SessionStart', lines.join('\n')));
  } catch (err) {
    process.stderr.write(`spine: session-start hook failed: ${err && err.message ? err.message : err}\n`);
  }
}

main();
