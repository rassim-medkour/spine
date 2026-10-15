'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CURSOR = 'cursor/skills/spine/SKILL.md';
// Invocation form confirmed by spike T-3.
const CURSOR_INVOCATION = '/spine';
const skill = () => read(CURSOR);

function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `missing ${heading}`);
  const level = heading.match(/^#+/)[0];
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const BANNED_SYNONYMS = [/\bcheckpoints?\b/i, /\bmilestones?\b/i, /\bphase gates?\b/i, /\bapproval points?\b/i, /\bt-shirt size\b/i, /\btiers?\b/i, /\bfinding files?\b/i, /\brun key\b/i, /\bsession id\b/i];
const GLOSSARY_ANCHORS = [
  '`stage` is one of `intent`, `spec`, `plan`, `implement`, `review`, `done`.',
  '`awaiting` is `null`, `human`, `G1`, `G2`, or `G3`.',
  'Run id is `YYYYMMDD-<slug>`',
  'Verdict is `FAIL` when any verified CRITICAL or HIGH',
  '`spec-vs-intent`, `plan-vs-spec`, `code-vs-plan`,',
];

test('the Cursor skill never tells the model to call the Workflow tool', () => {
  assert.doesNotMatch(skill(), /Workflow\(/);
  assert.doesNotMatch(skill(), /name: "spine:spine-/);
});

test('the Cursor skill names the required subagents, scripts and the record fence', () => {
  for (const needle of ['boundary-checker', 'devils-advocate', 'synthesis', 'different author', 'json spine-record', 'write-record.js', 'pick-verifier.js', 'da-gate.js', 'check-cross-author.js', 'run-status.js', '--host cursor', 'workflow tool unavailable, ran inline', '"host"', 'no independent author available']) {
    assert.ok(skill().includes(needle), `missing ${needle}`);
  }
});

test('the Cursor skill documents all six entry points and the three gates', () => {
  for (const needle of ['intent', 'adopt', 'implement', 'review', 'status', 'resume', 'G1', 'G2', 'G3']) assert.ok(skill().includes(needle));
});

test('host-independent sections are identical to the Claude skill', () => {
  const base = read('skills/spine/SKILL.md').split('/spine:spine').join(CURSOR_INVOCATION);
  for (const heading of ['## Bootstrap comes first', '## Summary block', '### Live verification', '### intent']) {
    assert.equal(section(skill(), heading), section(base, heading), heading);
  }
});

test('a hook followup never stands in for gate approval', () => {
  assert.match(skill(), /hook followup never\s+answers a gate/i);
});

test('record-contract and gap-check reach Cursor as exact copies, and no rules file exists', () => {
  // Compare with line endings normalised: a Windows checkout can hold CRLF copies of LF files.
  const lf = (s) => s.replace(/\r\n/g, '\n');
  for (const name of ['record-contract', 'gap-check']) assert.equal(lf(read(`cursor/skills/${name}/SKILL.md`)), lf(read(`skills/${name}/SKILL.md`)));
  assert.equal(fs.existsSync(path.join(ROOT, 'rules')), false);
});

test('every Cursor-shipped skill has frontmatter name equal to its directory and a description', () => {
  for (const dir of fs.readdirSync(path.join(ROOT, 'cursor', 'skills'))) {
    const fm = parseFrontmatter(read(`cursor/skills/${dir}/SKILL.md`));
    assert.equal(fm.name, dir);
    assert.ok(fm.description && fm.description.length > 40);
  }
});

test('Cursor-facing skills keep the glossary: no synonyms, anchors unchanged', () => {
  for (const dir of fs.readdirSync(path.join(ROOT, 'cursor', 'skills'))) {
    const text = read(`cursor/skills/${dir}/SKILL.md`);
    for (const re of BANNED_SYNONYMS) assert.doesNotMatch(text, re, `${dir}: ${re}`);
  }
  for (const anchor of GLOSSARY_ANCHORS) assert.ok(skill().includes(anchor), `missing anchor: ${anchor}`);
});

test('.cursor-plugin/plugin.json ships cursor/skills', () => {
  assert.equal(JSON.parse(read('.cursor-plugin/plugin.json')).skills, './cursor/skills/');
});
