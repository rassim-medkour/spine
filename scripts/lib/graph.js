'use strict';
const path = require('node:path');
const { extractImports, resolveImport, parserFor, stemOf, specStem } = require('./imports');

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const BARREL = /(^|\/)(index\.[cm]?[jt]sx?|__init__\.py)$/;
const EXCLUDED_DIR = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.venv|venv|__pycache__|generated|\.git)\//;

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function pyTopLevelOf(paths, pyRoots) {
  const top = new Set();
  for (const p of paths.filter((x) => x.endsWith('.py'))) {
    for (const r of pyRoots) {
      const rel = r === '' ? p : p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
      if (rel) top.add(rel.split('/')[0].replace(/\.py$/, ''));
    }
  }
  return top;
}

function buildContext(paths, hints) {
  const stems = new Map();
  for (const p of paths) if (parserFor(p) === 'generic') addTo(stems, stemOf(p), p);
  const pyRoots = (hints.pyRoots || ['']).filter((r) => r === '' || paths.some((p) => p.startsWith(`${r}/`)));
  return {
    fileSet: new Set(paths),
    goPackages: new Set(paths.filter((p) => p.endsWith('.go')).map((p) => path.posix.dirname(p))),
    goTestDirs: new Set(paths.filter((p) => p.endsWith('_test.go')).map((p) => path.posix.dirname(p))),
    stems: new Map([...stems].map(([k, v]) => [k, [...v].sort()])),
    pyRoots,
    pyTopLevel: pyTopLevelOf(paths, pyRoots),
    jsAliases: hints.jsAliases || [],
    baseUrls: hints.baseUrls || [],
    goModules: hints.goModules || [],
  };
}

function entryFor(f, cached, diagnostics) {
  const hit = f.key ? cached.get(f.key) : null;
  if (hit) {
    diagnostics.cache_hits += 1;
    return { entry: hit, fresh: false };
  }
  const parser = parserFor(f.path);
  if (f.binary) return { entry: { parser, specs: [], error: 'binary' }, fresh: false };
  if (typeof f.text !== 'string') return { entry: { parser, specs: [], error: f.error || 'unreadable' }, fresh: false };
  return { entry: extractImports(f.path, f.text), fresh: true };
}

function index(kept, ctx, cached) {
  const state = { nodes: new Map(), importers: new Map(), pkgImporters: new Map(), unresolvedByStem: new Map(), extracted: new Map() };
  const diagnostics = { files: kept.length, parsed: {}, failures: 0, unresolved: 0, dynamic_non_literal: 0, cache_hits: 0 };
  for (const f of kept) {
    const { entry, fresh } = entryFor(f, cached, diagnostics);
    if (fresh && f.key && !entry.error) state.extracted.set(f.key, entry);
    state.nodes.set(f.path, { parser: entry.parser, error: entry.error || null });
    diagnostics.parsed[entry.parser] = (diagnostics.parsed[entry.parser] || 0) + 1;
    if (entry.error) diagnostics.failures += 1;
    for (const spec of entry.specs) {
      const r = resolveImport(f.path, entry.parser, spec, ctx);
      if (r.dynamic) {
        diagnostics.dynamic_non_literal += 1;
        continue;
      }
      for (const t of r.targets) if (t !== f.path) addTo(state.importers, t, f.path);
      for (const pkg of r.packages) addTo(state.pkgImporters, pkg, f.path);
      if (r.targets.length || r.packages.length || r.external) continue;
      diagnostics.unresolved += 1;
      const stem = specStem(entry.parser, spec.specifier);
      if (stem && !state.unresolvedByStem.has(stem)) state.unresolvedByStem.set(stem, f.path);
    }
  }
  return { state, diagnostics };
}

function buildGraph({ files, hints = {}, cached = new Map() }) {
  const kept = files.filter((f) => !EXCLUDED_DIR.test(f.path));
  const ctx = buildContext(kept.map((f) => f.path), hints);
  const { state, diagnostics } = index(kept, ctx, cached);

  function importersOf(file) {
    const node = state.nodes.get(file);
    if (node && node.parser === 'go') {
      const dir = path.posix.dirname(file);
      return [...(state.pkgImporters.get(dir) || [])].filter((p) => path.posix.dirname(p) !== dir).sort();
    }
    return [...(state.importers.get(file) || [])].sort();
  }

  function fanIn(file) {
    const node = state.nodes.get(file);
    if (!node) return { value: null, resolved: false, rule: 'fan-in unknown: file not in graph' };
    if (node.error === 'binary') return { value: null, resolved: false, rule: 'fan-in unknown: binary file' };
    if (node.error) return { value: null, resolved: false, rule: `fan-in unknown: ${node.error}` };
    const value = importersOf(file).length;
    const partialFrom = state.unresolvedByStem.get(stemOf(file));
    if (partialFrom) return { value, resolved: false, rule: `fan-in partial: unresolved import in ${partialFrom}` };
    return { value, resolved: true, rule: `direct importers (${node.parser})` };
  }

  function downstream(file, depth) {
    if (!fanIn(file).resolved) return null;
    const seen = new Set([file]);
    let frontier = [file];
    let total = 0;
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next = [];
      for (const f of frontier) {
        const queue = importersOf(f);
        while (queue.length) {
          const imp = queue.shift();
          if (seen.has(imp)) continue;
          seen.add(imp);
          if (BARREL.test(imp)) {
            queue.push(...importersOf(imp));
            continue;
          }
          total += 1;
          next.push(imp);
        }
      }
      frontier = next;
    }
    return total;
  }

  function tested(file) {
    if (TEST_FILE.test(file)) return { value: true, rule: 'is a test file' };
    const node = state.nodes.get(file);
    if (node && node.parser === 'go' && ctx.goTestDirs.has(path.posix.dirname(file))) return { value: true, rule: 'same-package _test.go file (heuristic)' };
    if (!fanIn(file).resolved) return { value: null, rule: 'unknown: fan-in unresolved' };
    const direct = importersOf(file);
    const viaBarrel = direct.filter((p) => BARREL.test(p)).flatMap(importersOf);
    const by = [...direct, ...viaBarrel].find((p) => TEST_FILE.test(p));
    return by ? { value: true, rule: `imported by test ${by} (heuristic)` } : { value: false, rule: 'no test file imports it (heuristic)' };
  }

  return { fanIn, importersOf, downstream, tested, extracted: state.extracted, diagnostics };
}

module.exports = { TEST_FILE, BARREL, EXCLUDED_DIR, buildGraph };
