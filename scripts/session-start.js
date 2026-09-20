'use strict';
const { readStdinSync, readHookInput, emitContext, appendHookLog } = require('./lib/hook-io');
const { loadConfig, findActiveRun } = require('./lib/state');
const { installedPlugins, loadRegistry, pluginOf } = require('./lib/providers');

function missingPlugins() {
  const installed = new Set(installedPlugins());
  const needed = new Set();
  for (const list of Object.values(loadRegistry())) for (const p of list) needed.add(pluginOf(p.id));
  return [...needed].filter((n) => !installed.has(n)).sort();
}

function main() {
  try {
    const input = readHookInput(readStdinSync());
    const cwd = input.cwd || process.cwd();
    const lines = [];
    const missing = missingPlugins();
    if (missing.length) lines.push(`spine: missing plugins: ${missing.join(', ')}. Affected providers will be skipped.`);
    const run = findActiveRun(cwd, loadConfig(cwd));
    if (run) {
      lines.push(`spine: active run ${run.id} at stage ${run.state.stage}, awaiting ${run.state.awaiting || 'none'}. Run /spine:spine status to resume.`);
      appendHookLog(run, 'SessionStart', 'active-run');
    }
    if (lines.length) process.stdout.write(emitContext('SessionStart', lines.join('\n')));
  } catch (err) {
    process.stderr.write(`spine: session-start hook failed: ${err && err.message ? err.message : err}\n`);
  }
}

main();
