const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const AGENTS = ['boundary-checker', 'devils-advocate', 'synthesis'];

for (const name of AGENTS) {
  test(`${name} has frontmatter, read-only tools, and the record block instruction`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
    const fm = parseFrontmatter(text);
    assert.equal(fm.name, name);
    assert.ok(fm.description.length > 40);
    assert.ok(!/\b(Write|Edit)\b/.test(fm.tools), `${name} must not have write tools`);
    assert.match(text, /```json spine-record/);
  });
}
