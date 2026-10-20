'use strict';
const path = require('node:path');

const dirOf = (p) => {
  const d = path.posix.dirname(p);
  return d === '.' ? '' : d;
};

function joinPosix(a, b) {
  const j = path.posix.normalize(path.posix.join(a || '.', b));
  return j === '.' ? '' : j.replace(/^\.\//, '');
}

// tsconfig.json and jsconfig.json allow comments and trailing commas.
function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
  try {
    return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

function aliasesFrom(configPath, cfg) {
  const dir = dirOf(configPath);
  const opts = cfg && cfg.compilerOptions && typeof cfg.compilerOptions === 'object' ? cfg.compilerOptions : {};
  const base = typeof opts.baseUrl === 'string' ? joinPosix(dir, opts.baseUrl) : null;
  const root = base === null ? dir : base;
  const paths = opts.paths && typeof opts.paths === 'object' ? opts.paths : {};
  const aliases = Object.entries(paths).filter(([, t]) => Array.isArray(t)).map(([pattern, targets]) => {
    const star = pattern.indexOf('*');
    return {
      scope: dir,
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      wildcard: star >= 0,
      targets: targets.filter((t) => typeof t === 'string').map((t) => joinPosix(root, t)),
    };
  });
  return { aliases, baseUrl: base === null ? null : { scope: dir, dir: base } };
}

function entriesFromPackage(pkgPath, pkg) {
  const dir = dirOf(pkgPath);
  const vals = [];
  const collect = (v) => {
    if (typeof v === 'string') vals.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  if (pkg) [pkg.main, pkg.bin, pkg.exports].forEach(collect);
  return vals.filter((v) => !v.includes('*')).map((v) => joinPosix(dir, v));
}

function workspaceAliases(pkgPath, pkg) {
  const dir = dirOf(pkgPath);
  if (!dir || !pkg || typeof pkg.name !== 'string' || !pkg.name) return [];
  const main = typeof pkg.main === 'string' ? joinPosix(dir, pkg.main) : null;
  return [
    { scope: '', prefix: pkg.name, suffix: '', wildcard: false, targets: [main || `${dir}/index`, `${dir}/src/index`] },
    { scope: '', prefix: `${pkg.name}/`, suffix: '', wildcard: true, targets: [`${dir}/*`, `${dir}/src/*`] },
  ];
}

function loadHints(paths, readText) {
  const jsAliases = [];
  const baseUrls = [];
  const goModules = [];
  const entryHints = new Set();
  for (const p of paths) {
    const base = path.posix.basename(p);
    if (base === 'tsconfig.json' || base === 'jsconfig.json') {
      const { aliases, baseUrl } = aliasesFrom(p, parseLooseJson(readText(p)));
      jsAliases.push(...aliases);
      if (baseUrl) baseUrls.push(baseUrl);
    } else if (base === 'go.mod') {
      const m = /^module\s+(\S+)/m.exec(readText(p) || '');
      if (m) goModules.push({ module: m[1], dir: dirOf(p) });
    } else if (base === 'package.json') {
      const pkg = parseLooseJson(readText(p));
      for (const e of entriesFromPackage(p, pkg)) entryHints.add(e);
      jsAliases.push(...workspaceAliases(p, pkg));
    }
  }
  const nearestFirst = (a, b) => b.scope.length - a.scope.length;
  return { jsAliases: jsAliases.sort(nearestFirst), baseUrls: baseUrls.sort(nearestFirst), goModules, pyRoots: ['', 'src'], entryHints };
}

module.exports = { parseLooseJson, loadHints };
