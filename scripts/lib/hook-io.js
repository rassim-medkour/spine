'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { stripBom, readHookPayload } = require('./stdin');

function readHookInput(rawStdinText) {
  const stdinText = stripBom(rawStdinText);
  if (!stdinText || !stdinText.trim()) return {};
  try {
    const parsed = JSON.parse(stdinText);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emitContext(eventName, text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  });
}

function block(reason) {
  process.stderr.write(`spine: ${reason}\n`);
  process.exit(2);
}

function allow() {
  process.exit(0);
}

function appendHookLog(run, eventName, outcome) {
  try {
    if (!run || !run.dir) return;
    const line = `${new Date().toISOString()} ${eventName} ${outcome}\n`;
    fs.appendFileSync(path.join(run.dir, 'hooks.log'), line);
  } catch {
    // never throw: logging must not affect hook behavior
  }
}

// Ignore empty, non-JSON, non-object or oversized stdin: exit 0, one stderr line, no writes.
function readGuardedInput(hookName, fd = 0) {
  const { payload, error } = readHookPayload(fd);
  if (!error) return payload;
  process.stderr.write(`spine: ${hookName} ignored ${error} stdin
`);
  process.exit(0);
}

module.exports = { readHookInput, readStdinSync, emitContext, block, allow, appendHookLog, readGuardedInput };
