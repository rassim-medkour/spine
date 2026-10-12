'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nextRecordId } = require('./records');
const { issueText } = require('./safe-text');
const { LOOP_LIMIT } = require('./followup-counter');

const RECORD_STAGES = new Set(['intent', 'spec', 'plan', 'implement', 'review']);

function writeCapRecord(run, issues) {
  const stage = run.state.stage;
  if (!RECORD_STAGES.has(stage)) return null;
  const id = nextRecordId(run.dir);
  const record = {
    id,
    stage,
    agent: 'spine:stop-hook',
    claim: `Stop cap-reached: stage ${stage} ended without being gate-clean after ${LOOP_LIMIT} followups`,
    evidence: [{ kind: 'doc', ref: 'hooks.log', note: issues.map(issueText).join('; ') }],
    confidence: 1,
    severity: 'MEDIUM',
    dissent: null,
    resolution: null,
    alternatives: [],
    host: 'cursor',
  };
  const recDir = path.join(run.dir, 'records');
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return id;
}

module.exports = { writeCapRecord };
