'use strict';
const { readHookPayload } = require('../lib/stdin');
const { normalizeCursorInput, contextOutput, appendCursorLog, reportError, reportBadStdin } = require('../lib/host/cursor');
const { locateRun } = require('../lib/root');
const { loadRegistry } = require('../lib/providers');
const { installedProviders } = require('../lib/cursor-providers');
const { missingFrom, buildSessionLines } = require('../lib/session');
const { safeStage } = require('../lib/safe-text');
const { listRecords } = require('../lib/records');

const HOOK = 'cursor sessionStart';
const EVENT = 'SessionStart';
// Invocation form confirmed by spike T-3.
const CURSOR_STATUS_COMMAND = '/spine status';
const AWAITING = ['G1', 'G2', 'G3', 'human'];
const HOSTS = ['cursor', 'claude-code'];

function safeRun(run) {
  const awaiting = AWAITING.includes(run.state.awaiting) ? run.state.awaiting : null;
  return { ...run, state: { ...run.state, stage: safeStage(run.state.stage), awaiting } };
}

function extraLines(run) {
  const lines = [];
  const host = run.state.host;
  if (host && host !== 'cursor') {
    lines.push(`spine: run ${run.id} was last written by ${HOSTS.includes(host) ? host : 'another host'}. Drive a run from one host at a time.`);
  }
  const capped = listRecords(run.dir).some((r) => r.record.agent === 'spine:stop-hook' && r.record.stage === run.state.stage);
  if (capped) {
    lines.push(`spine: stage ${safeStage(run.state.stage)} of run ${run.id} ended without being gate-clean (Stop cap-reached). Finish it before the next gate.`);
  }
  return lines;
}

function main() {
  const { payload, error } = readHookPayload();
  if (error) {
    reportBadStdin(HOOK, error);
    return;
  }
  const input = normalizeCursorInput(payload);
  let run = null;
  try {
    const located = locateRun(input);
    if (located.disabled) return;
    run = located.run;
    const missing = missingFrom(loadRegistry('cursor'), installedProviders('cursor'));
    const lines = buildSessionLines({ missing, run: run && safeRun(run), statusCommand: CURSOR_STATUS_COMMAND, extra: run ? extraLines(run) : [] });
    if (run) appendCursorLog(run, EVENT, 'allow', input.conversationId);
    if (lines.length) process.stdout.write(contextOutput(lines.join('\n')));
  } catch (err) {
    reportError(HOOK, err, run, input.conversationId, EVENT);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`spine: ${HOOK} error: ${(err && err.name) || 'Error'}\n`);
}
