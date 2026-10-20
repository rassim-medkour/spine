'use strict';
// Shared fixture builder for select-model tests: a repo root, a home dir and one run directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./tmp');
const { cleanEnv, ROOT } = require('./claude-cases');
const { writeState, DEFAULTS } = require('../../scripts/lib/state');
const { tierConfig, tierConfigHash } = require('../../scripts/lib/tier-config');

const RUN_ID = '20261020-model-test';
const GOLDEN = path.join(__dirname, '..', 'fixtures', 'tree-golden.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
};

// opts: size, tree (true | (tree) => tree), config (global), repoConfig, diff, treeDiff (text the tree was built from)
function makeRun(t, opts = {}) {
  const root = tmpDir('spine-model-root-', t);
  const home = tmpDir('spine-model-home-', t);
  const { size = 'M', tree = false, config, repoConfig, diff, treeDiff } = opts;
  if (config !== undefined) writeJson(path.join(home, '.spine', 'config.json'), config);
  if (repoConfig !== undefined) writeJson(path.join(root, '.spine', 'config.json'), repoConfig);
  const dir = path.join(root, '.spine', RUN_ID);
  writeState(dir, { id: RUN_ID, stage: 'implement', status: 'active', awaiting: null, size, updated: '2026-10-20T00:00:00Z', host: 'claude-code', spine_version: '0.3.0' });
  writeJson(path.join(dir, 'class.json'), { size });
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}), ...(repoConfig && typeof repoConfig === 'object' ? repoConfig : {}), artifacts_dir: '.spine' };
  if (tree) {
    let obj = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    obj.inputs.config_sha256 = tierConfigHash(tierConfig(merged));
    if (treeDiff !== undefined) obj.inputs.diff_sha256 = sha(treeDiff);
    if (typeof tree === 'function') obj = tree(obj) || obj;
    writeJson(path.join(dir, 'tree.json'), JSON.stringify(obj, null, 2) + '\n');
  }
  if (diff !== undefined) writeJson(path.join(dir, 'diff.patch'), diff);
  return { root, home, dir };
}

function run(args, r, extra = {}) {
  const res = spawnSync(process.execPath, ['-r', path.join(ROOT, 'tests', 'helpers', 'no-network.js'), path.join(ROOT, 'scripts', 'select-model.js'), ...args], {
    cwd: r.root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home, ...extra }),
  });
  let out = null;
  try { out = JSON.parse(res.stdout); } catch { /* leave null */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out };
}

const readModels = (r) => fs.readFileSync(path.join(r.dir, 'models.json'), 'utf8').replace(/\r\n/g, '\n');

module.exports = { makeRun, run, readModels, RUN_ID, sha };
