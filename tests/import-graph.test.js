'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGraph, TEST_FILE } = require('../scripts/lib/graph');
const { loadHints, parseLooseJson } = require('../scripts/lib/hints');

function loadFixture(lang) {
  const root = path.join(__dirname, 'fixtures', 'graph', lang);
  const out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push({ path: r, text: fs.readFileSync(path.join(root, r), 'utf8') });
    }
  })('');
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const readerOf = (files) => (p) => {
  const f = files.find((x) => x.path === p);
  return f ? f.text : null;
};
const graphOf = (files) => buildGraph({ files, hints: loadHints(files.map((f) => f.path), readerOf(files)) });
const graphFor = (lang) => graphOf(loadFixture(lang));
const count = (g, p) => g.fanIn(p).value;

test('python: exact fan-in, from-import submodules, tested heuristic', () => {
  const g = graphFor('python');
  assert.equal(count(g, 'pkg/util.py'), 3);
  assert.equal(count(g, 'pkg/core.py'), 2);
  assert.equal(count(g, 'app.py'), 0);
  assert.equal(g.fanIn('pkg/util.py').resolved, true);
  assert.equal(g.tested('pkg/util.py').value, true);
  assert.equal(g.tested('pkg/core.py').value, false);
});

test('typescript: alias to barrel, .js specifier to .ts, dynamic literal, downstream through a barrel', () => {
  const g = graphFor('typescript');
  assert.deepEqual(g.importersOf('src/lib/math.ts'), ['src/lib/index.ts', 'src/math.test.ts', 'src/page.tsx']);
  assert.equal(count(g, 'src/lib/index.ts'), 1);
  assert.equal(count(g, 'src/types.ts'), 1);
  assert.equal(count(g, 'src/lazy.ts'), 1);
  assert.equal(g.downstream('src/lib/math.ts', 3), 3);
  assert.equal(g.tested('src/lib/math.ts').value, true);
  assert.equal(g.diagnostics.dynamic_non_literal, 1);
});

test('javascript: require, ESM .mjs, export-from and package.json main as entry hint', () => {
  const files = loadFixture('javascript');
  const g = graphOf(files);
  assert.equal(count(g, 'lib/util.js'), 3);
  assert.equal(count(g, 'lib/esm.mjs'), 1);
  assert.equal(count(g, 'index.js'), 0);
  assert.ok(loadHints(files.map((f) => f.path), readerOf(files)).entryHints.has('index.js'));
});

test('go: fan-in counts files in other packages importing the package path', () => {
  const g = graphFor('go');
  assert.equal(count(g, 'internal/store/store.go'), 2);
  assert.equal(count(g, 'internal/store/cache.go'), 2);
  assert.deepEqual(g.importersOf('internal/store/store.go'), ['api/handler.go', 'main.go']);
  assert.equal(g.tested('internal/store/store.go').value, true);
});

test('generic fallback: parser generic, fan-in at least 1 when referenced', () => {
  const g = graphFor('generic');
  assert.equal(count(g, 'lib/greeter.rb'), 1);
  assert.equal(count(g, 'src/com/acme/Util.java'), 1);
  assert.equal(g.diagnostics.parsed.generic, 4);
});

test('unparseable input fails open: binary, unreadable and partial fan-in are unknown, never 0', () => {
  const g = buildGraph({ files: [
    { path: 'img/logo.png', text: null, binary: true },
    { path: 'src/broken.ts', text: null, error: 'unreadable' },
    { path: 'src/lib/date.ts', text: 'export const d = 1;' },
    { path: 'src/x.ts', text: "import { d } from '~/lib/date';" },
  ] });
  assert.deepEqual(g.fanIn('img/logo.png'), { value: null, resolved: false, rule: 'fan-in unknown: binary file' });
  assert.deepEqual(g.fanIn('src/broken.ts'), { value: null, resolved: false, rule: 'fan-in unknown: unreadable' });
  const partial = g.fanIn('src/lib/date.ts');
  assert.equal(partial.resolved, false);
  assert.equal(partial.rule, 'fan-in partial: unresolved import in src/x.ts');
  assert.equal(g.downstream('src/lib/date.ts', 3), null);
  assert.equal(g.tested('src/lib/date.ts').value, null);
  assert.equal(g.diagnostics.unresolved, 1);
});

test('graph scope excludes node_modules, vendor, dist, build and generated', () => {
  const g = buildGraph({ files: [
    { path: 'src/a.ts', text: 'export const a = 1;' },
    { path: 'node_modules/x/index.js', text: "require('../../src/a');" },
    { path: 'dist/a.js', text: "import a from '../src/a';" },
  ] });
  assert.equal(count(g, 'src/a.ts'), 0);
  assert.equal(g.diagnostics.files, 1);
});

test('a nested tsconfig alias resolves only inside its package; a workspace package name resolves', () => {
  const files = [
    { path: 'packages/app/package.json', text: '{ "name": "@acme/app", "main": "src/main.ts" }' },
    { path: 'packages/app/tsconfig.json', text: '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], }, }, }' },
    { path: 'packages/app/src/util.ts', text: 'export const u = 1;' },
    { path: 'packages/app/src/main.ts', text: "import { u } from '@app/util';\nexport const m = u;" },
    { path: 'packages/web/src/page.ts', text: "import { m } from '@acme/app';\nimport { u } from '@app/util';" },
  ];
  const g = graphOf(files);
  assert.deepEqual(g.importersOf('packages/app/src/util.ts'), ['packages/app/src/main.ts']);
  assert.deepEqual(g.importersOf('packages/app/src/main.ts'), ['packages/web/src/page.ts']);
});

test('cached extraction entries are reused by key and fresh ones are reported', () => {
  const files = [{ path: 'src/a.ts', text: 'export const a = 1;', key: 'typescript:aaaa' }, { path: 'src/b.ts', text: null, key: 'typescript:bbbb' }];
  const cached = new Map([['typescript:bbbb', { parser: 'typescript', specs: [{ specifier: './a', literal: true }] }]]);
  const g = buildGraph({ files, cached });
  assert.equal(count(g, 'src/a.ts'), 1);
  assert.equal(g.diagnostics.cache_hits, 1);
  assert.deepEqual([...g.extracted.keys()], ['typescript:aaaa']);
});

test('TEST_FILE and parseLooseJson helpers', () => {
  for (const p of ['tests/a.js', 'src/a.test.ts', 'src/a.spec.jsx', 'pkg/test_x.py', 'pkg/x_test.py', 'x/y_test.go', '__tests__/a.js']) assert.ok(TEST_FILE.test(p), p);
  for (const p of ['src/latest.ts', 'src/contest.py', 'testing/a.go']) assert.ok(!TEST_FILE.test(p), p);
  assert.deepEqual(parseLooseJson('{ /* c */ "a": [1, 2,], }'), { a: [1, 2] });
  assert.equal(parseLooseJson('nope'), null);
});
