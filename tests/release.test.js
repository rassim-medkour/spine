const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('.gitattributes normalizes text files to LF', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('.gitignore ignores stackdumps and local tool dirs', () => {
  const lines = read('.gitignore').split(/\r?\n/);
  for (const entry of ['*.stackdump', '.spine/', '.worktrees/', '.superpowers/']) {
    assert.ok(lines.includes(entry), `.gitignore is missing ${entry}`);
  }
});

test('no stackdump is tracked', () => {
  assert.deepEqual(trackedFiles().filter((f) => f.endsWith('.stackdump')), []);
});

// Patterns are built from fragments so this file never matches itself.
const USER = ['ras', 'si'].join('');
const PERSONAL_PATH = new RegExp(
  [`[A-Za-z]:[\\\\/]Users[\\\\/]${USER}`, `/c/Users/${USER}`, `/Users/${USER}`, `/home/${USER}`].join('|'),
  'i',
);
const WORK_TRACE = new RegExp([['allo', 'sylvia'].join(''), ['services', 'main'].join('/'), ['appoint', 'ments'].join('')].join('|'), 'i');
// .mailmap must name the old author addresses to remap them; they are already public in history.
const SCAN_ALLOW = new Set(['.mailmap']);
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf)$/i;

function scan(pattern) {
  const hits = [];
  for (const file of trackedFiles()) {
    if (SCAN_ALLOW.has(file) || BINARY.test(file) || !fs.existsSync(path.join(ROOT, file))) continue;
    read(file).split(/\r?\n/).forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  return hits;
}

test('no personal absolute paths in tracked files', () => {
  assert.deepEqual(scan(PERSONAL_PATH), []);
});

test('no work-project traces in tracked files', () => {
  assert.deepEqual(scan(WORK_TRACE), []);
});

test('design spec kept under docs/design, ring-1 plan removed', () => {
  const files = trackedFiles();
  assert.ok(files.includes('docs/design/spine-plugin-design.md'));
  assert.deepEqual(files.filter((f) => f.startsWith('docs/superpowers/')), []);
});

test('.mailmap maps old author emails to the public identity', () => {
  const text = read('.mailmap');
  assert.match(text, /23105160\+rassim-medkour@users\.noreply\.github\.com/);
  assert.equal(text.trim().split(/\r?\n/).length, 2);
});
