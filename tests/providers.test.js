const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { selectProviders, pluginOf } = require('../scripts/lib/providers');

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'providers.json'), 'utf8'));
const ALL = ['ecc', 'superpowers', 'mattpocock-skills', 'code-review', 'coderabbit', 'feature-dev', 'caveman'];

test('pluginOf strips the provider suffix', () => {
  assert.equal(pluginOf('ecc:code-review'), 'ecc');
  assert.equal(pluginOf('mattpocock-skills:code-review'), 'mattpocock-skills');
});

test('S size selects one review provider', () => {
  const sel = selectProviders('review', 'S', ALL, registry);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].id, 'ecc:code-review');
});

test('M size selects two providers from different authors', () => {
  const sel = selectProviders('review', 'M', ALL, registry);
  assert.equal(sel.length, 2);
  assert.notEqual(sel[0].author, sel[1].author);
});

test('L size selects three providers and respects lens budget', () => {
  assert.equal(selectProviders('review', 'L', ALL, registry).length, 3);
  assert.equal(selectProviders('review', 'L', ALL, registry, 2).length, 2);
});

test('uninstalled plugins are skipped', () => {
  const sel = selectProviders('review', 'M', ['mattpocock-skills', 'coderabbit'], registry);
  assert.deepEqual(sel.map((p) => pluginOf(p.id)).sort(), ['coderabbit', 'mattpocock-skills']);
});

test('every stage in the registry has at least two authors', () => {
  for (const stage of ['spec', 'plan', 'implement', 'review']) {
    const authors = new Set(registry[stage].map((p) => p.author));
    assert.ok(authors.size >= 2, `${stage} has ${authors.size} author(s)`);
  }
});
