'use strict';
// Child-process entry for cursor-models.js: node cursor-state-reader.js <dbPath> <capBytes>
// Opens state.vscdb read-only, extracts model ids only, prints one JSON object.
// It never prints the stored value or any other field of it.
const KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

function say(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function safeReason(e) {
  const text = String((e && e.message) || e || '').replace(/\S*[\/]\S*/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `state.vscdb unreadable: ${(e && e.code) || text || 'error'}`;
}

function main() {
  const dbPath = process.argv[2];
  const cap = Number(process.argv[3]);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return say({ error: 'node:sqlite unavailable' });
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const sized = db.prepare('SELECT length(value) AS n FROM ItemTable WHERE key = ?').get(KEY);
    if (!sized) return say({ error: 'model list key not found' });
    if (!(sized.n <= cap)) return say({ error: 'model list over size cap' });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY);
    const text = Buffer.isBuffer(row.value) || row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : String(row.value);
    const { parseApplicationUser } = require('./cursor-models');
    return say(parseApplicationUser(JSON.parse(text)));
  } catch (e) {
    return say({ error: safeReason(e) });
  } finally {
    try {
      if (db) db.close();
    } catch {
      // closing a read-only handle; nothing to report
    }
  }
}

main();
