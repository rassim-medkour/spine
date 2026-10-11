'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { listRecords } = require('./lib/records');
const { loadRegistry } = require('./lib/providers');
const { verifierPlan, authorIndex } = require('./lib/cross-author');

const [runDir, flag, providersFile] = process.argv.slice(2);
if (!runDir || flag !== '--providers' || !providersFile) {
  process.stderr.write('usage: pick-verifier.js <run-dir> --providers <select-providers output file>\n');
  process.exit(1);
}
const providers = JSON.parse(fs.readFileSync(path.resolve(providersFile), 'utf8'));
const authorOf = authorIndex([loadRegistry('claude'), loadRegistry('cursor')]);
const records = listRecords(runDir).map((r) => r.record);
process.stdout.write(JSON.stringify(verifierPlan(records, providers, authorOf), null, 2) + '\n');
