const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

test('/spine command delegates to the spine skill with arguments', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'commands', 'spine.md'), 'utf8');
  const fm = parseFrontmatter(text);
  assert.ok(fm.description.length > 20);
  assert.match(fm['argument-hint'], /intent|adopt|implement|review|status|resume/);
  assert.match(text, /\$ARGUMENTS/);
  assert.match(text, /Skill tool/);
});

test('spine skill documents every entry point, the gates, and the summary block', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'spine', 'SKILL.md'), 'utf8');
  const needles = ['intent', 'adopt', 'implement', 'review', 'status', 'resume', 'G1', 'G2', 'G3', 'NEXT:', 'STATE:', 'DONE:', 'WHY:', 'DEBATED:', 'DISSENT:', 'review.workflow.js', 'implement.workflow.js', 'spec.workflow.js', 'classify.js', 'select-providers.js', 'boundary-checker', 'awaiting', 'Bootstrap'];
  for (const needle of needles) assert.ok(text.includes(needle), `missing ${needle}`);
});
