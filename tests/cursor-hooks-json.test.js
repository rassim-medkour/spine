'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LOOP_LIMIT } = require('../scripts/lib/followup-counter');

const ROOT = path.join(__dirname, '..');
const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'cursor-hooks.json'), 'utf8'));
const EXPECTED = { sessionStart: 'session-start.js', stop: 'stop.js', subagentStop: 'subagent-stop.js', postToolUse: 'after-edit.js', afterFileEdit: 'after-edit.js' };
const CMD = /^node \.\/scripts\/cursor\/([a-z-]+\.js)$/;

test('Cursor hooks file is version 1', () => {
  assert.equal(file.version, 1);
});

for (const [event, script] of Object.entries(EXPECTED)) {
  test(`${event} is wired to an existing scripts/cursor/${script} with a plugin-root-relative command and numeric timeout`, () => {
    const entries = file.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length === 1, `${event} missing`);
    const m = CMD.exec(entries[0].command);
    assert.ok(m, `bad command: ${entries[0].command}`);
    assert.equal(m[1], script);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'cursor', script)));
    assert.equal(typeof entries[0].timeout, 'number');
  });
}

for (const event of ['stop', 'subagentStop']) {
  test(`${event} sets a finite loop_limit between 1 and 5 equal to the spine counter cap`, () => {
    const limit = file.hooks[event][0].loop_limit;
    assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 5, `loop_limit ${limit}`);
    assert.equal(limit, LOOP_LIMIT);
  });
}

test('postToolUse matches the Write tool', () => {
  assert.equal(file.hooks.postToolUse[0].matcher, 'Write');
});

test('no Cursor hook entry sets failClosed', () => {
  for (const [event, entries] of Object.entries(file.hooks)) {
    for (const e of entries) assert.notEqual(e.failClosed, true, `${event} sets failClosed`);
  }
});

test('Cursor hook commands never use a plugin-root variable', () => {
  assert.doesNotMatch(JSON.stringify(file), /PLUGIN_ROOT/);
});
