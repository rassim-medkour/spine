const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('plugin manifest names the plugin spine', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'spine');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('package.json runs node:test over tests/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.scripts.test, 'node --test "tests/**/*.test.js"');
});

const REPO_URL = 'https://github.com/rassim-medkour/spine';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('LICENSE is MIT and matches plugin.json', () => {
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.match(license, /^MIT License/);
  assert.ok(license.includes(`Copyright (c) 2026 ${manifest.author.name}`));
  assert.equal(manifest.license, 'MIT');
});

test('plugin.json links the public repo', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.homepage, REPO_URL);
  assert.equal(manifest.repository, REPO_URL);
});

test('marketplace owner has public url and the public gmail address', () => {
  const { owner } = readJson('.claude-plugin/marketplace.json');
  assert.equal(owner.url, 'https://github.com/rassim-medkour');
  assert.equal(owner.email, 'rassimmedkour@gmail.com');
});

test('spine@spine install handle resolves', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'spine');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'spine');
  assert.equal(market.plugins[0].source, './');
  assert.equal(readJson('.claude-plugin/plugin.json').name, market.plugins[0].name);
});

test('versions agree across manifests', () => {
  const v = readJson('.claude-plugin/plugin.json').version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson('package.json').version, v);
  assert.equal(readJson('.claude-plugin/marketplace.json').plugins[0].version, v);
});

test('schemaFor maps only the exact product.md path to product', () => {
  const { schemaFor } = require('../scripts/lib/validate');
  assert.equal(schemaFor('.spine/product.md'), 'product');
  assert.equal(schemaFor('docs/product.md'), null);
  assert.equal(schemaFor('.spine/run/product.md'), null);
});

test('an empty frontmatter list skips the frontmatter error', () => {
  const { validateMarkdown } = require('../scripts/lib/validate');
  assert.deepEqual(validateMarkdown('## A\n', { frontmatter: [], headings: ['## A'] }), []);
  assert.ok(validateMarkdown('## A\n', { frontmatter: ['id'], headings: ['## A'] }).length > 0);
});

const INTENT_OLD = '---\nid: x\nstage: intent\nupstream_id: x\nstatus: draft\n---\n\n## Problem\n## Acceptance criteria\n## Constraints\n## Out of scope\n';
const SPEC_OLD = '---\nid: x\nstage: spec\nupstream_id: x\nstatus: draft\n---\n\n' + ['Summary', 'Requirements', 'Design', 'Error paths', 'Data and migrations', 'Test anchors', 'Assumptions', 'Out of scope'].map((h) => `## ${h}\n`).join('');

function checkIntent(text, ctx) {
  const { validateMarkdown, loadSchema } = require('../scripts/lib/validate');
  return validateMarkdown(text, loadSchema('intent'), ctx);
}
function checkSpec(text, ctx) {
  const { validateMarkdown, loadSchema } = require('../scripts/lib/validate');
  return validateMarkdown(text, loadSchema('spec'), ctx);
}

test('a 0.3.2 intent fixture under spine_version 0.3.2 has zero heading errors', () => {
  assert.deepEqual(checkIntent(INTENT_OLD), []);
  assert.deepEqual(checkIntent(INTENT_OLD, { productContext: true, spineVersion: '0.3.2' }), []);
});

test('a 0.4.0 run with product context ok reports the two missing intent headings', () => {
  const errors = checkIntent(INTENT_OLD, { productContext: true, spineVersion: '0.4.0' });
  assert.deepEqual(errors, ['missing heading "## Who this is for"', 'missing heading "## What changes for the user"']);
  const full = INTENT_OLD + '## Who this is for\n## What changes for the user\n';
  assert.deepEqual(checkIntent(full, { productContext: true, spineVersion: '0.10.0' }), []);
});

test('a 0.4.0 run without product context reports no conditional headings', () => {
  assert.deepEqual(checkIntent(INTENT_OLD, { productContext: false, spineVersion: '0.4.0' }), []);
  assert.deepEqual(checkIntent(INTENT_OLD, { spineVersion: '0.4.0' }), []);
});

test('spec User impact is gated the same way', () => {
  assert.deepEqual(checkSpec(SPEC_OLD), []);
  assert.deepEqual(checkSpec(SPEC_OLD, { productContext: true, spineVersion: '0.3.2' }), []);
  assert.deepEqual(checkSpec(SPEC_OLD, { productContext: true, spineVersion: '0.4.0' }), ['missing heading "## User impact"']);
  assert.deepEqual(checkSpec(SPEC_OLD + '## User impact\n', { productContext: true, spineVersion: '0.4.0' }), []);
});

test('validateArtifactFile reads product context from ctx for intent.md', () => {
  const { validateArtifactFile } = require('../scripts/lib/validate');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-cond-'));
  const file = path.join(dir, 'intent.md');
  fs.writeFileSync(file, INTENT_OLD);
  assert.equal(validateArtifactFile(file, 'intent.md', { productContext: true, spineVersion: '0.4.0' }).length, 2);
  assert.equal(validateArtifactFile(file, 'intent.md', {}).length, 0);
});
