'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PARSER_VERSION } = require('./imports');

const CACHE_FORMAT = 1;
const KEY_RE = /^[a-z]+:[0-9a-f]{40,64}$/;

function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function cachePath(root, artifactsDir) {
  return path.join(root, artifactsDir, 'cache', `imports-p${PARSER_VERSION}.json`);
}

function validSpec(s) {
  return s && (typeof s.specifier === 'string' || s.specifier === null) && typeof s.literal === 'boolean'
    && (s.names === undefined || (Array.isArray(s.names) && s.names.every((n) => typeof n === 'string')));
}

function validEntry(e) {
  return e && typeof e.parser === 'string' && Array.isArray(e.specs) && e.specs.every(validSpec);
}

const EMPTY = (status) => ({ entries: new Map(), status });

function loadCache(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return EMPTY('missing');
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || doc.format !== CACHE_FORMAT || doc.parser_version !== PARSER_VERSION || !doc.entries || typeof doc.entries !== 'object') return EMPTY('discarded');
    const pairs = Object.entries(doc.entries);
    if (!pairs.every(([k, v]) => KEY_RE.test(k) && validEntry(v))) return EMPTY('discarded');
    return { entries: new Map(pairs), status: 'loaded' };
  } catch {
    return EMPTY('discarded');
  }
}

function saveCache(file, entries, keepKeys) {
  try {
    const keep = [...entries.keys()].filter((k) => keepKeys.has(k)).sort();
    const doc = { format: CACHE_FORMAT, parser_version: PARSER_VERSION, entries: Object.fromEntries(keep.map((k) => [k, entries.get(k)])) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(doc));
    fs.renameSync(tmpFile, file);
    return 'saved';
  } catch {
    return 'not-saved';
  }
}

module.exports = { CACHE_FORMAT, gitBlobSha, cachePath, loadCache, saveCache };
