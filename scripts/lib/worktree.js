'use strict';
// A review worktree: the PR or branch under review, checked out detached in
// the temp folder so proof commands can run against its files without
// touching the main checkout. <run>/worktree.json records where it is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PR_RE = /^[1-9]\d{0,9}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const REMOTE_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;
const PREFIX = 'spine-wt-';
const FILE = 'worktree.json';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readState(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, FILE), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(runDir, state) {
  fs.writeFileSync(path.join(runDir, FILE), `${JSON.stringify(state, null, 2)}\n`);
}

const named = (p) => typeof p === 'string' && path.basename(p).startsWith(PREFIX);

// none: no review worktree for this run; active: use path; gone: there was one
// but it was removed or is missing, so proof must not quietly run elsewhere.
function worktreeStatus(runDir) {
  const s = readState(runDir);
  if (!s) return { status: 'none' };
  if (s.removed) return { status: 'gone', reason: 'removed' };
  if (!named(s.path) || !fs.existsSync(s.path)) return { status: 'gone', reason: 'missing' };
  return { status: 'active', path: s.path };
}

function activeWorktree(runDir) {
  const w = worktreeStatus(runDir);
  return w.status === 'active' ? w.path : null;
}

// realpath expands Windows short names (RUNNER~1) so both sides compare equal.
function norm(p) {
  let full = path.resolve(p);
  try { full = fs.realpathSync.native(full); } catch { /* compare as given */ }
  return full.replace(/\\/g, '/').toLowerCase();
}

function registered(root, p) {
  const want = norm(p);
  return git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .some((l) => norm(l.slice('worktree '.length)) === want);
}

function resolveTarget({ root, pr, branch, remote }) {
  if (!REMOTE_RE.test(String(remote))) throw new Error(`remote name must be plain (letters, digits, . _ / -), got ${JSON.stringify(remote)}`);
  if (pr !== undefined) {
    if (!PR_RE.test(String(pr))) throw new Error(`PR number must be a positive integer, got ${JSON.stringify(pr)}`);
    const ref = `pull/${pr}/head`;
    git(root, ['fetch', '--no-tags', '--quiet', remote, `+refs/${ref}`]);
    return { ref, sha: git(root, ['rev-parse', 'FETCH_HEAD']) };
  }
  if (branch !== undefined) {
    if (!BRANCH_RE.test(String(branch))) throw new Error(`branch name must be plain (letters, digits, . _ / -), got ${JSON.stringify(branch)}`);
    try {
      git(root, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}`]);
      return { ref: branch, sha: git(root, ['rev-parse', 'FETCH_HEAD']) };
    } catch {
      // No remote or offline: fall back to the local branch.
      return { ref: branch, sha: git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]) };
    }
  }
  throw new Error('give --pr or --branch');
}

function prepareWorktree({ root, runDir, pr, branch, remote = 'origin', tmpRoot = process.env.SPINE_WORKTREE_TMP || os.tmpdir() }) {
  const target = resolveTarget({ root, pr, branch, remote });
  const current = readState(runDir);
  if (current && !current.removed && current.sha === target.sha && fs.existsSync(current.path)) return current;
  if (current && !current.removed) removeWorktree({ root, runDir });
  const dir = fs.mkdtempSync(path.join(tmpRoot, `spine-wt-${path.basename(runDir)}-`));
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, target.sha]);
  const state = { path: dir, sha: target.sha, ref: target.ref, removed: false };
  writeState(runDir, state);
  return state;
}

function removeWorktree({ root, runDir }) {
  const s = readState(runDir);
  if (!s || s.removed) return;
  if (typeof s.path === 'string' && fs.existsSync(s.path)) {
    if (!named(s.path) || !registered(root, s.path)) throw new Error(`${s.path} is not a spine review worktree; not removing it`);
    try {
      git(root, ['worktree', 'remove', '--force', s.path]);
    } catch {
      fs.rmSync(s.path, { recursive: true, force: true, maxRetries: 2 });
    }
  }
  try { git(root, ['worktree', 'prune']); } catch { /* best effort */ }
  writeState(runDir, { ...s, removed: true });
}

module.exports = { prepareWorktree, removeWorktree, activeWorktree, worktreeStatus };
