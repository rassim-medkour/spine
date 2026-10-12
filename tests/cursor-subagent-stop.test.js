// tests/cursor-subagent-stop.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, FIX, cursorRepo, fixture, runCursor, readLog, tmp } = require('./helpers/cursor-repo');
const { lastAssistantTextCursor, readTail } = require('../scripts/lib/host/cursor-transcript');

const T = (n) => path.join(FIX, 'cursor', n);
const REVIEW = { ...BASE, stage: 'review', size: 'M' };
const sub = (r, transcript, extra = {}) => runCursor('subagent-stop.js', { ...fixture('subagent-stop.json'), workspace_roots: [r.root], summary: undefined, agent_transcript_path: transcript, ...extra }, { SPINE_HOME: r.home });
const followupOf = (res) => (res.stdout.trim() ? JSON.parse(res.stdout).followup_message : undefined);

test('a valid spine-record block allows', () => {
  assert.equal(followupOf(sub(cursorRepo(REVIEW), T('transcript-record-ok.jsonl'))), undefined);
});
test('an invalid record gets a followup listing each validateRecord error', () => {
  const r = cursorRepo(REVIEW);
  const res = sub(r, T('transcript-record-bad.jsonl'));
  assert.equal(res.status, 0);
  assert.match(followupOf(res), /severity CRITICAL requires at least one evidence item that is not unverified/);
  assert.match(readLog(r.dir), / SubagentStop followup host=cursor/);
});
test('a malformed spine-record block gets a followup', () => {
  const t = path.join(tmp('spine-t-'), 't.jsonl');
  fs.writeFileSync(t, JSON.stringify({ role: 'assistant', content: '```json spine-record\n{not json\n```' }) + '\n');
  assert.match(followupOf(sub(cursorRepo(REVIEW), t)), /not valid JSON/);
});
test('no record block allows', () => {
  const t = path.join(tmp('spine-t-'), 't.jsonl');
  fs.writeFileSync(t, JSON.stringify({ role: 'assistant', content: 'plain answer' }) + '\n');
  assert.equal(followupOf(sub(cursorRepo(REVIEW), t)), undefined);
});
for (const awaiting of ['G1', 'G2', 'G3', 'human']) {
  test(`never a followup while awaiting ${awaiting}`, () => {
    assert.equal(followupOf(sub(cursorRepo({ ...REVIEW, awaiting }), T('transcript-record-bad.jsonl'))), undefined);
  });
}
test('a directory transcript path fails open and logs', () => {
  const r = cursorRepo(REVIEW);
  const res = sub(r, tmp('spine-dir-'));
  assert.equal(followupOf(res), undefined);
  assert.match(res.stderr, /^spine: cursor subagentStop error: transcript not-file/m);
  assert.match(readLog(r.dir), / SubagentStop error host=cursor/);
});
test('a missing transcript fails open', () => {
  assert.equal(followupOf(sub(cursorRepo(REVIEW), path.join(tmp('spine-x-'), 'none.jsonl'))), undefined);
});
test('an unknown JSONL shape fails open', () => {
  const res = sub(cursorRepo(REVIEW), T('transcript-unknown.jsonl'));
  assert.equal(followupOf(res), undefined);
  assert.match(res.stderr, /transcript unrecognized/);
});
test('readTail reads only the last bytes of a large transcript', () => {
  const t = path.join(tmp('spine-big-'), 'big.jsonl');
  fs.writeFileSync(t, 'x'.repeat(100) + '\n' + JSON.stringify({ role: 'assistant', content: 'tail' }) + '\n');
  const tail = readTail(t, 40);
  assert.equal(tail.truncated, true);
  assert.ok(tail.text.length <= 40);
});
test('the Cursor parser skips a partial first line after truncation', () => {
  const t = path.join(tmp('spine-big-'), 'big.jsonl');
  fs.writeFileSync(t, JSON.stringify({ role: 'assistant', content: 'x'.repeat(6 * 1024 * 1024) }) + '\n' + JSON.stringify({ role: 'assistant', content: 'last' }) + '\n');
  assert.deepEqual(lastAssistantTextCursor(t), { text: 'last', error: null });
});

test('a spine-record block in the summary is checked without reading a transcript', () => {
  const bad = fs.readFileSync(T('transcript-record-bad.jsonl'), 'utf8').split(String.fromCharCode(10))[1];
  const summary = JSON.parse(bad).message.content[0].text;
  const res = sub(cursorRepo(REVIEW), path.join(tmp('spine-x-'), 'none.jsonl'), { summary });
  assert.match(followupOf(res), /severity CRITICAL requires at least one evidence item/);
});
test('a summary without a record falls back to the subagent transcript', () => {
  const res = sub(cursorRepo(REVIEW), T('transcript-record-bad.jsonl'), { summary: 'The file contains hi.' });
  assert.match(followupOf(res), /severity CRITICAL requires/);
});
test('a subagent that errored or was aborted never gets a followup', () => {
  for (const status of ['error', 'aborted']) {
    assert.equal(followupOf(sub(cursorRepo(REVIEW), T('transcript-record-bad.jsonl'), { status })), undefined);
  }
});
test('the parent transcript_path is never read as the subagent output', () => {
  const res = sub(cursorRepo(REVIEW), undefined, { transcript_path: T('transcript-record-bad.jsonl') });
  assert.equal(followupOf(res), undefined);
});
