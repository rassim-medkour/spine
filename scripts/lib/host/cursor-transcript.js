'use strict';
const fs = require('node:fs');

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

function readTail(file, max = MAX_TRANSCRIPT_BYTES) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { text: '', truncated: false, error: 'missing' };
  }
  if (!stat.isFile()) return { text: '', truncated: false, error: 'not-file' };
  const start = Math.max(0, stat.size - max);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), truncated: start > 0, error: null };
  } finally {
    fs.closeSync(fd);
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  return parts.length ? parts.join('\n') : null;
}

function assistantTextOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const role = entry.role || entry.type || (entry.message && entry.message.role);
  if (role !== 'assistant') return null;
  const content = entry.message && entry.message.content !== undefined ? entry.message.content : entry.content;
  return contentText(content);
}

function lastAssistantTextCursor(file) {
  const tail = readTail(file);
  if (tail.error) return { text: '', error: tail.error };
  const lines = tail.text.split(/\r?\n/).filter(Boolean);
  if (tail.truncated) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = assistantTextOf(entry);
    if (text !== null) return { text, error: null };
  }
  return { text: '', error: 'unrecognized' };
}

module.exports = { MAX_TRANSCRIPT_BYTES, readTail, lastAssistantTextCursor };
