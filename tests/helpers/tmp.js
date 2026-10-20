'use strict';
// Temp dirs for tests. Every dir is removed: after the given test when a test
// context is passed, and always when the process exits (covers dirs made in
// helpers or outside a test body). Removal ignores errors, so a dir still held
// open by a child process on Windows never fails a test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = new Set();

function remove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // best effort
  }
  made.delete(dir);
}

function cleanupAll() {
  for (const dir of [...made]) remove(dir);
}

process.on('exit', cleanupAll);

function tmpDir(prefix = 'spine-', t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  if (t && typeof t.after === 'function') t.after(() => remove(dir));
  return dir;
}

module.exports = { tmpDir, cleanupAll };
