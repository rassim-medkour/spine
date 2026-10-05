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
