'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./state');

function listRecords(dir) {
  const recDir = path.join(dir, 'records');
  let files = [];
  try {
    files = fs.readdirSync(recDir).filter((f) => /^R-\d+\.json$/.test(f)).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => ({ file, record: readJson(path.join(recDir, file)) }))
    .filter((r) => r.record);
}

function latestBoundaryPass(dir, stage) {
  const checks = listRecords(dir)
    .map((r) => r.record)
    .filter((r) => r.agent === 'spine:boundary-checker' && r.stage === stage);
  if (!checks.length) return false;
  return checks[checks.length - 1].claim === 'PASS';
}

function nextRecordId(dir) {
  const ids = listRecords(dir).map((r) => Number(r.file.slice(2, -5)));
  const max = ids.length ? Math.max(...ids) : 0;
  return `R-${String(max + 1).padStart(4, '0')}`;
}

module.exports = { listRecords, latestBoundaryPass, nextRecordId };
