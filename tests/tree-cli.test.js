'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { buildTree, serializeTree, defaultIo } = require('../scripts/tree');
const { tierConfig } = require('../scripts/lib/tier-config');
const { validateTree } = require('../scripts/lib/validate');
const { makeSyntheticRepo } = require('./helpers/synthetic-repo');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const tc = tierConfig({});
const { tmpDir: tmp } = require('./helpers/tmp');

function gitRepo(lang) {
  const dir = tmp(`spine-tree-${lang}-`);
  fs.cpSync(path.join(__dirname, 'fixtures', 'graph', lang), dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { dir, git };
}

const run = (dir, files, diffText = '', extra = {}) => buildTree({ root: dir, files, diffText, tc, artifactsDir: '.spine', ...extra });
const fileOf = (t, p) => t.files.find((f) => f.path === p);
const fanIn = (dir, p) => fileOf(run(dir, [p]).tree, p).signals.fan_in.value;

test('a modified file gets post-change fan-in, signals and a valid tree', () => {
  const { dir, git } = gitRepo('typescript');
  fs.appendFileSync(path.join(dir, 'src/lib/math.ts'), 'export const sub = (a: number, b: number) => a - b;\n');
  const { tree, revision } = run(dir, [], git('diff'));
  assert.deepEqual(validateTree(tree), []);
  const f = fileOf(tree, 'src/lib/math.ts');
  assert.equal(f.status, 'modified');
  assert.deepEqual(f.signals.fan_in, { value: 3, resolved: true, rule: 'direct importers (typescript)' });
  assert.equal(f.signals.public_interface.value, true);
  assert.deepEqual(f.signals.churn, { value: 1, rule: 'commits in 90 days' });
  assert.deepEqual(f.importers_top, ['src/lib/index.ts', 'src/math.test.ts', 'src/page.tsx']);
  assert.match(tree.inputs.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(revision, `${tree.inputs.head_sha}:${tree.inputs.diff_sha256}`);
});

test('determinism: cold, warm, deleted and corrupt cache give byte-identical tree.json', () => {
  const { dir, git } = gitRepo('typescript');
  fs.appendFileSync(path.join(dir, 'src/app.ts'), '// touch\n');
  const diff = git('diff');
  const cold = run(dir, [], diff);
  const warm = run(dir, [], diff);
  assert.equal(serializeTree(warm.tree), serializeTree(cold.tree));
  assert.ok(warm.diagnostics.cache_hits > 0);
  fs.rmSync(path.join(dir, '.spine', 'cache'), { recursive: true, force: true });
  assert.equal(serializeTree(run(dir, [], diff).tree), serializeTree(cold.tree));
  const cacheFile = fs.readdirSync(path.join(dir, '.spine', 'cache'))[0];
  fs.writeFileSync(path.join(dir, '.spine', 'cache', cacheFile), 'garbage{');
  const corrupt = run(dir, [], diff);
  assert.equal(corrupt.diagnostics.cache, 'discarded');
  assert.equal(serializeTree(corrupt.tree), serializeTree(cold.tree));
});

test('uncommitted edits change fan-in even with a warm cache', () => {
  const { dir } = gitRepo('typescript');
  const before = fanIn(dir, 'src/lib/math.ts');
  fs.writeFileSync(path.join(dir, 'src/extra.ts'), "import { add } from './lib/math';\nexport const e = add(1, 1);\n");
  assert.equal(fanIn(dir, 'src/lib/math.ts'), before + 1);
  fs.writeFileSync(path.join(dir, 'src/page.tsx'), 'export const v = 1;\n');
  assert.equal(fanIn(dir, 'src/lib/math.ts'), before);
});

test('an added file counts its new importers; a deleted file uses the pre-change tree', () => {
  const { dir, git } = gitRepo('typescript');
  fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export const n = 1;\n');
  fs.appendFileSync(path.join(dir, 'src/types.ts'), "import { n } from './new';\nexport const N = n;\n");
  fs.rmSync(path.join(dir, 'src/lazy.ts'));
  fs.writeFileSync(path.join(dir, 'src/app.ts'), "import { add } from '@/lib';\nimport type { Cfg } from './types';\nexport const run = (c: Cfg) => add(c.n, 1);\n");
  git('add', '-N', 'src/new.ts');
  const { tree } = run(dir, [], git('diff'));
  assert.deepEqual(tree.files.map((f) => [f.path, f.status]), [['src/app.ts', 'modified'], ['src/lazy.ts', 'deleted'], ['src/new.ts', 'added'], ['src/types.ts', 'modified']]);
  assert.equal(fileOf(tree, 'src/new.ts').signals.fan_in.value, 1);
  assert.equal(fileOf(tree, 'src/lazy.ts').signals.fan_in.value, 1);
});

test('backslash paths are normalized', () => {
  const { dir } = gitRepo('typescript');
  assert.equal(run(dir, ['src\\lib\\math.ts']).tree.files[0].path, 'src/lib/math.ts');
});

test('a file over 2 MB is not parsed and is never leaf', () => {
  const { dir } = gitRepo('typescript');
  fs.writeFileSync(path.join(dir, 'src/huge.ts'), '// filler line\n'.repeat(200000));
  const f = fileOf(run(dir, ['src/huge.ts']).tree, 'src/huge.ts');
  assert.equal(f.signals.fan_in.rule, 'fan-in unknown: too large to parse');
  assert.notEqual(f.tier, 'leaf');
});

test('over budget: partial result, unknown fan-in, never leaf, no crash', () => {
  const { dir } = gitRepo('typescript');
  let clock = 0;
  const io = { ...defaultIo(dir), now: () => (clock += 1000000) };
  const out = run(dir, ['src/types.ts'], '', { io, tc: tierConfig({ tiers: { tree_budget_ms: 1 } }) });
  assert.equal(out.diagnostics.budget_exceeded, true);
  assert.equal(out.tree.files[0].signals.fan_in.rule, 'fan-in unknown: budget exceeded');
  assert.notEqual(out.tree.files[0].tier, 'leaf');
});

test('no git: graph unavailable, churn null with a reason, head_sha none', () => {
  const dir = tmp('spine-tree-nogit-');
  fs.writeFileSync(path.join(dir, 'a.py'), 'import os\n');
  const io = { ...defaultIo(dir), git: () => ({ ok: false, out: Buffer.alloc(0) }) };
  const { tree, diagnostics } = run(dir, ['a.py'], '', { io });
  assert.equal(diagnostics.graph, 'graph unavailable (git ls-files failed)');
  assert.equal(tree.files[0].signals.fan_in.rule, 'fan-in unknown: graph unavailable (git ls-files failed)');
  assert.deepEqual(tree.files[0].signals.churn, { value: null, rule: 'churn unknown: git unavailable' });
  assert.equal(tree.inputs.head_sha, 'none');
  assert.equal(tree.tier, 'branch');
});

test('shallow clone: churn is null, never 0', () => {
  const { dir } = gitRepo('python');
  const shallow = path.join(tmp('spine-tree-shallow-'), 'c');
  execFileSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(dir).href, shallow]);
  const f = run(shallow, ['pkg/util.py']).tree.files[0];
  assert.deepEqual(f.signals.churn, { value: null, rule: 'churn unknown: shallow clone' });
});

