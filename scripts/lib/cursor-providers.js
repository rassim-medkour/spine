'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson } = require('./state');
const { installedPlugins } = require('./providers');

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE_NAME.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

function spineConfig(spineHome) {
  const cfg = readJson(path.join(spineHome, '.spine', 'config.json'));
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function configuredProviders(cfg) {
  const list = cfg.cursor_providers;
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && SAFE_NAME.test(n)) : [];
}

// ~/.cursor/plugins/cache/<marketplace>/<plugin>/<ref>/ ; a plugin counts only with a ref dir.
function cachedPlugins(cursorHome) {
  const cache = path.join(cursorHome, 'plugins', 'cache');
  const found = [];
  for (const market of listDirs(cache)) {
    for (const plugin of listDirs(path.join(cache, market))) {
      if (listDirs(path.join(cache, market, plugin)).length) found.push(plugin);
    }
  }
  return found;
}

function localPlugins(cursorHome) {
  return listDirs(path.join(cursorHome, 'plugins', 'local'));
}

// Reads directory names and one JSON config only; never requires or executes anything found.
function installedProvidersCursor({
  cursorHome = process.env.SPINE_CURSOR_HOME || path.join(os.homedir(), '.cursor'),
  spineHome = process.env.SPINE_HOME || os.homedir(),
  claudeHome,
} = {}) {
  const cfg = spineConfig(spineHome);
  const imported = cfg.cursor_import_claude === true ? installedPlugins(claudeHome) : [];
  return [...new Set([...configuredProviders(cfg), ...cachedPlugins(cursorHome), ...localPlugins(cursorHome), ...imported])].sort();
}

function installedProviders(host = 'claude', opts = {}) {
  return host === 'cursor' ? installedProvidersCursor(opts) : installedPlugins(opts.claudeHome);
}

module.exports = { installedProvidersCursor, installedProviders };
