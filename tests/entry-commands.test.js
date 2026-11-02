'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The stage commands people type, the skill entry each one starts, and the
// internal workflow behind it.
const STAGES = [
  { command: 'spine-spec', entry: 'intent', workflow: 'spec' },
  { command: 'spine-implement', entry: 'implement', workflow: 'implement' },
  { command: 'spine-review', entry: 'review', workflow: 'review' },
];

function workflowMeta(name) {
  const text = read(`workflows/${name}.workflow.js`);
  return new Function(`return ${/export const meta = (\{[\s\S]*?\n\});/.exec(text)[1]}`)();
}

function runWorkflow(name, args) {
  const body = read(`workflows/${name}.workflow.js`).replace(/^export /, '');
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body);
  const none = async () => null;
  return fn(none, none, none, () => {}, () => {}, args);
}

for (const s of STAGES) {
  test(`/spine:${s.command} starts the full ${s.entry} entry of the spine skill`, () => {
    const text = read(`commands/${s.command}.md`);
    const fm = parseFrontmatter(text);
    assert.ok(fm.description.length > 20);
    assert.ok(fm['argument-hint']);
    assert.match(text, /Skill tool/);
    assert.ok(text.includes(`${s.entry} $ARGUMENTS`), `passes "${s.entry} $ARGUMENTS" to the skill`);
  });

  test(`the ${s.workflow} workflow is registered under an internal name, not /spine:${s.command}`, () => {
    assert.equal(workflowMeta(s.workflow).name, `spine-internal-${s.workflow}`);
  });

  test(`the ${s.workflow} workflow started with no input points to /spine:${s.command}`, async () => {
    for (const args of [undefined, {}, '885']) {
      await assert.rejects(runWorkflow(s.workflow, args), (e) => e.message.includes(`/spine:${s.command}`));
    }
  });
}

test('the skill calls every workflow by its internal name only', () => {
  const skill = read('skills/spine/SKILL.md');
  for (const s of STAGES) {
    assert.ok(skill.includes(`name: "spine:spine-internal-${s.workflow}"`), `calls spine:spine-internal-${s.workflow}`);
    assert.ok(!skill.includes(`"spine:${s.command}"`), `no call to the old name spine:${s.command}`);
  }
});

test('review without a target asks first and names the run after the target', () => {
  const skill = read('skills/spine/SKILL.md');
  assert.match(skill, /no target[^\n]*ask/i);
  assert.ok(skill.includes('20261022-pr-885'));
});

test('the product entry point edits one file and never creates a run (AC-2)', () => {
  for (const rel of ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md']) {
    const t = read(rel);
    const start = t.indexOf('- `product`');
    assert.ok(start > 0, rel);
    const entry = t.slice(start, t.indexOf('\n- `', start + 5));
    assert.match(entry, /never create a run/i, rel);
    assert.match(entry, /one question per turn/i, rel);
    assert.match(entry, /customer data and secrets/, rel);
    assert.match(entry, /never invent/i, rel);
  }
});
