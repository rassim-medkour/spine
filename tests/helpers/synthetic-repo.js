'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LANGS = Object.freeze(['ts', 'js', 'py', 'go']);
const DIRS = 50;
const dirOf = (k) => `m${k % DIRS}`;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function source(lang, i, deps) {
  if (lang === 'ts' || lang === 'js') return `${deps.map((j) => `import { f${j} } from '../${dirOf(j)}/f${j}';`).join('\n')}\nexport const f${i} = ${i};\n`;
  if (lang === 'py') return `${deps.map((j) => `from ${dirOf(j)} import f${j}`).join('\n')}\n\n\ndef f${i}():\n    return ${i}\n`;
  return `package ${dirOf(i)}\n\nimport (\n${deps.map((j) => `\t_ "example.com/syn/${dirOf(j)}"`).join('\n')}\n)\n\nconst F${i} = ${i}\n`;
}

// Each file imports up to three earlier files of its own language.
function makeSyntheticRepo(dir, { files = 2000, seed = 42, git = false } = {}) {
  const rnd = lcg(seed);
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/syn\n\ngo 1.22\n');
  const written = ['go.mod'];
  for (let i = 0; i < files; i += 1) {
    const lang = LANGS[i % LANGS.length];
    const earlier = Math.floor(i / LANGS.length);
    const deps = earlier === 0 ? [] : [...new Set([0, 1, 2].map(() => Math.floor(rnd() * earlier) * LANGS.length + (i % LANGS.length)))];
    const rel = `${dirOf(i)}/f${i}.${lang}`;
    fs.mkdirSync(path.join(dir, dirOf(i)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), source(lang, i, deps));
    written.push(rel);
  }
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('config', 'core.autocrlf', 'false');
    run('add', '-A');
    run('commit', '-q', '-m', 'synthetic');
  }
  return written.sort();
}

module.exports = { makeSyntheticRepo };
