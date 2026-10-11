'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../scripts/lib/validate');

const DIR = path.join(__dirname, '..', 'agents');
// Implementer agents may write; spine ships none today.
const IMPLEMENTERS = new Set();

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()) {
  const name = file.slice(0, -3);
  test(`agents/${file}: name matches, description present, Claude tools and Cursor readonly declared`, () => {
    const fm = parseFrontmatter(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.equal(fm.name, name);
    assert.ok(fm.description && fm.description.length > 40);
    assert.ok(fm.tools, 'Claude tools field missing');
    assert.equal(fm.readonly, IMPLEMENTERS.has(name) ? 'false' : 'true', `${name} readonly`);
  });
}
