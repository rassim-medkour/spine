'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SECTIONS } = require('../scripts/lib/pr-body');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the PR template mirrors pr-body.js sections in the same order', () => {
  const headings = read('.github/pull_request_template.md').split(/\r?\n/).filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  assert.deepEqual(headings, SECTIONS.map((s) => s.title));
  assert.match(read('.github/pull_request_template.md'), /never delete "Not verified" when it has content/i);
});

for (const rel of ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md']) {
  test(`${rel} runs pr-body.js when opening a PR`, () => {
    const text = read(rel);
    for (const needle of ['### Opening a PR (after G3)', 'scripts/pr-body.js --run', '<run>/pr-written.md', '--body-file <run>/pr-body.md', 'no attribution']) {
      assert.ok(text.includes(needle), `${rel} is missing ${needle}`);
    }
  });
}
