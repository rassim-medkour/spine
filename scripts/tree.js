'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./lib/state');
const { tierConfig, tierConfigHash } = require('./lib/tier-config');
const { parseDiff } = require('./lib/diff');
const { parserFor, isBinaryBuffer, BINARY_EXT, PARSER_VERSION } = require('./lib/imports');
const { buildGraph, EXCLUDED_DIR } = require('./lib/graph');
const { loadHints } = require('./lib/hints');
const { classifyTree } = require('./lib/tiers');
const { gitBlobSha, cachePath, loadCache, saveCache } = require('./lib/graph-cache');

const CLASSIFIER_VERSION = '1';
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const BUDGET_CHECK_EVERY = 250;
const REF_RE = /^[A-Za-z0-9_./~^@{}-]+$/;
const DEFAULT_HINTS = Object.freeze({ jsAliases: [], baseUrls: [], goModules: [], pyRoots: ['', 'src'], entryHints: new Set() });

const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const zsplit = (buf) => buf.toString('utf8').split('\0').filter(Boolean);
const textOf = (buf) => (buf && !isBinaryBuffer(buf) ? buf.toString('utf8') : null);

function defaultIo(root) {
  return {
    git(args) {
      const r = spawnSync('git', args, { cwd: root, maxBuffer: 1 << 30 });
      return { ok: r.status === 0, out: r.status === 0 && r.stdout ? r.stdout : Buffer.alloc(0) };
    },
    read(rel) {
      try {
        return fs.readFileSync(path.join(root, rel));
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

function listRepo(io, artifactsDir) {
  const staged = io.git(['ls-files', '-s', '-z']);
  if (!staged.ok) return null;
  const shaOf = new Map();
  for (const rec of zsplit(staged.out)) {
    const m = /^\d+ ([0-9a-f]{40,64}) \d\t([\s\S]+)$/.exec(rec);
    if (m) shaOf.set(normalize(m[2]), m[1]);
  }
  const dirty = new Set(zsplit(io.git(['diff', '--name-only', '-z']).out).map(normalize));
  for (const p of zsplit(io.git(['ls-files', '--others', '--exclude-standard', '-z']).out).map(normalize)) {
    dirty.add(p);
    if (!shaOf.has(p)) shaOf.set(p, null);
  }
  const own = `${normalize(artifactsDir)}/`;
  const paths = [...shaOf.keys()].filter((p) => !EXCLUDED_DIR.test(p) && !p.startsWith(own)).sort();
  return { paths, shaOf, dirty };
}

function collectOne(listing, p, readOnce, cached) {
  const parser = parserFor(p);
  if (parser === 'none') return { path: p, key: null, text: '', binary: BINARY_EXT.test(p) };
  const indexSha = listing.dirty.has(p) ? null : listing.shaOf.get(p);
  if (indexSha && cached.has(`${parser}:${indexSha}`)) return { path: p, key: `${parser}:${indexSha}`, text: null };
  const buf = readOnce(p);
  if (!buf) return { path: p, key: null, text: null, error: 'unreadable' };
  if (buf.length > MAX_PARSE_BYTES) return { path: p, key: null, text: null, error: 'too large to parse' };
  if (isBinaryBuffer(buf)) return { path: p, key: null, text: null, binary: true };
  return { path: p, key: `${parser}:${indexSha || gitBlobSha(buf)}`, text: buf.toString('utf8') };
}

function collectFiles(listing, readOnce, cached, tc, io, started) {
  const files = [];
  for (let i = 0; i < listing.paths.length; i += 1) {
    if (i % BUDGET_CHECK_EVERY === 0 && io.now() - started > tc.tree_budget_ms) return { files, budgetExceeded: true };
    files.push(collectOne(listing, listing.paths[i], readOnce, cached));
  }
  return { files, budgetExceeded: false };
}

function changedFiles(filesArg, diffFiles, listing) {
  const byPath = new Map(diffFiles.map((d) => [d.path, d]));
  const names = filesArg.length ? filesArg.map(normalize) : [...byPath.keys()];
  return [...new Set(names)].sort().map((p) => {
    const d = byPath.get(p);
    if (d) return { path: p, status: d.status, hunks: d.hunks, oldPath: d.oldPath };
    return { path: p, status: !listing || listing.shaOf.has(p) ? 'modified' : 'added', hunks: [], oldPath: null };
  });
}

// Fan-in of deleted files is measured on the tree before the change (REQ-10):
// unchanged files keep their keys, changed files are read from the base commit.
function baseGraph({ changed, headFiles, io, base, hints, cached }) {
  const byPath = new Map(changed.map((c) => [c.path, c]));
  const show = (c) => {
    const r = io.git(['show', `${base}:${c.oldPath || c.path}`]);
    return r.ok ? textOf(r.out) : null;
  };
  const kept = headFiles.filter((f) => !byPath.has(f.path));
  const before = changed.filter((c) => c.status !== 'added').map((c) => ({ path: c.status === 'renamed' ? c.oldPath : c.path, text: show(c) }));
  return buildGraph({ files: [...kept, ...before], hints, cached });
}

const NO_GRAPH = Object.freeze({ graph: null, before: null, hints: DEFAULT_HINTS, merged: null, keep: null });

function graphs({ listing, changed, readOnce, cache, tc, io, started, base }) {
  if (!listing) return { ...NO_GRAPH, why: 'graph unavailable (git ls-files failed)' };
  if (listing.paths.length > tc.tree_max_files) return { ...NO_GRAPH, why: 'graph unavailable (file-count cap exceeded)' };
  const deleted = new Set(changed.filter((c) => c.status === 'deleted').map((c) => c.path));
  const headListing = { ...listing, paths: listing.paths.filter((p) => !deleted.has(p)) };
  const collected = collectFiles(headListing, readOnce, cache.entries, tc, io, started);
  if (collected.budgetExceeded) return { ...NO_GRAPH, why: 'budget exceeded' };
  const hints = loadHints(headListing.paths, (p) => textOf(readOnce(p)));
  const graph = buildGraph({ files: collected.files, hints, cached: cache.entries });
  const merged = new Map([...cache.entries, ...graph.extracted]);
  const before = deleted.size ? baseGraph({ changed, headFiles: collected.files, io, base, hints, cached: merged }) : null;
  return { graph, before, hints, merged, keep: new Set(collected.files.map((f) => f.key).filter(Boolean)), why: null };
}

function churnFor(paths, io) {
  const shallow = io.git(['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) return () => ({ value: null, rule: 'churn unknown: git unavailable' });
  if (shallow.out.toString('utf8').trim() === 'true') return () => ({ value: null, rule: 'churn unknown: shallow clone' });
  if (!paths.length) return () => ({ value: 0, rule: 'commits in 90 days' });
  const log = io.git(['log', '--since=90.days', '--name-only', '--pretty=format:', '--', ...paths]);
  if (!log.ok) return () => ({ value: null, rule: 'churn unknown: git log failed' });
  const counts = new Map(paths.map((p) => [p, 0]));
  for (const line of log.out.toString('utf8').split(/\r?\n/)) {
    const f = line.trim();
    if (counts.has(f)) counts.set(f, counts.get(f) + 1);
  }
  return (p) => (counts.has(p) ? { value: counts.get(p), rule: 'commits in 90 days' } : { value: null, rule: 'churn unknown: not computed' });
}

function fileInputs(changed, g, readOnce, tc) {
  const unknown = { value: null, resolved: false, rule: `fan-in unknown: ${g.why}` };
  return changed.map((c) => {
    const graph = c.status === 'deleted' ? g.before : g.graph;
    return {
      path: c.path, status: c.status, parser: parserFor(c.path), hunks: c.hunks,
      text: c.status === 'deleted' ? null : textOf(readOnce(c.path)),
      declaredEntry: g.hints.entryHints.has(c.path),
      fanIn: graph ? graph.fanIn(c.path) : unknown,
      tested: graph ? graph.tested(c.path) : { value: null, rule: 'unknown: graph unavailable' },
      importers: graph ? graph.importersOf(c.path) : [],
      downstream: graph ? graph.downstream(c.path, tc.downstream_depth) : null,
    };
  });
}

function revParse(io, ref) {
  const r = io.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok ? r.out.toString('utf8').trim() : 'none';
}

function diagnosticsOf(g, cache, started, io) {
  const d = g.graph ? g.graph.diagnostics : null;
  return {
    files_scanned: d ? d.files : 0,
    parsed: d ? d.parsed : {},
    parse_failures: d ? d.failures : 0,
    unresolved_specifiers: d ? d.unresolved : 0,
    dynamic_non_literal: d ? d.dynamic_non_literal : 0,
    cache: cache.status,
    cache_hits: d ? d.cache_hits : 0,
    budget_exceeded: g.why === 'budget exceeded',
    graph: g.why || 'ok',
    elapsed_ms: io.now() - started,
  };
}

function buildTree({ root, files = [], diffText = '', base = 'HEAD', tc, artifactsDir = '.spine', io = defaultIo(root) }) {
  const started = io.now();
  const diffBuf = Buffer.isBuffer(diffText) ? diffText : Buffer.from(String(diffText));
  const listing = listRepo(io, artifactsDir);
  const changed = changedFiles(files, parseDiff(diffBuf.toString('utf8')), listing);
  const texts = new Map();
  const readOnce = (p) => {
    if (!texts.has(p)) texts.set(p, io.read(p));
    return texts.get(p);
  };
  const cacheFile = cachePath(root, artifactsDir);
  const cache = loadCache(cacheFile);
  const g = graphs({ listing, changed, readOnce, cache, tc, io, started, base });
  const result = classifyTree(fileInputs(changed, g, readOnce, tc), null, tc, churnFor(changed.map((c) => c.path), io));
  const diagnostics = { ...diagnosticsOf(g, cache, started, io), cache_saved: g.merged ? saveCache(cacheFile, g.merged, g.keep) : 'not-saved' };
  const tree = {
    schema_version: 1,
    tier: result.tier,
    inputs: {
      base_sha: revParse(io, base),
      head_sha: revParse(io, 'HEAD'),
      diff_sha256: sha256(diffBuf),
      config_sha256: tierConfigHash(tc),
      classifier_version: CLASSIFIER_VERSION,
      parser_version: PARSER_VERSION,
    },
    knobs: result.knobs,
    files: result.files,
  };
  return { tree, diagnostics, revision: `${tree.inputs.head_sha}:${tree.inputs.diff_sha256}` };
}

const serializeTree = (tree) => `${JSON.stringify(tree, null, 2)}\n`;

function parseArgs(argv) {
  const out = { files: [], diff: null, base: 'HEAD', run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--files', '--diff', '--base', '--run'].includes(flag) || value === undefined) throw new Error(`unknown or incomplete flag ${flag}`);
    if (flag === '--files') out.files = value.split(',').map((s) => s.trim()).filter(Boolean);
    else out[flag.slice(2)] = value;
    i += 1;
  }
  if (!REF_RE.test(out.base) || out.base.startsWith('-')) throw new Error('--base must be a plain git ref');
  return out;
}

function writeRunFiles(runDir, tree, diagnostics) {
  fs.writeFileSync(path.join(runDir, 'tree.json'), serializeTree(tree));
  fs.writeFileSync(path.join(runDir, 'diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`);
  try {
    fs.appendFileSync(path.join(runDir, 'classify.log'), `${new Date().toISOString()} tree ok elapsed_ms=${diagnostics.elapsed_ms} cache=${diagnostics.cache} hits=${diagnostics.cache_hits} graph=${diagnostics.graph === 'ok' ? 'ok' : 'degraded'}\n`);
  } catch {
    // logging never fails the run
  }
  const classFile = path.join(runDir, 'class.json');
  if (!fs.existsSync(classFile)) return;
  const cls = JSON.parse(fs.readFileSync(classFile, 'utf8'));
  fs.writeFileSync(classFile, `${JSON.stringify({ ...cls, tier: tree.tier }, null, 2)}\n`);
}

function main(argv, root = process.cwd()) {
  const args = parseArgs(argv);
  const config = loadConfig(root);
  const tc = tierConfig(config);
  if (!tc.enabled) return { ok: true, disabled: true };
  const diffText = args.diff ? fs.readFileSync(path.resolve(root, args.diff)) : Buffer.alloc(0);
  const { tree, diagnostics, revision } = buildTree({ root, files: args.files, diffText, base: args.base, tc, artifactsDir: config.artifacts_dir });
  if (!args.run) {
    process.stdout.write(serializeTree(tree));
    return null;
  }
  const runDir = path.resolve(root, args.run);
  if (!fs.existsSync(path.join(runDir, 'state.json'))) throw new Error('--run must be an existing run directory');
  writeRunFiles(runDir, tree, diagnostics);
  return { ok: true, tier: tree.tier, files: tree.files.length, revision, out: 'tree.json' };
}

if (require.main === module) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { CLASSIFIER_VERSION, buildTree, serializeTree, defaultIo };
