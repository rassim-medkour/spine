'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['README.md', 'skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md', 'schemas/tree.json', 'schemas/review.json', '.github/pull_request_template.md'];
const BANNED = [/\brisk level\b/i, /\bcore\b/i, /\bcritical tier\b/i];

for (const rel of FILES) {
  test(`${rel} uses the fixed tier vocabulary`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of BANNED) assert.doesNotMatch(text, re, `${rel}: ${re}`);
  });
}

test('the reading-map renderer uses the fixed vocabulary', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'reading-map.js'), 'utf8');
  for (const re of BANNED) assert.doesNotMatch(text, re);
  for (const word of ['Read yourself', 'Skim', 'Skip', 'one-way door', 'no proof']) assert.ok(text.includes(word), word);
});
