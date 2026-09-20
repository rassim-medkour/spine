const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const SKILLS = ['record-contract', 'gap-check'];

for (const name of SKILLS) {
  test(`${name} skill has name and description frontmatter`, () => {
    const file = path.join(__dirname, '..', 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${file} missing`);
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(fm.name, name);
    assert.ok(fm.description.length > 40);
  });
}

test('gap-check lists the six absence questions', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'gap-check', 'SKILL.md'), 'utf8');
  for (const needle of ['Acceptance criteria', 'Error paths', 'migration', 'Non-functional', 'Test anchors', 'Out of scope']) {
    assert.match(text, new RegExp(needle));
  }
});