test('operation count on 2,000 files: one git ls-files -s, every file read at most once', () => {
  const dir = tmp('spine-tree-ops-');
  const paths = makeSyntheticRepo(dir, { files: 2000, git: true });
  const base = defaultIo(dir);
  const reads = new Map();
  const calls = [];
  const io = {
    ...base,
    read: (p) => {
      reads.set(p, (reads.get(p) || 0) + 1);
      return base.read(p);
    },
    git: (args) => {
      calls.push(args.slice(0, 2).join(' '));
      return base.git(args);
    },
  };
  run(dir, [paths[10]], '', { io });
  assert.equal(calls.filter((c) => c === 'ls-files -s').length, 1);
  assert.ok([...reads.values()].every((n) => n === 1));
  assert.ok(reads.size <= paths.length);
});

function home(config = {}) {
  const h = tmp('spine-tree-home-');
  fs.mkdirSync(path.join(h, '.spine'));
  fs.writeFileSync(path.join(h, '.spine', 'config.json'), JSON.stringify(config));
  return h;
}
const cli = (dir, args, h) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tree.js'), ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: h }) });

test('tree.js --run writes tree.json, diagnostics.json, classify.log and the class.json tier, without file contents', () => {
  const { dir, git } = gitRepo('typescript');
  const runDir = path.join(dir, '.spine', '20261015-cli');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{}');
  fs.writeFileSync(path.join(runDir, 'class.json'), JSON.stringify({ size: 'S' }));
  fs.appendFileSync(path.join(dir, 'src/lib/math.ts'), '// SECRET_MARKER_42\n');
  fs.writeFileSync(path.join(runDir, 'diff.patch'), git('diff'));
  const out = cli(dir, ['--run', runDir, '--diff', path.join(runDir, 'diff.patch')], home());
  assert.equal(out.status, 0, out.stderr);
  const summary = JSON.parse(out.stdout);
  assert.equal(summary.ok, true);
  assert.match(summary.revision, /^[0-9a-f]{40}:[0-9a-f]{64}$/);
  assert.deepEqual(validateTree(JSON.parse(fs.readFileSync(path.join(runDir, 'tree.json'), 'utf8'))), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'class.json'), 'utf8')).tier, summary.tier);
  assert.match(fs.readFileSync(path.join(runDir, 'classify.log'), 'utf8'), /^\S+ tree ok elapsed_ms=\d+ cache=\w+/);
  for (const f of ['tree.json', 'diagnostics.json', 'classify.log']) assert.ok(!fs.readFileSync(path.join(runDir, f), 'utf8').includes('SECRET_MARKER_42'), f);
  assert.ok(!out.stdout.includes('SECRET_MARKER_42'));
});

