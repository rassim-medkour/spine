'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');
const { prepareWorktree, removeWorktree, activeWorktree } = require('../scripts/lib/worktree');

const ROOT = path.join(__dirname, '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A local clone of a remote that carries a GitHub-style pull ref (refs/pull/7/head)
// whose commit is not checked out in the clone.
function setup(t) {
  const base = tmpDir('spine-wt-test-', t);
  const remote = path.join(base, 'remote.git');
  const author = path.join(base, 'author');
  const clone = path.join(base, 'clone');
  git(base, 'init', '-q', '--bare', remote);
  fs.mkdirSync(author);
  git(author, 'init', '-q');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) git(author, 'config', k, v);
  fs.writeFileSync(path.join(author, 'a.txt'), 'main\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'main');
  git(author, 'push', '-q', remote, 'HEAD:refs/heads/main');
  git(author, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(author, 'pr-only.txt'), 'from the PR\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'pr');
  const prSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', remote, 'HEAD:refs/pull/7/head', 'HEAD:refs/heads/feature');
  git(base, 'clone', '-q', '--branch', 'main', remote, clone);
  const runDir = path.join(clone, '.spine', '20261022-pr-7');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{}');
  return { base, clone, runDir, prSha, tmpRoot: base };
}

test('a PR that is not checked out gets a detached worktree at its head, outside the repo', (t) => {
  const s = setup(t);
  const wt = prepareWorktree({ root: s.clone, runDir: s.runDir, pr: '7', tmpRoot: s.tmpRoot });
  assert.equal(wt.sha, s.prSha);
  assert.equal(wt.ref, 'pull/7/head');
  assert.ok(fs.existsSync(path.join(wt.path, 'pr-only.txt')), 'PR files are on disk in the worktree');
  assert.ok(!path.resolve(wt.path).startsWith(path.resolve(s.clone) + path.sep), 'worktree lives outside the repo');
  assert.ok(!fs.existsSync(path.join(s.clone, 'pr-only.txt')), 'the main checkout is untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.runDir, 'worktree.json'), 'utf8')), { path: wt.path, sha: s.prSha, ref: 'pull/7/head', removed: false });
  assert.equal(activeWorktree(s.runDir), wt.path);
  removeWorktree({ root: s.clone, runDir: s.runDir });
});

test('a branch gets a worktree too, and a second prepare reuses the same worktree', (t) => {
  const s = setup(t);
  const first = prepareWorktree({ root: s.clone, runDir: s.runDir, branch: 'feature', tmpRoot: s.tmpRoot });
  const again = prepareWorktree({ root: s.clone, runDir: s.runDir, branch: 'feature', tmpRoot: s.tmpRoot });
  assert.equal(first.sha, s.prSha);
  assert.equal(again.path, first.path);
  removeWorktree({ root: s.clone, runDir: s.runDir });
});

test('remove deletes the worktree, unregisters it from git and marks worktree.json removed', (t) => {
  const s = setup(t);
  const wt = prepareWorktree({ root: s.clone, runDir: s.runDir, pr: '7', tmpRoot: s.tmpRoot });
  removeWorktree({ root: s.clone, runDir: s.runDir });
  assert.ok(!fs.existsSync(wt.path));
  assert.ok(!git(s.clone, 'worktree', 'list').includes(path.basename(wt.path)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.runDir, 'worktree.json'), 'utf8')).removed, true);
  assert.equal(activeWorktree(s.runDir), null);
  assert.doesNotThrow(() => removeWorktree({ root: s.clone, runDir: s.runDir }), 'removing twice is a no-op');
});

test('a PR number or branch name that is not plain is rejected before git runs', (t) => {
  const s = setup(t);
  for (const pr of ['7; rm -rf /', '-1', 'abc', '']) assert.throws(() => prepareWorktree({ root: s.clone, runDir: s.runDir, pr, tmpRoot: s.tmpRoot }), /PR number/);
  for (const branch of ['-x', 'a b', 'feature;id']) assert.throws(() => prepareWorktree({ root: s.clone, runDir: s.runDir, branch, tmpRoot: s.tmpRoot }), /branch name/);
  assert.throws(() => prepareWorktree({ root: s.clone, runDir: s.runDir, tmpRoot: s.tmpRoot }), /--pr or --branch/);
});

test('record-proof runs the proof command inside the review worktree', (t) => {
  const s = setup(t);
  prepareWorktree({ root: s.clone, runDir: s.runDir, pr: '7', tmpRoot: s.tmpRoot });
  t.after(() => removeWorktree({ root: s.clone, runDir: s.runDir }));
  fs.writeFileSync(path.join(s.runDir, 'tree.json'), JSON.stringify({ tier: 'leaf', files: [], inputs: { head_sha: 'a'.repeat(40), diff_sha256: 'b'.repeat(64) } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'record-proof.js'), '--run', s.runDir, '--kind', 'test_run', '--command', 'node -e "process.exit(require(\'fs\').existsSync(\'pr-only.txt\') ? 0 : 3)"'], { cwd: s.clone, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).passed, true);
});

test('review-worktree.js prints the worktree as JSON and removes it with --remove', (t) => {
  const s = setup(t);
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'review-worktree.js'), ...args], { cwd: s.clone, encoding: 'utf8', env: { ...cleanEnv(), SPINE_WORKTREE_TMP: s.tmpRoot } });
  const made = cli('--run', s.runDir, '--pr', '7');
  assert.equal(made.status, 0, made.stderr);
  const wt = JSON.parse(made.stdout);
  assert.equal(wt.sha, s.prSha);
  const gone = cli('--run', s.runDir, '--remove');
  assert.equal(gone.status, 0, gone.stderr);
  assert.ok(!fs.existsSync(wt.path));
});

test('both skills create the review worktree before proof and remove it after', () => {
  for (const rel of ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(text.includes('scripts/review-worktree.js --run <run> --pr <n>'), `${rel} creates the worktree`);
    assert.ok(text.includes('scripts/review-worktree.js --run <run> --remove'), `${rel} removes the worktree`);
    assert.ok(text.includes('never ask\n      the human to check the branch out'), `${rel} does not hand checkout to the human`);
  }
});
