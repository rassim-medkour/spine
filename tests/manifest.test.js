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

test('marketplace owner has public url and noreply email only', () => {
  const { owner } = readJson('.claude-plugin/marketplace.json');
  assert.equal(owner.url, 'https://github.com/rassim-medkour');
  assert.match(owner.email, /@users\.noreply\.github\.com$/);
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
  assert.equal(v, '0.1.0');
  assert.equal(readJson('package.json').version, v);
  assert.equal(readJson('.claude-plugin/marketplace.json').plugins[0].version, v);
});
