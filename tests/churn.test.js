'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { churn, churnCounts } = require('../scripts/lib/churn');

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-churn-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { dir, git };
}

function commitFile(dir, git, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git('add', relPath);
  git('commit', '-q', '-m', `touch ${relPath}`);
}

test('churnCounts matches per-file churn for each requested file', () => {
  const { dir, git } = initRepo();
  commitFile(dir, git, 'a.txt', '1');
  commitFile(dir, git, 'a.txt', '2');
  commitFile(dir, git, 'b.txt', '1');
  const counts = churnCounts(['a.txt', 'b.txt'], dir);
  assert.equal(counts.get('a.txt'), churn('a.txt', dir));
  assert.equal(counts.get('b.txt'), churn('b.txt', dir));
  assert.equal(counts.get('a.txt'), 2);
  assert.equal(counts.get('b.txt'), 1);
});

test('churnCounts does not count a commit against a file it did not touch', () => {
  const { dir, git } = initRepo();
  commitFile(dir, git, 'a.txt', '1');
  commitFile(dir, git, 'b.txt', '1');
  const counts = churnCounts(['a.txt', 'b.txt'], dir);
  assert.equal(counts.get('a.txt'), 1);
  assert.equal(counts.get('b.txt'), 1);
});

test('churnCounts returns zero for a file with no history', () => {
  const { dir } = initRepo();
  const counts = churnCounts(['missing.txt'], dir);
  assert.equal(counts.get('missing.txt'), 0);
});

test('churnCounts returns an empty map for no files, without spawning git', () => {
  const counts = churnCounts([], '/nonexistent/path/should/not/be/used');
  assert.equal(counts.size, 0);
});
