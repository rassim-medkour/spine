const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');

const LINT = path.join(__dirname, '..', 'scripts', 'lint.js');
const run = (root) => spawnSync(process.execPath, [LINT, '--root', root], { encoding: 'utf8' });

function repoWith(t, files) {
  const dir = tmpDir('spine-lint-', t);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  spawnSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('lint fails on a tracked syntax-broken script', (t) => {
  const dir = repoWith(t, { 'scripts/ok.js': 'module.exports = 1;\n', 'scripts/bad.js': 'const = ;\n' });
  const r = run(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lint failed: scripts\/bad\.js/);
});

test('lint ignores workflow ESM fragments and untracked files', (t) => {
  const dir = repoWith(t, { 'scripts/ok.js': 'module.exports = 1;\n', 'workflows/w.workflow.js': 'export const meta = {};\n' });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'untracked.js'), 'const = ;\n');
  assert.equal(run(dir).status, 0);
});

test('lint passes on the repo', () => {
  const r = run(path.join(__dirname, '..'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^lint ok: \d+ files/);
});
