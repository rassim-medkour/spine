'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function cursorSection() {
  const start = README.indexOf('\n## Cursor (experimental)\n');
  assert.ok(start >= 0, 'README needs a "## Cursor (experimental)" section');
  const rest = README.slice(start + 1);
  const next = rest.slice(3).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

test('README head no longer says Claude Code only', () => {
  assert.doesNotMatch(README.split('\n').slice(0, 30).join('\n'), /Claude Code only/);
});
test('Cursor install gives only the canonical repo URL and the Marketplace path', () => {
  const s = cursorSection();
  assert.match(s, /Customize/);
  assert.match(s, /Marketplace/);
  assert.ok(s.includes('https://github.com/rassim-medkour/spine'));
  assert.doesNotMatch(s, /github\.com\/(?!rassim-medkour\/spine)[\w-]+\/spine/);
  assert.match(s, /normal Cursor plan/);
  assert.match(s, /no API key/i);
  assert.doesNotMatch(s, /CURSOR_API_KEY/);
});
test('Cursor section says plainly that it has not been tested in a live Cursor session', () => {
  const s = cursorSection();
  assert.match(s, /built from Cursor's documentation/);
  assert.match(s, /NOT yet been tested in a live Cursor agent session/);
});
test('Cursor section lists the known limits', () => {
  const s = cursorSection();
  assert.match(s, /up to 3 times instead of blocking/);
  assert.match(s, /honor-system/);
  assert.match(s, /no Workflow-tool fan-out/i);
  assert.match(s, /imported Claude skills/i);
  assert.match(s, /one host at a time/i);
  assert.match(s, /Stop cap-reached/);
  assert.match(s, /"strictness": "warn"/);
});
test('the README Cursor section keeps the glossary', () => {
  for (const re of [/\bcheckpoints?\b/i, /\bmilestones?\b/i, /\bphase gates?\b/i, /\btiers?\b/i, /\bfinding files?\b/i]) assert.doesNotMatch(cursorSection(), re);
});
