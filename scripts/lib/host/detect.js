'use strict';
const os = require('node:os');
const path = require('node:path');
const { installedProvidersCursor } = require('../cursor-providers');

// Cursor sets CURSOR_VERSION plus a project dir alias (CURSOR_PROJECT_DIR, or CLAUDE_PROJECT_DIR for imported plugins).
// CURSOR_VERSION alone can leak from a shell started inside Cursor, so it is not enough.
const CURSOR_SIGNALS = Object.freeze(['CURSOR_VERSION', 'CURSOR_PROJECT_DIR']);
const PROJECT_DIR_KEYS = Object.freeze(['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']);
const CURSOR_STDIN_KEYS = Object.freeze(['cursor_version', 'conversation_id', 'workspace_roots']);

function runningUnderCursor(env = process.env, input = {}) {
  const set = (k) => typeof env[k] === 'string' && env[k] !== '';
  if (set('CURSOR_VERSION') && PROJECT_DIR_KEYS.some(set)) return true;
  return Boolean(input) && typeof input === 'object' && CURSOR_STDIN_KEYS.some((k) => input[k] !== undefined && input[k] !== null);
}

// Only the real plugin dirs count; a `cursor_providers` config entry must not trigger the yield.
const NO_CONFIG_HOME = path.join(os.tmpdir(), 'spine-no-config');

function cursorSpineInstalled(opts = {}) {
  try {
    return installedProvidersCursor({ ...opts, spineHome: NO_CONFIG_HOME }).includes('spine');
  } catch {
    return false;
  }
}

// True when this Claude-format hook runs inside Cursor next to the Cursor spine copy.
function yieldToCursorCopy(env = process.env, input = {}, opts = {}) {
  return runningUnderCursor(env, input) && cursorSpineInstalled(opts);
}

module.exports = { CURSOR_SIGNALS, CURSOR_STDIN_KEYS, runningUnderCursor, cursorSpineInstalled, yieldToCursorCopy };
