'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateRecord } = require('./validate');
const { nextRecordId } = require('./records');
const { RUN_ID_RE } = require('./state');

const FLAG_KEYS = Object.freeze({
  '--provider': 'provider', '--author': 'author', '--verifies': 'verifies', '--verifier-note': 'verifier_note', '--host': 'host',
});

function stamp(record, flags) {
  const out = { ...record };
  for (const [flag, key] of Object.entries(FLAG_KEYS)) if (flags[flag]) out[key] = flags[flag];
  if (flags['--verified']) out.verified = flags['--verified'] === 'true';
  return out;
}

function writeRecords(runDir, records, flags = {}) {
  if (!runDir || !RUN_ID_RE.test(path.basename(runDir)) || !fs.existsSync(path.join(runDir, 'state.json'))) {
    throw new Error('first argument must be an existing <artifacts_dir>/<run-id> directory with state.json');
  }
  const stamped = records.map((r) => stamp(r, flags));
  const problems = stamped.flatMap((r, i) => validateRecord({ ...r, id: 'R-0000' }).map((e) => `record ${i + 1}: ${e}`));
  if (problems.length) throw new Error(problems.join('; '));
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  return stamped.map((r) => {
    const id = nextRecordId(runDir);
    fs.writeFileSync(path.join(runDir, 'records', `${id}.json`), JSON.stringify({ ...r, id }, null, 2) + '\n', { flag: 'wx' });
    return id;
  });
}

module.exports = { writeRecords, stamp };
