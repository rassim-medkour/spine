'use strict';
const os = require('node:os');
const path = require('node:path');
const { installedProvidersCursor } = require('../cursor-providers');

// Markers present only inside Cursor (spike T-4). CLAUDE_PROJECT_DIR is an alias Cursor also sets, so it is not a signal.
const CURSOR_SIGNALS = Object.freeze(['CURSOR_VERSION', 'CURSOR_PROJECT_DIR']);
const CURSOR_STDIN_KEYS = Object.freeze(['cursor_version', 'conversation_id', 'workspace_roots']);

function runningUnderCursor(env = process.env, input = {}) {
  if (CURSOR_SIGNALS.some((k) => typeof env[k] === 'string' && env[k] !== '')) return true;
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
