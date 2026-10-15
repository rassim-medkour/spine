'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parserFor, extractImports, resolveImport, stemOf } = require('../scripts/lib/imports');

const literal = (r) => r.specs.filter((s) => s.literal).map((s) => s.specifier).sort();

test('parserFor maps extensions; everything unknown is generic, data files are none', () => {
  const rows = { 'a.py': 'python', 'a.ts': 'typescript', 'a.d.ts': 'typescript', 'a.tsx': 'typescript', 'a.mts': 'typescript', 'a.cts': 'typescript', 'a.js': 'javascript', 'a.jsx': 'javascript', 'a.mjs': 'javascript', 'a.cjs': 'javascript', 'a.go': 'go', 'a.rb': 'generic', 'A.java': 'generic', 'a.rs': 'generic', 'a.md': 'none', 'a.json': 'none', 'a.png': 'none', Makefile: 'none' };
  for (const [file, parser] of Object.entries(rows)) assert.equal(parserFor(file), parser, file);
});

test('TypeScript and JavaScript: ESM, export-from, import type, require, dynamic', () => {
  const text = [
    "import a from './a';",
    "import type { T } from '../types';",
    "import './side-effect';",
    'import {',
    '  b,',
    '  c,',
    "} from './multi';",
    "export * from './barrel';",
    'export { x } from "./x";',
    "const r = require('./r');",
    "const lazy = await import('./lazy');",
    'const dyn = await import(name);',
    'const tpl = await import(`./pages/${page}`);',
    "// import nope from './commented';",
    "const url = 'http://example.com';",
  ].join('\n');
  const r = extractImports('src/app.ts', text);
  assert.equal(r.parser, 'typescript');
  assert.deepEqual(literal(r), ['../types', './a', './barrel', './lazy', './multi', './r', './side-effect', './x']);
  assert.equal(r.specs.filter((s) => !s.literal).length, 2);
});

test('Python: import, from, relative dots, parenthesised names, dynamic', () => {
  const text = [
    'import os, pkg.util as u',
    'from . import sibling',
    'from ..core import (',
    '    run,',
    '    stop,',
    ')',
    'from pkg.sub import thing  # comment',
    'mod = importlib.import_module(name)',
  ].join('\n');
  const r = extractImports('pkg/mod/x.py', text);
  assert.deepEqual(r.specs.filter((s) => s.literal).map((s) => [s.specifier, s.names]), [
    ['os', []], ['pkg.util', []], ['.', ['sibling']], ['..core', ['run', 'stop']], ['pkg.sub', ['thing']],
  ]);
  assert.equal(r.specs.filter((s) => !s.literal).length, 1);
});

test('Go: single imports, aliases and import blocks', () => {
  const text = 'package main\n\nimport "fmt"\nimport alias "example.com/fx/one"\n\nimport (\n\t"strings"\n\ts "example.com/fx/two"\n\t_ "example.com/fx/three"\n)\n';
  assert.deepEqual(literal(extractImports('main.go', text)), ['example.com/fx/one', 'example.com/fx/three', 'example.com/fx/two', 'fmt', 'strings']);
});

test('generic fallback reads import-like lines of any language', () => {
  assert.deepEqual(literal(extractImports('app.rb', "require_relative 'lib/greeter'\n")), ['lib/greeter']);
  assert.deepEqual(literal(extractImports('src/Main.java', 'import com.acme.Util;\nclass Main {}\n')), ['com.acme.Util']);
});

test('extraction never throws on binary, null or broken input', () => {
  assert.deepEqual(extractImports('x.ts', '\u0000\u0001import(').specs.filter((s) => s.literal), []);
  assert.deepEqual(extractImports('a.py', null).specs, []);
  assert.doesNotThrow(() => extractImports('x.js', "import x from 'unterminated"));
  assert.deepEqual(extractImports('logo.png', 'whatever'), { parser: 'none', specs: [] });
});

const CTX = {
  fileSet: new Set(['src/lib/math.ts', 'src/lib/index.ts', 'src/page.tsx', 'pkg/__init__.py', 'pkg/core.py', 'pkg/util.py', 'internal/store/store.go', 'lib/greeter.rb', 'src/com/acme/Util.java']),
  jsAliases: [{ scope: '', prefix: '@/', suffix: '', wildcard: true, targets: ['src/*'] }],
  baseUrls: [{ scope: '', dir: '' }],
  goModules: [{ module: 'example.com/fx', dir: '' }],
  goPackages: new Set(['internal/store']),
  pyRoots: [''],
  pyTopLevel: new Set(['pkg']),
  stems: new Map([['greeter', ['lib/greeter.rb']], ['util', ['src/com/acme/Util.java']]]),
};
const lit = (specifier, names) => ({ specifier, literal: true, ...(names ? { names } : {}) });

test('JS/TS resolution: relative, .js to .ts, alias to index, baseUrl, packages, alias-like misses', () => {
  assert.deepEqual(resolveImport('src/page.tsx', 'typescript', lit('./lib/math.js'), CTX).targets, ['src/lib/math.ts']);
  assert.deepEqual(resolveImport('src/app.ts', 'typescript', lit('@/lib'), CTX).targets, ['src/lib/index.ts']);
  assert.deepEqual(resolveImport('x.ts', 'typescript', lit('src/lib/math'), CTX).targets, ['src/lib/math.ts']);
  assert.equal(resolveImport('src/a.ts', 'typescript', lit('react'), CTX).external, true);
  const miss = resolveImport('src/x.ts', 'typescript', lit('~/lib/date'), CTX);
  assert.deepEqual([miss.targets, miss.external], [[], false]);
  assert.equal(resolveImport('src/a.ts', 'typescript', lit('../../outside'), CTX).external, false);
});

test('Python resolution: from-import submodule, relative, external, internal miss', () => {
  assert.deepEqual(resolveImport('app.py', 'python', lit('pkg', ['core']), CTX).targets, ['pkg/core.py']);
  assert.deepEqual(resolveImport('pkg/core.py', 'python', lit('.', ['util']), CTX).targets, ['pkg/util.py']);
  assert.deepEqual(resolveImport('cli.py', 'python', lit('pkg.util', ['helper']), CTX).targets, ['pkg/util.py']);
  assert.equal(resolveImport('app.py', 'python', lit('os', []), CTX).external, true);
  const miss = resolveImport('app.py', 'python', lit('pkg.missing', []), CTX);
  assert.deepEqual([miss.targets, miss.external], [[], false]);
});

test('Go and generic resolution', () => {
  assert.deepEqual(resolveImport('main.go', 'go', lit('example.com/fx/internal/store'), CTX).packages, ['internal/store']);
  assert.equal(resolveImport('main.go', 'go', lit('fmt'), CTX).external, true);
  assert.deepEqual(resolveImport('app.rb', 'generic', lit('lib/greeter'), CTX).targets, ['lib/greeter.rb']);
  assert.deepEqual(resolveImport('src/Main.java', 'generic', lit('com.acme.Util'), CTX).targets, ['src/com/acme/Util.java']);
  assert.equal(resolveImport('a.ts', 'typescript', { specifier: null, literal: false }, CTX).dynamic, true);
});

test('stemOf drops every extension and lowercases', () => {
  assert.equal(stemOf('src/lib/Math.test.ts'), 'math');
  assert.equal(stemOf('README'), 'readme');
});
