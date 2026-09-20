const test = require('node:test');
const assert = require('node:assert/strict');
const { readHookInput, emitContext } = require('../scripts/lib/hook-io');

test('readHookInput returns {} on empty stdin', () => {
  assert.deepEqual(readHookInput(''), {});
});

test('readHookInput returns {} on invalid JSON', () => {
  assert.deepEqual(readHookInput('not json'), {});
});

test('readHookInput parses a Stop payload', () => {
  const payload = { session_id: 's1', cwd: 'C:/repo', hook_event_name: 'Stop', stop_hook_active: false };
  assert.deepEqual(readHookInput(JSON.stringify(payload)), payload);
});

test('emitContext wraps text in hookSpecificOutput', () => {
  const out = JSON.parse(emitContext('SessionStart', 'hello'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(out.hookSpecificOutput.additionalContext, 'hello');
});
