'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');

function fixtureRun() {
  const dir = tmpDir('spine-xhost-');
  fs.cpSync(path.join(__dirname, 'fixtures', 'graph', 'typescript'), dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  fs.appendFileSync(path.join(dir, 'src/lib/math.ts'), 'export const sub = (a: number, b: number) => a - b;\n');
  const runDir = path.join(dir, '.spine', '20261015-xhost');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), '{}');
  fs.writeFileSync(path.join(runDir, 'diff.patch'), git('diff'));
  fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify({ id: 'x', upstream_id: 'none', verdict: 'PASS', providers: [], findings: [], dissent: [] }));
  return { dir, runDir };
}

function pipelineOutputs(env) {
  const { dir, runDir } = fixtureRun();
  const home = tmpDir('spine-xhost-home-');
  const node = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: home, ...env(dir) }) });
  node('tree.js', ['--run', runDir, '--diff', path.join(runDir, 'diff.patch')]);
  node('check-proof.js', ['--run', runDir]);
  node('verdict.js', ['--run', runDir, '--write']);
  node('reading-map.js', ['--run', runDir]);
  const read = (f) => fs.readFileSync(path.join(runDir, f), 'utf8');
  const tree = JSON.parse(read('tree.json'));
  return {
    tiers: tree.files.map((f) => [f.path, f.tier]),
    knobs: tree.knobs,
    verdict: JSON.parse(read('review.json')).verdict,
    missing: JSON.parse(read('review.json')).missing_proof,
    groups: JSON.parse(read('reading-map.json')).groups,
  };
}

test('Claude Code and Cursor environments give the same tiers, verdict and reading-map groups', () => {
  const claude = pipelineOutputs((dir) => ({ CLAUDE_PROJECT_DIR: dir }));
  const cursor = pipelineOutputs((dir) => ({ CURSOR_PROJECT_DIR: dir, CURSOR_PLUGIN_ROOT: ROOT }));
  assert.deepEqual(cursor, claude);
  assert.equal(claude.verdict, 'UNPROVEN');
});
