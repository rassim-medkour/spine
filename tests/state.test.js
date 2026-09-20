const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, findActiveRun, writeState, setActive } = require('../scripts/lib/state');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spine-'));
}

test('loadConfig returns defaults when no config files exist', () => {
  const cwd = tmp();
  const home = tmp();
  const cfg = loadConfig(cwd, home);
  assert.deepEqual(cfg, {
    strictness: 'block',
    artifacts_dir: '.spine',
    lens_budget: 6,
    second_model: false,
    render_artifacts: false,
    critical_paths: [],
  });
});

test('repo config overrides global config', () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify({ strictness: 'warn', lens_budget: 3 }));
  fs.mkdirSync(path.join(cwd, '.spine'));
  fs.writeFileSync(path.join(cwd, '.spine', 'config.json'), JSON.stringify({ strictness: 'block' }));
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.strictness, 'block');
  assert.equal(cfg.lens_budget, 3);
});

test('findActiveRun returns null when no active.json', () => {
  const cwd = tmp();
  assert.equal(findActiveRun(cwd, loadConfig(cwd, tmp())), null);
});

test('setActive then findActiveRun returns the run state', () => {
  const cwd = tmp();
  const cfg = loadConfig(cwd, tmp());
  const dir = path.join(cwd, '.spine', '20260920-demo');
  writeState(dir, { id: '20260920-demo', stage: 'review', status: 'active', awaiting: null, size: 'M', updated: '2026-09-20T10:00:00Z' });
  setActive(cwd, cfg, '20260920-demo');
  const run = findActiveRun(cwd, cfg);
  assert.equal(run.id, '20260920-demo');
  assert.equal(run.dir, dir);
  assert.equal(run.state.stage, 'review');
});

test('findActiveRun returns null when state.json is missing', () => {
  const cwd = tmp();
  const cfg = loadConfig(cwd, tmp());
  setActive(cwd, cfg, '20260920-ghost');
  assert.equal(findActiveRun(cwd, cfg), null);
});

test('findActiveRun returns null when active.id does not match the run id shape', () => {
  const cwd = tmp();
  const cfg = loadConfig(cwd, tmp());
  setActive(cwd, cfg, '../../etc');
  assert.equal(findActiveRun(cwd, cfg), null);
});
