'use strict';
const { readHookPayload } = require('../lib/stdin');
const { normalizeCursorInput, stopOutput, capOutput, appendCursorLog, reportError, reportBadStdin } = require('../lib/host/cursor');
const { locateRun } = require('../lib/root');
const { evaluateStop } = require('../lib/gate');
const { buildStopFollowup, buildCapMessage } = require('../lib/safe-text');
const { LOOP_LIMIT, counterKey, followupCount, setCount, resetCount } = require('../lib/followup-counter');
const { writeCapRecord } = require('../lib/cap-record');

const HOOK = 'cursor stop';
const EVENT = 'Stop';

function allowLogged(run, input) {
  appendCursorLog(run, EVENT, 'allow', input.conversationId);
  return '{}';
}

function followupOrCap(run, verdict, input, key, message) {
  const used = followupCount(run.dir, key);
  if (used < LOOP_LIMIT) {
    setCount(run.dir, key, used + 1);
    appendCursorLog(run, EVENT, 'followup', input.conversationId);
    return stopOutput(message);
  }
  const cap = buildCapMessage(run, verdict.issues);
  process.stderr.write(`${cap}\n`);
  appendCursorLog(run, EVENT, 'cap-reached', input.conversationId);
  if (used === LOOP_LIMIT) {
    writeCapRecord(run, verdict.issues);
    setCount(run.dir, key, used + 1);
  }
  return capOutput(cap);
}

function decide(run, config, input) {
  if (input.status && input.status !== 'completed') return allowLogged(run, input);
  const verdict = evaluateStop(run, config);
  const key = counterKey(input.conversationId, 'stop', run.state.stage);
  if (verdict.decision === 'allow') {
    resetCount(run.dir, key);
    return allowLogged(run, input);
  }
  const message = buildStopFollowup(run, verdict.issues);
  if (verdict.decision === 'warn') {
    process.stderr.write(`${message}\n`);
    appendCursorLog(run, EVENT, 'warn', input.conversationId);
    return '{}';
  }
  return followupOrCap(run, verdict, input, key, message);
}

function main() {
  const { payload, error } = readHookPayload();
  if (error) {
    reportBadStdin(HOOK, error);
    process.stdout.write('{}');
    return;
  }
  const input = normalizeCursorInput(payload);
  let run = null;
  try {
    const located = locateRun(input);
    run = located.run;
    process.stdout.write(run ? decide(run, located.config, input) : '{}');
  } catch (err) {
    reportError(HOOK, err, run, input.conversationId, EVENT);
    process.stdout.write('{}');
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`spine: ${HOOK} error: ${(err && err.name) || 'Error'}\n`);
  process.stdout.write('{}');
}
