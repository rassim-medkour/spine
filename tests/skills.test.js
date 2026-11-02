const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const SKILLS = ['record-contract', 'gap-check', 'spine'];

for (const name of SKILLS) {
  test(`${name} skill has name and description frontmatter`, () => {
    const file = path.join(__dirname, '..', 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${file} missing`);
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    assert.equal(fm.name, name);
    assert.ok(fm.description.length > 40);
  });
}

test('gap-check lists the seven absence questions', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'gap-check', 'SKILL.md'), 'utf8');
  for (const needle of ['Acceptance criteria', 'Error paths', 'migration', 'Non-functional', 'Test anchors', 'Out of scope', 'User impact']) {
    assert.match(text, new RegExp(needle));
  }
});

test('spine skill defines the Workflow-tool fallback', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spine', 'SKILL.md'), 'utf8');
  assert.match(text, /^### When the Workflow tool is unavailable$/m);
  assert.match(text, /workflow tool unavailable, ran inline/);
  assert.match(text, /size S path/);
});

test('spine skill calls workflows by registered name, never by a <root> scriptPath', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spine', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /scriptPath:\s*"<root>/);
  for (const stage of ['spec', 'implement', 'review']) {
    const script = fs.readFileSync(path.join(__dirname, '..', 'workflows', `${stage}.workflow.js`), 'utf8');
    const metaName = script.match(/name:\s*'([^']+)'/)[1];
    assert.equal(metaName, `spine-internal-${stage}`);
    assert.ok(text.includes(`name: "spine:${metaName}"`), `SKILL.md must call spine:${metaName} by name`);
  }
});

test('both gap-check skills list seven questions and name User impact', () => {
  for (const dir of ['skills', 'cursor/skills']) {
    const text = fs.readFileSync(path.join(__dirname, '..', dir, 'gap-check', 'SKILL.md'), 'utf8');
    assert.match(text, /^## The seven absence questions$/m);
    assert.match(text, /^7\. \*\*User impact\.\*\*/m);
    assert.doesNotMatch(text, /six/);
  }
});
