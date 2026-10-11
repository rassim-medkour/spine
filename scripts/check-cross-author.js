'use strict';
const { listRecords } = require('./lib/records');
const { loadRegistry } = require('./lib/providers');
const { checkCrossAuthor, authorIndex } = require('./lib/cross-author');

const runDir = process.argv[2];
if (!runDir) {
  process.stderr.write('usage: check-cross-author.js <run-dir>\n');
  process.exit(1);
}
const authorOf = authorIndex([loadRegistry('claude'), loadRegistry('cursor')]);
const violations = checkCrossAuthor(listRecords(runDir).map((r) => r.record), authorOf);
process.stdout.write(JSON.stringify({ ok: violations.length === 0, violations }, null, 2) + '\n');
process.exit(violations.length ? 1 : 0);
