'use strict';
const fs = require('node:fs');

const MAX_STDIN_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_EAGAIN_RETRIES = 200;
const EAGAIN_SLEEP_MS = 5;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reads at most `max` bytes. Never throws.
function readStdinCapped(fd = 0, max = MAX_STDIN_BYTES) {
  const chunks = [];
  const buf = Buffer.alloc(CHUNK_BYTES);
  let total = 0;
  let retries = 0;
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
    } catch (e) {
      if (e.code === 'EAGAIN' && retries++ < MAX_EAGAIN_RETRIES) {
        sleepMs(EAGAIN_SLEEP_MS);
        continue;
      }
      if (e.code === 'EOF') break;
      return { text: '', error: 'unreadable' };
    }
    if (n === 0) break;
    total += n;
    if (total > max) return { text: '', error: 'oversized' };
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? { text, error: null } : { text: '', error: 'empty' };
}

function parseHookJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readHookPayload(fd = 0, max = MAX_STDIN_BYTES) {
  const { text, error } = readStdinCapped(fd, max);
  if (error) return { payload: null, error };
  const payload = parseHookJson(text);
  return payload ? { payload, error: null } : { payload: null, error: 'non-json' };
}

module.exports = { MAX_STDIN_BYTES, readStdinCapped, parseHookJson, readHookPayload };
