'use strict';
const fs = require('node:fs');

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

module.exports = { readHookInput, readStdinSync, emitContext, block, allow };
