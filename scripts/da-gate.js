'use strict';
const { listRecords } = require('./lib/records');
const { daGateOpen } = require('./lib/cross-author');

const [runDir, flag, value] = process.argv.slice(2);
if (!runDir || flag !== '--devils-advocate' || !['true', 'false'].includes(value)) {
  process.stderr.write('usage: da-gate.js <run-dir> --devils-advocate true|false\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(daGateOpen(listRecords(runDir).map((r) => r.record), value === 'true')) + '\n');
