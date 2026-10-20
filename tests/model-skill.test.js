'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIMITATIONS, ROLES } = require('../scripts/lib/model-policy');

const SKILLS = ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md'];
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const section = (text, heading) => {
  const s = text.indexOf(`\n${heading}\n`);
  assert.ok(s >= 0, heading);
  const rest = text.slice(s + heading.length + 2);
  const n = rest.search(/\n## /);
  return n < 0 ? rest : rest.slice(0, n);
};

test('Claude skill: every dispatch site names its role (REQ-35)', () => {
  const t = read('skills/spine/SKILL.md');
  assert.ok(t.includes('scripts/select-model.js --run <run> --stage <stage>'));
  for (const role of ROLES) assert.ok(t.includes(`--model-role ${role}`) || t.includes(`role \`${role}\``), role);
  assert.ok(t.includes('args.models'));
  assert.match(t, /model: <plan model>/);
});

for (const rel of SKILLS) {
  test(`${rel}: limitations section lists exactly the LIMITATIONS ids (REQ-34, REQ-35)`, () => {
    const body = section(read(rel), '## Model routing');
    const ids = [...body.matchAll(/`limitation:([a-z-]+)`/g)].map((m) => m[1]).sort();
    const expected = Object.keys(LIMITATIONS).filter((id) => rel.startsWith('cursor/') || id !== 'cursor-task-model').sort();
    assert.deepEqual(ids, expected);
  });

  test(`${rel}: kill switch, router failure and session retry are documented (REQ-22, REQ-23)`, () => {
    const t = read(rel);
    for (const needle of ['"model_policy": "inherit"', 'fallback-error', 'session-fallback', 'unsupported-dispatch', 'retry once', 'models.json']) assert.ok(t.includes(needle), needle);
  });
}

test('Claude skill: the G3 step shows the model mix from run-status.js (REQ-37)', () => {
  assert.match(read('skills/spine/SKILL.md'), /model_mix\.line/);
});

test('Cursor skill: every subagent dispatch names its role and the write-record flag (REQ-35)', () => {
  const t = read('cursor/skills/spine/SKILL.md');
  assert.ok(t.includes('scripts/select-model.js --run <run> --stage <stage> --host cursor'));
  for (const role of ROLES) assert.ok(t.includes(`--model-role ${role}`), role);
  assert.doesNotMatch(t, /Workflow[(]/);
  assert.match(t, /models found/);
});
