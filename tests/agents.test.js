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
