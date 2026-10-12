'use strict';
const { readHookPayload } = require('../lib/stdin');
const { normalizeCursorInput, stopOutput, appendCursorLog, reportError, reportBadStdin } = require('../lib/host/cursor');
const { lastAssistantTextCursor } = require('../lib/host/cursor-transcript');
const { locateRun } = require('../lib/root');
const { evaluateSubagentText, extractRecordBlock, HUMAN_WAIT } = require('../lib/gate');
const { buildSubagentFollowup } = require('../lib/safe-text');
const { LOOP_LIMIT, counterKey, followupCount, setCount, resetCount } = require('../lib/followup-counter');

const HOOK = 'cursor subagentStop';
const EVENT = 'SubagentStop';

function exempt(run) {
  return run.state.status !== 'active' || HUMAN_WAIT.includes(run.state.awaiting) || run.state.stage === 'done';
}

// subagentStop carries the subagent's own `summary` and `agent_transcript_path` (spike T-1).
// Prefer a summary that holds a record block; otherwise read the subagent transcript.
// The parent transcript_path is never used: it is not the subagent's output.
function subagentText(input) {
  if (input.finalText && extractRecordBlock(input.finalText)) return { text: input.finalText, error: null };
  if (!input.agentTranscriptPath) return { text: '', error: null };
  return lastAssistantTextCursor(input.agentTranscriptPath);
}

function failing(run, input, verdict) {
  const message = buildSubagentFollowup(verdict);
  if (verdict.decision === 'warn') {
    process.stderr.write(`${message}\n`);
    appendCursorLog(run, EVENT, 'warn', input.conversationId);
    return '{}';
  }
  const key = counterKey(input.conversationId, 'subagent', run.state.stage);
  const used = followupCount(run.dir, key);
  if (used >= LOOP_LIMIT) {
    process.stderr.write(`spine: ${HOOK} cap-reached for run ${run.id}; the record was not fixed.\n`);
    appendCursorLog(run, EVENT, 'cap-reached', input.conversationId);
    return '{}';
  }
  setCount(run.dir, key, used + 1);
  appendCursorLog(run, EVENT, 'followup', input.conversationId);
  return stopOutput(message);
}

function decide(run, config, input) {
  if (exempt(run) || (input.status && input.status !== 'completed')) {
    appendCursorLog(run, EVENT, 'allow', input.conversationId);
    return '{}';
  }
  const read = subagentText(input);
  if (read.error) {
    process.stderr.write(`spine: ${HOOK} error: transcript ${read.error}, record not checked\n`);
    appendCursorLog(run, EVENT, 'error', input.conversationId);
    return '{}';
  }
  const verdict = evaluateSubagentText(read.text, config);
  if (verdict.decision !== 'allow') return failing(run, input, verdict);
  resetCount(run.dir, counterKey(input.conversationId, 'subagent', run.state.stage));
  appendCursorLog(run, EVENT, 'allow', input.conversationId);
  return '{}';
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
