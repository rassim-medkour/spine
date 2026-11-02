const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const AGENTS = ['boundary-checker', 'devils-advocate', 'synthesis', 'product-lens', 'ux-finder'];

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

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');

for (const name of ['product-lens', 'ux-finder']) {
  test(`${name} declares Read, Grep, Glob and names its record agent`, () => {
    const text = read(name);
    assert.equal(parseFrontmatter(text).tools, 'Read, Grep, Glob');
    assert.ok(text.includes(`"agent": "spine:${name}"`));
    assert.ok(text.split('\n').length < 120);
  });
}

test('ux-finder names the UI states and the WCAG contrast ratios', () => {
  const text = read('ux-finder');
  for (const s of ['loading', 'empty', 'error', 'partial', 'disabled', 'success', 'permission denied', 'offline']) {
    assert.match(text, new RegExp(s, 'i'), s);
  }
  assert.match(text, /4\.5:1/);
  assert.match(text, /3:1/);
  assert.match(text, /WCAG 2\.2 AA/);
});

test('product-lens and ux-finder name the citation rule', () => {
  for (const name of ['product-lens', 'ux-finder']) {
    const text = read(name);
    assert.ok(text.includes('product.md:<line>'), name);
    assert.ok(text.includes('§'), name);
    assert.match(text, /`file` entries/);
    assert.match(text, /unsourced expectation is a question/);
  }
});

test('product-lens covers constraints, states missing and glossary challenge', () => {
  const text = read('product-lens');
  for (const s of ['invariants touched', 'flows touched', 'states missing', 'permission denied', 'glossary', 'fixed', 'preference', 'open', 'user impact']) {
    assert.match(text, new RegExp(s, 'i'), s);
  }
});

const { capProductRecord, isCapped } = require('../scripts/lib/cap-record');

// Every example record in a prompt must pass the cap: the note is the section heading and nothing else (R-0148, R-0149, R-0150).
function exampleRecords(name) {
  const text = read(name);
  return [...text.matchAll(/```json spine-record\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

for (const name of ['product-lens', 'ux-finder']) {
  test(`${name} example records are not capped against a section map holding the cited heading`, () => {
    const examples = exampleRecords(name);
    assert.ok(examples.length >= 1);
    for (const rec of examples) {
      const sections = {};
      for (const e of rec.evidence.filter((x) => x.kind === 'doc' && /^product\.md:\d+$/.test(x.ref))) {
        assert.match(e.note, /^§[A-Za-z ]+$/, 'the note is the section heading and nothing after it');
        const line = Number(e.ref.split(':')[1]);
        sections['## ' + e.note.slice(1)] = { start: line - 3, end: line + 3, blank: [], headings: [] };
      }
      const out = capProductRecord(rec, { productSections: sections, repoHas: () => false });
      assert.equal(isCapped(out), false, rec.claim);
      assert.equal(out, rec);
    }
  });
}

test('ux-finder carries a product.md citation example beside the WCAG one', () => {
  const examples = exampleRecords('ux-finder');
  assert.ok(examples.some((r) => r.evidence.some((e) => e.kind === 'doc' && /^product\.md:\d+$/.test(e.ref) && e.note === '§Invariants')));
  assert.ok(examples.some((r) => r.evidence.some((e) => e.kind === 'doc' && /^https:\/\/www\.w3\.org\//.test(e.ref))));
});

test('both prompts read the Decisions block first, never re-ask an answered question and prefer the newest date (R-0142)', () => {
  for (const name of ['product-lens', 'ux-finder']) {
    const text = read(name).replace(/\s+/g, ' ');
    assert.ok(text.includes('`## Decisions (last 10)` block, read it first'), name);
    assert.ok(text.includes('An answered question is cited by its line and never asked again'), name);
    assert.ok(text.includes('the newest date wins'), name);
  }
});

test('ux-finder pins the REQ-36 report items (R-0143)', () => {
  const text = read('ux-finder');
  for (const s of ['stack traces', 'glossary', 'key flow', 'Invariants', 'htmlFor', 'aria-label', 'role', 'Escape', 'focus', 'aria-describedby', 'aria-live', '24 by 24', 'tabIndex']) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /file and line|<file>:<line>/);
});

test('T-15c: both prompts say to cite the number before the pipe and name the touched key flows (R-0220, R-0221)', () => {
  for (const name of ['product-lens', 'ux-finder']) {
    const text = read(name).replace(/\s+/g, ' ');
    assert.ok(text.includes('Cite the number before the `|`, as `product.md:14`'), name);
    assert.ok(text.includes('carry no number'), name);
    assert.ok(text.includes('key flows this change touches'), name);
  }
});