test('"risk_tiers": false disables tree.js; internal failures exit 0 with ok false', () => {
  const { dir } = gitRepo('typescript');
  const off = cli(dir, ['--files', 'src/app.ts'], home({ risk_tiers: false }));
  assert.deepEqual(JSON.parse(off.stdout), { ok: true, disabled: true });
  const bad = cli(dir, ['--diff', 'missing.patch'], home());
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const flag = cli(dir, ['--base', '--upload-pack=x'], home());
  assert.equal(JSON.parse(flag.stdout).ok, false);
});

test('classify.js output keeps its six keys and gains no tier (REQ-2, REQ-3)', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'classify.js'), '--files', 'src/a.py'], { cwd: tmp('spine-cls-'), encoding: 'utf8', env: cleanEnv({ SPINE_HOME: home() }) });
  assert.deepEqual(Object.keys(JSON.parse(out.stdout)), ['size', 'blast_radius', 'signals', 'lenses', 'devils_advocate', 'workflows']);
});

// ---- T-3: product context in tree.json ----
const crypto = require('node:crypto');
const { SIGNAL_KEYS } = require('../scripts/lib/tiers');
const { tierConfigHash } = require('../scripts/lib/tier-config');
const { CACHE_FORMAT } = require('../scripts/lib/graph-cache');

function productMd(flows) {
  const blocks = flows.map((f, i) => `### ${f.name}\nweight: ${f.weight}\npaths: ${f.paths}\n1. step ${i}\n`).join('\n');
  return `# Product\n\n## Users\nOwners.\n\n## Goals\nShip.\n\n## Glossary\n- term\n\n## Invariants\n- none\n\n## Key flows\n${blocks}\n## UX principles\n- clear\n`;
}
const writeProduct = (dir, flows) => {
  fs.mkdirSync(path.join(dir, '.spine'), { recursive: true });
  const text = productMd(flows);
  fs.writeFileSync(path.join(dir, '.spine/product.md'), text);
  return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
};

