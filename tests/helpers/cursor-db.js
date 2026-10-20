'use strict';
// Builds a fake Cursor user dir with a state.vscdb holding the model list key.
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

function sqliteAvailable() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

// value: object (stored as JSON) or null (table without the key).
function makeDb(userDir, value) {
  const dir = path.join(userDir, 'User', 'globalStorage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.vscdb');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  if (value !== null) db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(value));
  db.close();
  return file;
}

module.exports = { KEY, makeDb, sqliteAvailable };
