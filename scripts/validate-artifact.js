'use strict';
const path = require('node:path');
const { readStdinSync, readHookInput, emitContext, appendHookLog } = require('./lib/hook-io');
const { loadConfig, findActiveRun } = require('./lib/state');
const { validateArtifactFile } = require('./lib/validate');

function main() {
  const input = readHookInput(readStdinSync());
  const cwd = input.cwd || process.cwd();
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  if (!run) return;
  const rel = path.relative(run.dir, path.resolve(cwd, filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const errors = validateArtifactFile(path.resolve(cwd, filePath), rel);
  if (!errors.length) {
    appendHookLog(run, 'PostToolUse', 'ok');
    return;
  }
  appendHookLog(run, 'PostToolUse', 'warn');
  const text = `spine: ${rel} has ${errors.length} problem(s): ${errors.join('; ')}. Fix before moving to the next stage.`;
  process.stdout.write(emitContext('PostToolUse', text));
}

main();
