const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('hooks.json wires the four events to existing scripts', () => {
  const file = path.join(__dirname, '..', 'hooks', 'hooks.json');
  const { hooks } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = { SessionStart: 'session-start.js', Stop: 'stop-gate.js', SubagentStop: 'subagent-gate.js', PostToolUse: 'validate-artifact.js' };
  for (const [event, script] of Object.entries(expected)) {
    assert.ok(hooks[event], `${event} missing`);
    const cmd = hooks[event][0].hooks[0].command;
    assert.ok(cmd.includes(`\${CLAUDE_PLUGIN_ROOT}/scripts/${script}`), `${event} command does not reference ${script}`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', script)), `${script} missing`);
    assert.equal(hooks[event][0].hooks[0].timeout, 10, `${event} hook entry is missing timeout: 10`);
  }
  assert.equal(hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit');
});
