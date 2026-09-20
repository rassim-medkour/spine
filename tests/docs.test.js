const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STALE_COMMAND = /\/spine (intent|adopt|implement|review|status|resume)\b/;

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('README.md uses the namespaced /spine:spine command, not bare /spine', () => {
  const text = read('README.md');
  assert.doesNotMatch(text, STALE_COMMAND);
  assert.match(text, /\/spine:spine review/);
});

test('skills/spine/SKILL.md uses the namespaced /spine:spine command, not bare /spine', () => {
  const text = read('skills/spine/SKILL.md');
  assert.doesNotMatch(text, STALE_COMMAND);
  assert.match(text, /\/spine:spine review/);
});
