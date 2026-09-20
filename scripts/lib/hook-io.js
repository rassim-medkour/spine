'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readHookInput(stdinText) {
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

module.exports = { readHookInput, readStdinSync, emitContext, block, allow, appendHookLog };
