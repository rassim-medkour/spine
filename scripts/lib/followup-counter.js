'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./state');

// Must equal loop_limit in hooks/cursor-hooks.json (asserted in cursor-hooks-json.test.js).
const LOOP_LIMIT = 3;
const COUNTER_FILE = 'followups.json';
const MAX_KEY_PART = 128;

function counterKey(conversationId, hook, stage) {
  return `${String(conversationId || 'unknown').slice(0, MAX_KEY_PART)}|${hook}|${stage}`;
}

function readCounts(dir) {
  const data = readJson(path.join(dir, COUNTER_FILE));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeCounts(dir, counts) {
  fs.writeFileSync(path.join(dir, COUNTER_FILE), JSON.stringify(counts, null, 2) + '\n');
}

function followupCount(dir, key) {
  const n = readCounts(dir)[key];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function setCount(dir, key, n) {
  writeCounts(dir, { ...readCounts(dir), [key]: n });
}

function resetCount(dir, key) {
  const counts = readCounts(dir);
  if (!(key in counts) && fs.existsSync(path.join(dir, COUNTER_FILE))) return;
  writeCounts(dir, Object.fromEntries(Object.entries(counts).filter(([k]) => k !== key)));
}

module.exports = { LOOP_LIMIT, COUNTER_FILE, counterKey, followupCount, setCount, resetCount };
