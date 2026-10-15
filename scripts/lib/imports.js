'use strict';
const path = require('node:path');

const PARSER_VERSION = '1';
const EXT_PARSER = Object.freeze({
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.go': 'go',
});
const NON_CODE_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.lock', '.csv', '.svg', '.ini', '.cfg', '.env', '.map', '']);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|bz2|7z|jar|war|woff2?|ttf|otf|eot|mp[34]|mov|avi|exe|dll|so|dylib|bin|wasm|class|pyc)$/i;
const JS_EXTS = Object.freeze(['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs']);
const JS_TO_TS = Object.freeze({ '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] });
const ALIAS_LIKE = /^(~|#|@\/)/;

function parserFor(file) {
  const ext = path.posix.extname(file).toLowerCase();
  if (EXT_PARSER[ext]) return EXT_PARSER[ext];
  if (BINARY_EXT.test(file) || NON_CODE_EXT.has(ext)) return 'none';
  return 'generic';
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function stemOf(file) {
  const base = path.posix.basename(String(file));
  const dot = base.indexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

function specStem(parser, specifier) {
  if (!specifier) return null;
  if (parser === 'python') {
    const last = specifier.split('.').filter(Boolean).pop();
    return last ? last.toLowerCase() : null;
  }
  return stemOf(specifier.replace(/\/+$/, ''));
}

// Removes // and /* */ comments; keeps string and template contents.
function stripJsComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n || ''; i += 1; } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const JS_PATTERNS = Object.freeze([
  /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])([^'"\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\bimport\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g,
]);
const JS_NON_LITERAL = Object.freeze([/\b(?:import|require)\s*\(\s*(?!['"`])/g, /\bimport\s*\(\s*`[^`]*\$\{/g]);

function extractJs(text) {
  const src = stripJsComments(text);
  const specs = [];
  for (const re of JS_PATTERNS) for (const m of src.matchAll(re)) specs.push({ specifier: m[2], literal: true });
  for (const re of JS_NON_LITERAL) for (const m of src.matchAll(re)) if (m) specs.push({ specifier: null, literal: false });
  return specs;
}

function pyNames(raw) {
  return raw.replace(/[()\\]/g, ' ').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^\w+$/.test(s));
}

function extractPython(text) {
  const specs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, '');
    const imp = /^\s*import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[\w.]+$/.test(mod)) specs.push({ specifier: mod, literal: true, names: [] });
      }
      continue;
    }
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (from) {
      let names = from[2];
      while (names.includes('(') && !names.includes(')') && i + 1 < lines.length) names += ` ${lines[(i += 1)].replace(/#.*$/, '')}`;
      specs.push({ specifier: from[1], literal: true, names: pyNames(names) });
      continue;
    }
    if (/\b(?:importlib\.import_module|__import__)\s*\(\s*(?!['"])/.test(line)) specs.push({ specifier: null, literal: false });
  }
  return specs;
}

function extractGo(text) {
  const src = stripJsComments(text);
  const specs = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) specs.push({ specifier: m[1], literal: true });
  for (const block of src.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/^\s*(?:[\w.]+\s+)?"([^"]+)"/gm)) specs.push({ specifier: m[1], literal: true });
  }
  return specs;
}

const GENERIC_LINE = /^\s*(?:import|require|require_relative|include|use|using|load|source|from|#include|@import|extends)\b(.*)$/;

function extractGeneric(text) {
  const specs = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = GENERIC_LINE.exec(raw);
    if (!m) continue;
    const quoted = /['"<]([^'">]+)['">]/.exec(m[1]);
    const token = quoted ? quoted[1] : m[1].trim().split(/[\s;{(]/)[0];
    if (token) specs.push({ specifier: token, literal: true });
  }
  return specs;
}

const EXTRACTORS = Object.freeze({ python: extractPython, typescript: extractJs, javascript: extractJs, go: extractGo, generic: extractGeneric });

function extractImports(file, text) {
  const parser = parserFor(file);
  if (parser === 'none') return { parser, specs: [] };
  if (typeof text !== 'string') return { parser, specs: [], error: 'unreadable' };
  try {
    return { parser, specs: EXTRACTORS[parser](text) };
  } catch {
    return { parser, specs: [], error: 'parse error' };
  }
}

const firstExisting = (candidates, fileSet) => candidates.find((c) => fileSet.has(c)) || null;
const inScope = (from, scope) => scope === '' || from.startsWith(`${scope}/`);
const clean = (p) => {
  const n = path.posix.normalize(p);
  return n === '.' ? '' : n.replace(/^\.\//, '');
};

function jsCandidates(base) {
  const ext = path.posix.extname(base);
  const swapped = (JS_TO_TS[ext] || []).map((e) => base.slice(0, -ext.length) + e);
  return [base, ...swapped, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
}

const hit = (target) => ({ targets: [target], packages: [], external: false });
const MISS = Object.freeze({ targets: [], packages: [], external: false });

function aliasMatch(a, spec) {
  if (!a.wildcard) return spec === a.prefix ? '' : null;
  if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix) || spec.length < a.prefix.length + a.suffix.length) return null;
  return spec.slice(a.prefix.length, spec.length - a.suffix.length);
}

function resolveJs(from, spec, ctx) {
  if (spec.startsWith('.')) {
    const joined = clean(path.posix.join(path.posix.dirname(from), spec));
    if (joined.startsWith('../') || joined === '..') return MISS;
    const found = firstExisting(jsCandidates(joined), ctx.fileSet);
    return found ? hit(found) : MISS;
  }
  for (const a of ctx.jsAliases || []) {
    if (!inScope(from, a.scope)) continue;
    const mid = aliasMatch(a, spec);
    if (mid === null) continue;
    for (const target of a.targets) {
      const found = firstExisting(jsCandidates(clean(target.replace('*', mid))), ctx.fileSet);
      if (found) return hit(found);
    }
    return MISS;
  }
  for (const b of ctx.baseUrls || []) {
    if (!inScope(from, b.scope)) continue;
    const found = firstExisting(jsCandidates(clean(path.posix.join(b.dir || '.', spec))), ctx.fileSet);
    if (found) return hit(found);
    break;
  }
  return { targets: [], packages: [], external: !ALIAS_LIKE.test(spec) };
}

function resolvePython(from, spec, names, ctx) {
  const dots = /^\.*/.exec(spec)[0].length;
  const mod = spec.slice(dots).replace(/\./g, '/');
  let bases;
  if (dots > 0) {
    let dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i += 1) dir = path.posix.dirname(dir);
    bases = [[dir === '.' ? '' : dir, mod].filter(Boolean).join('/')];
  } else {
    bases = (ctx.pyRoots || ['']).map((r) => [r, mod].filter(Boolean).join('/'));
  }
  for (const base of bases) {
    const prefix = base ? `${base}/` : '';
    const subs = (names || []).map((n) => firstExisting([`${prefix}${n}.py`, `${prefix}${n}/__init__.py`], ctx.fileSet)).filter(Boolean);
    if (subs.length) return { targets: [...new Set(subs)], packages: [], external: false };
    const own = base ? firstExisting([`${base}.py`, `${base}/__init__.py`], ctx.fileSet) : null;
    if (own) return hit(own);
  }
  const internal = dots > 0 || (ctx.pyTopLevel || new Set()).has(spec.slice(dots).split('.')[0]);
  return { targets: [], packages: [], external: !internal };
}

function resolveGo(spec, ctx) {
  for (const m of ctx.goModules || []) {
    if (spec !== m.module && !spec.startsWith(`${m.module}/`)) continue;
    const rest = spec === m.module ? '' : spec.slice(m.module.length + 1);
    const dir = [m.dir, rest].filter(Boolean).join('/') || '.';
    return ctx.goPackages && ctx.goPackages.has(dir) ? { targets: [], packages: [dir], external: false } : MISS;
  }
  return { targets: [], packages: [], external: true };
}

function resolveGeneric(from, spec, ctx) {
  const name = spec.includes('/')
    ? path.posix.basename(spec.replace(/\\/g, '/')).replace(/\.[^.]+$/, '')
    : spec.split(/::|\./).filter(Boolean).pop() || '';
  const targets = ((ctx.stems && ctx.stems.get(name.toLowerCase())) || []).filter((p) => p !== from);
  return { targets, packages: [], external: targets.length === 0 };
}

function resolveImport(from, parser, spec, ctx) {
  if (!spec.literal || !spec.specifier) return { targets: [], packages: [], external: false, dynamic: true };
  if (parser === 'typescript' || parser === 'javascript') return resolveJs(from, spec.specifier, ctx);
  if (parser === 'python') return resolvePython(from, spec.specifier, spec.names, ctx);
  if (parser === 'go') return resolveGo(spec.specifier, ctx);
  if (parser === 'generic') return resolveGeneric(from, spec.specifier, ctx);
  return { targets: [], packages: [], external: true };
}

module.exports = { PARSER_VERSION, BINARY_EXT, parserFor, isBinaryBuffer, stemOf, specStem, extractImports, resolveImport };
