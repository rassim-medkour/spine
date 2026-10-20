'use strict';
// Local, read-only, time-boxed discovery of the models a Cursor install offers.
// Reads ONLY model ids from Cursor's state.vscdb through a child process; no
// network, no writes, nothing else from that database is copied or returned.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MODEL_ID_RE } = require('./model-policy');

const READER = path.join(__dirname, 'cursor-state-reader.js');
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_VALUE_CAP_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const CLASS_FAMILIES = Object.freeze({
  top: /^claude-opus-(\d+(?:-\d+)*)$/,
  mid: /^claude-sonnet-(\d+(?:-\d+)*)$/,
  cheap: /^claude-haiku-(\d+(?:-\d+)*)$/,
});

function cursorUserDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SPINE_CURSOR_HOME) return env.SPINE_CURSOR_HOME;
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'Cursor') : null;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor');
  return path.join(home, '.config', 'Cursor');
}

const validId = (v) => (typeof v === 'string' && MODEL_ID_RE.test(v) ? v : null);
const idList = (v) => (Array.isArray(v) ? v.map(validId).filter(Boolean) : []);
const uniqueSorted = (ids) => [...new Set(ids)].sort();

// Ids only. Every other field of the application-user JSON is ignored.
function parseApplicationUser(json) {
  const models = json && Array.isArray(json.availableDefaultModels2) ? json.availableDefaultModels2 : [];
  const found = [];
  const defaults = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const id = validId(m.name) || validId(m.serverModelName);
    if (!id) continue;
    found.push(id);
    if (m.defaultOn === true && m.supportsAgent !== false) defaults.push(id);
  }
  const ai = json && json.aiSettings && typeof json.aiSettings === 'object' ? json.aiSettings : {};
  return {
    found: uniqueSorted(found),
    defaults: uniqueSorted(defaults),
    enabled: uniqueSorted(idList(ai.modelOverrideEnabled)),
    disabled: uniqueSorted(idList(ai.modelOverrideDisabled)),
  };
}

function availableModels(parsed) {
  const disabled = new Set(parsed.disabled);
  const defaults = parsed.defaults || [];
  return uniqueSorted([...defaults.filter((id) => !disabled.has(id)), ...parsed.enabled]);
}

function versionOf(id, re) {
  const m = re.exec(id);
  return m ? m[1].split('-').map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function mapClasses(found) {
  const out = {};
  for (const cls of ['cheap', 'mid', 'top']) {
    const re = CLASS_FAMILIES[cls];
    const family = re.source.replace(/^\^/, '').replace(/-\(.*$/, '');
    let best = null;
    let bestVersion = null;
    for (const id of found) {
      const v = versionOf(id, re);
      if (v && (!best || compareVersions(v, bestVersion) > 0)) {
        best = id;
        bestVersion = v;
      }
    }
    out[cls] = best ? { model: best, reason: `highest ${family} found` } : { model: null, reason: `no ${family} model found; inherit` };
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function result(found, source, reason, extra = {}) {
  return { found, source, reason, mtime_ms: null, source_hash: null, ...extra };
}

function fromConfig(configModels, reason) {
  const ids = uniqueSorted(idList(configModels));
  return ids.length ? result(ids, 'config', null) : result([], 'none', reason);
}

function discoverCursorModels({ userDir, configModels, timeoutMs = DEFAULT_TIMEOUT_MS, valueCapBytes = DEFAULT_VALUE_CAP_BYTES, readerPath } = {}) {
  const dbPath = userDir ? path.join(userDir, 'User', 'globalStorage', 'state.vscdb') : null;
  if (!dbPath || !fs.existsSync(dbPath)) return fromConfig(configModels, 'state.vscdb not found');
  const r = spawnSync(process.execPath, ['--no-warnings', readerPath || READER, dbPath, String(valueCapBytes)], {
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal) return fromConfig(configModels, 'discovery timed out');
  if (r.error) return fromConfig(configModels, 'state.vscdb unreadable: reader failed to start');
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return fromConfig(configModels, 'state.vscdb unreadable: reader output invalid');
  }
  if (!parsed || parsed.error) return fromConfig(configModels, parsed && typeof parsed.error === 'string' ? parsed.error : 'state.vscdb unreadable');
  const found = uniqueSorted([...availableModels(parsed), ...idList(configModels)]);
  let mtime = null;
  try {
    mtime = Math.trunc(fs.statSync(dbPath).mtimeMs);
  } catch {
    mtime = null;
  }
  return result(found, 'state-db', null, { mtime_ms: mtime, source_hash: sha256(dbPath) });
}

module.exports = {
  CLASS_FAMILIES, cursorUserDir, parseApplicationUser, availableModels, mapClasses, discoverCursorModels,
};