test('tree.json has no product keys and no inputs.product_sha256 without product.md', () => {
  const { dir } = gitRepo('typescript');
  const { tree } = run(dir, ['src/lib/math.ts']);
  assert.deepEqual(Object.keys(tree.files[0].signals), SIGNAL_KEYS);
  assert.equal('product_sha256' in tree.inputs, false);
  assert.equal(tree.inputs.config_sha256, tierConfigHash(tc));
  assert.deepEqual(Object.keys(tree.inputs), ['base_sha', 'head_sha', 'diff_sha256', 'config_sha256', 'classifier_version', 'parser_version']);
});

test('with product.md the keys appear and inputs.product_sha256 equals the file hash', () => {
  const { dir } = gitRepo('typescript');
  const sha = writeProduct(dir, [{ name: 'Math', weight: 'critical', paths: 'src/lib/**' }]);
  const { tree } = run(dir, ['src/lib/math.ts']);
  assert.deepEqual(validateTree(tree), []);
  assert.equal(tree.inputs.product_sha256, sha);
  const f = fileOf(tree, 'src/lib/math.ts');
  assert.equal(f.signals.key_flow.value, true);
  assert.deepEqual(f.signals.key_flow.flows, [{ name: 'Math', weight: 'critical' }]);
  assert.equal(f.tier, 'trunk');
  assert.ok(f.reasons.includes('key flow Math (critical)'));
});

test('a malformed product.md adds no product keys', () => {
  const { dir } = gitRepo('typescript');
  fs.mkdirSync(path.join(dir, '.spine'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.spine/product.md'), '## Users\nonly\n');
  const { tree } = run(dir, ['src/lib/math.ts']);
  assert.deepEqual(Object.keys(tree.files[0].signals), SIGNAL_KEYS);
  assert.equal('product_sha256' in tree.inputs, false);
});

test('warm cache plus changed flow paths changes key_flow; CACHE_FORMAT stays 1', () => {
  const { dir } = gitRepo('typescript');
  writeProduct(dir, [{ name: 'Math', weight: 'critical', paths: 'src/lib/**' }]);
  const first = run(dir, ['src/lib/math.ts']);
  assert.equal(fileOf(first.tree, 'src/lib/math.ts').signals.key_flow.value, true);
  writeProduct(dir, [{ name: 'Math', weight: 'critical', paths: 'src/other/**' }]);
  const second = run(dir, ['src/lib/math.ts']);
  assert.notEqual(second.diagnostics.cache, 'miss', 'cache was warm');
  assert.equal(fileOf(second.tree, 'src/lib/math.ts').signals.key_flow.value, false);
  assert.notEqual(second.tree.inputs.product_sha256, first.tree.inputs.product_sha256);
  assert.equal(CACHE_FORMAT, 1);
  const cacheText = fs.readdirSync(path.join(dir, '.spine/cache')).map((n) => fs.readFileSync(path.join(dir, '.spine/cache', n), 'utf8')).join('');
  assert.ok(!cacheText.includes('key_flow') && !cacheText.includes('user_facing'));
});

test('50-flow product.md stays within tree_budget_ms', () => {
  const dir = tmp('spine-tree-bench-');
  const paths = makeSyntheticRepo(dir, { files: 400, git: true });
  const flows = Array.from({ length: 50 }, (_, i) => ({ name: `Flow${i}`, weight: 'minor', paths: `m${i}/**, m${i}/f*.ts` }));
  writeProduct(dir, flows);
  const out = run(dir, [paths[1], paths[2], paths[3]]);
  assert.equal(out.diagnostics.budget_exceeded, false);
  assert.ok(out.diagnostics.elapsed_ms < tc.tree_budget_ms, `${out.diagnostics.elapsed_ms}ms`);
});
