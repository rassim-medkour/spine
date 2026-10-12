'use strict';
const path = require('node:path');
const { readHookPayload } = require('../lib/stdin');
const { normalizeCursorInput, contextOutput, appendCursorLog, reportError, reportBadStdin } = require('../lib/host/cursor');
const { locateRun } = require('../lib/root');
const { realPathInside } = require('../lib/paths');
const { validateArtifactFile } = require('../lib/validate');
const { stripQuotedValue } = require('../lib/safe-text');

const HOOK = 'cursor postToolUse';
const EVENT = 'PostToolUse';

function decide(run, root, input) {
  if (!input.filePath) return '';
  const target = realPathInside(run.dir, path.resolve(root, input.filePath));
  if (!target) return '';
  const errors = validateArtifactFile(target.abs, target.rel);
  if (!errors.length) {
    appendCursorLog(run, EVENT, 'allow', input.conversationId);
    return '';
  }
  appendCursorLog(run, EVENT, 'warn', input.conversationId);
  const shown = target.rel.split(path.sep).join('/');
  return contextOutput(`spine: ${shown} has ${errors.length} problem(s): ${errors.map(stripQuotedValue).join('; ')}. Fix before moving to the next stage.`);
}

function main() {
  const { payload, error } = readHookPayload();
  if (error) {
    reportBadStdin(HOOK, error);
    return;
  }
  const input = normalizeCursorInput(payload);
  let run = null;
  try {
    const located = locateRun(input);
    run = located.run;
    if (run) process.stdout.write(decide(run, located.root, input));
  } catch (err) {
    reportError(HOOK, err, run, input.conversationId, EVENT);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`spine: ${HOOK} error: ${(err && err.name) || 'Error'}\n`);
}
