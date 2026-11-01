'use strict';
const path = require('node:path');
const { readGuardedInput, emitContext, appendHookLog } = require('./lib/hook-io');
const { yieldToCursorCopy } = require('./lib/host/detect');
const { loadConfig, findActiveRun } = require('./lib/state');
const { validateArtifactFile } = require('./lib/validate');

// product.md lives outside any run, so it is validated with or without an active run.
// Output carries heading names and line numbers only, never the file body.
function validateProduct(cwd, config, run, rel) {
  const errors = validateArtifactFile(path.resolve(cwd, rel), rel, { artifactsDir: config.artifacts_dir });
  appendHookLog(run, 'PostToolUse', errors.length ? 'warn' : 'ok');
  if (!errors.length) return;
  process.stdout.write(emitContext('PostToolUse', `spine: ${rel} has ${errors.length} problem(s): ${errors.join('; ')}. It is treated as absent until fixed.`));
}

function main() {
  const input = readGuardedInput('validate-artifact');
  if (yieldToCursorCopy(process.env, input)) return;
  const cwd = input.cwd || process.cwd();
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  const productRel = path.relative(cwd, path.resolve(cwd, filePath)).split(path.sep).join('/');
  if (productRel === `${config.artifacts_dir}/product.md`) {
    validateProduct(cwd, config, run, productRel);
    return;
  }
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

try {
  main();
} catch (e) {
  // Fail open: a bug in spine must never break the user's edit.
  process.stderr.write(`spine: validate-artifact error: ${e && e.message}\n`);
}
