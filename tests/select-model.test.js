'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeRun, run, readModels } = require('./helpers/model-run');
const { ROOT } = require('./helpers/claude-cases');
const mp = require('../scripts/lib/model-policy');

const ENTRY_KEYS = ['role', 'tier', 'tier_source', 'class', 'model', 'host', 'source', 'reason', 'policy_source'];

test('S, M and L with no tree map to leaf, branch, trunk with tier_source size (REQ-7)', (t) => {
  for (const [size, tier] of [['S', 'leaf'], ['M', 'branch'], ['L', 'trunk']]) {
    const r = makeRun(t, { size });
    const { status, out } = run(['--run', r.dir, '--stage', 'review'], r);
    assert.equal(status, 0);
    assert.equal(out.tier, mp.SIZE_TIER[size]);
    assert.equal(out.tier, tier);
    assert.equal(out.tier_source, 'size');
    assert.equal(out.tier_reason, 'no tree.json');
  }
});

test('--size overrides the class.json size', (t) => {
  const r = makeRun(t, { size: 'S' });
  assert.equal(run(['--run', r.dir, '--stage', 'review', '--size', 'L'], r).out.tier, 'trunk');
});

test('tree.json tier wins even when it contradicts the file signals (REQ-6)', (t) => {
  const r = makeRun(t, { size: 'S', tree: true });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.tier, 'trunk');
  assert.equal(out.tier_source, 'tree');
  assert.equal(out.tier_reason, 'tree.json');
});

test('stale tree falls back to size (REQ-8, owner decision)', (t) => {
  const r = makeRun(t, { size: 'M', tree: true, treeDiff: 'old', diff: 'new' });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.tier, 'branch');
  assert.equal(out.tier_source, 'size');
  assert.equal(out.tier_reason, 'tree.json stale: diff changed');
});

test('a tree whose diff still matches is used', (t) => {
  const r = makeRun(t, { size: 'M', tree: true, treeDiff: 'same', diff: 'same' });
  assert.equal(run(['--run', r.dir, '--stage', 'review'], r).out.tier_source, 'tree');
});

test('tampered tree falls back to size and cannot lower the verifier (REQ-8)', (t) => {
  const r = makeRun(t, { size: 'L', tree: (tr) => ({ ...tr, tier: 'leaf' }) });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.tier, 'trunk');
  assert.equal(out.tier_source, 'size');
  assert.equal(out.tier_reason, 'tree.json invalid');
  assert.equal(out.roles.verifier.class, 'top');
});

test('tree with a different tier config hash is stale', (t) => {
  const r = makeRun(t, { size: 'M', tree: (tr) => ({ ...tr, inputs: { ...tr.inputs, config_sha256: '0'.repeat(64) } }) });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.tier_source, 'size');
  assert.equal(out.tier_reason, 'tree.json stale: tier config changed');
});

test('mixed leaf and trunk files give the trunk model to every implement ticket (REQ-9)', (t) => {
  const r = makeRun(t, { size: 'S', tree: true });
  const { out } = run(['--run', r.dir, '--stage', 'implement'], r);
  assert.equal(out.roles.implementer.tier, 'trunk');
  assert.equal(out.roles.finder.tier, 'trunk');
});

test('stage plan lists every role with the frozen keys in order (REQ-5)', (t) => {
  const r = makeRun(t, { size: 'L' });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.deepEqual(Object.keys(out.roles), [...mp.ROLES]);
  for (const role of mp.ROLES) assert.deepEqual(Object.keys(out.roles[role]), ENTRY_KEYS);
});

test('balanced trunk plan for claude-code', (t) => {
  const r = makeRun(t, { size: 'L' });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.ok, true);
  assert.equal(out.host, 'claude-code');
  assert.deepEqual(Object.fromEntries(mp.ROLES.map((x) => [x, out.roles[x].model])), {
    implementer: 'sonnet', finder: 'opus', verifier: 'opus', devils_advocate: 'opus', spec_lens: 'opus', synthesis: 'sonnet', boundary_checker: 'sonnet',
  });
  assert.ok(mp.ROLES.every((x) => out.roles[x].source === 'requested'));
  assert.equal(out.workflow_args.roles.finder.model, 'opus');
  assert.deepEqual(out.workflow_args.class_ids, { cheap: 'haiku', mid: 'sonnet', top: 'opus' });
  assert.equal(out.workflow_args.kill_switch, false);
  assert.equal(out.discovery, undefined);
});

test('two runs give byte-identical stdout and models.json (REQ-4)', (t) => {
  const a = makeRun(t, { size: 'L' });
  const b = makeRun(t, { size: 'L' });
  const ra = run(['--run', a.dir, '--stage', 'review'], a);
  const rb = run(['--run', b.dir, '--stage', 'review'], b);
  assert.equal(ra.stdout.replace(/\r\n/g, '\n'), rb.stdout.replace(/\r\n/g, '\n'));
  assert.equal(readModels(a), readModels(b));
  assert.equal(run(['--run', a.dir, '--stage', 'review'], a).stdout, ra.stdout);
});

test('no network is used (REQ-4)', (t) => {
  const r = makeRun(t, { size: 'L' });
  assert.equal(run(['--run', r.dir, '--stage', 'review'], r).status, 0);
  const control = spawnSync(process.execPath, ['-r', path.join(ROOT, 'tests', 'helpers', 'no-network.js'), '-e', "require('node:https').get('x')"], { encoding: 'utf8' });
  assert.notEqual(control.status, 0);
});

test('models.json is written once per stage and reused on resume (REQ-11)', (t) => {
  const r = makeRun(t, { size: 'L' });
  const first = run(['--run', r.dir, '--stage', 'implement'], r);
  fs.mkdirSync(path.join(r.root, '.spine'), { recursive: true });
  fs.writeFileSync(path.join(r.root, '.spine', 'config.json'), JSON.stringify({ model_policy: 'inherit' }));
  const again = run(['--run', r.dir, '--stage', 'implement'], r);
  assert.deepEqual(again.out.roles, first.out.roles);
  assert.equal(again.out.roles.finder.model, 'opus');
  const other = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(other.out.roles.finder.model, null);
  assert.equal(other.out.roles.finder.source, 'inherit');
  const file = JSON.parse(readModels(r));
  assert.equal(file.schema_version, 1);
  assert.deepEqual(Object.keys(file.stages).sort(), ['implement', 'review']);
});

test('corrupt models.json is recomputed', (t) => {
  const r = makeRun(t, { size: 'L' });
  fs.writeFileSync(path.join(r.dir, 'models.json'), '{ nope');
  const a = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(a.status, 0);
  assert.equal(a.out.roles.finder.model, 'opus');
  assert.equal(JSON.parse(readModels(r)).schema_version, 1);
  const file = JSON.parse(readModels(r));
  file.stages.review.roles.finder.model = 'a b';
  fs.writeFileSync(path.join(r.dir, 'models.json'), JSON.stringify(file));
  const b = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(b.out.roles.finder.model, 'opus');
  assert.equal(JSON.parse(readModels(r)).stages.review.roles.finder.model, 'opus');
});

test('kill switch: every role is class inherit, model null, source inherit (REQ-22)', (t) => {
  const r = makeRun(t, { size: 'L', config: { model_policy: 'inherit' } });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  for (const role of mp.ROLES) assert.deepEqual({ c: out.roles[role].class, m: out.roles[role].model, s: out.roles[role].source }, { c: 'inherit', m: null, s: 'inherit' });
  assert.equal(out.workflow_args.kill_switch, true);
  assert.ok(Object.values(out.workflow_args.roles).every((x) => x.model === null));
  assert.equal(JSON.parse(readModels(r)).policy.kind, 'inherit');
});

test('repo policy merges over global cell by cell and names policy_source (REQ-16)', (t) => {
  const r = makeRun(t, { size: 'L', config: { model_policy: { synthesis: { trunk: 'top' } } }, repoConfig: { model_policy: { implementer: { trunk: 'top' } } } });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.roles.synthesis.policy_source, 'global');
  assert.equal(out.roles.implementer.policy_source, 'repo');
  assert.equal(out.roles.finder.policy_source, 'default');
  assert.equal(out.roles.synthesis.model, 'opus');
  assert.equal(out.policy.source, 'global+repo');
});

test('invalid policy: exit 0, one stderr line per bad key, policy.invalid true, Balanced used (REQ-17, REQ-12)', (t) => {
  const r = makeRun(t, { size: 'L', repoConfig: { model_policy: { verifier: { leaf: 'huge' }, bogus: {} } } });
  const { status, stderr, out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(status, 0);
  const lines = stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith('spine: model_policy')));
  const file = JSON.parse(readModels(r));
  assert.equal(file.policy.invalid, true);
  assert.equal(file.policy.errors.length, 2);
  assert.equal(out.roles.finder.model, 'opus');
  assert.equal(out.roles.synthesis.model, 'sonnet');
});

test('malformed config JSON is an invalid policy, not a crash', (t) => {
  const r = makeRun(t, { size: 'L', repoConfig: '{ nope' });
  const { status, out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(status, 0);
  assert.equal(out.roles.finder.model, 'opus');
});

test('class id override flows through unchanged (REQ-13)', (t) => {
  const r = makeRun(t, { size: 'L', config: { model_ids: { 'claude-code': { top: 'claude-opus-4-8' } } } });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.roles.finder.model, 'claude-opus-4-8');
  assert.equal(out.workflow_args.class_ids.top, 'claude-opus-4-8');
  assert.equal(out.workflow_args.class_ids.mid, 'sonnet');
});

test('an invalid model id is dropped with one stderr line and the default kept (REQ-18)', (t) => {
  const r = makeRun(t, { size: 'L', config: { model_ids: { 'claude-code': { top: 'bad id' } } } });
  const { out, stderr } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.roles.finder.model, 'opus');
  assert.match(stderr, /^spine: model_ids\.claude-code\.top: /);
  assert.ok(!stderr.includes('bad id'));
});

test('a policy that makes the trunk verifier cheaper than the finder is raised and recorded (REQ-27)', (t) => {
  const r = makeRun(t, { size: 'L', config: { model_policy: { verifier: { trunk: 'cheap' }, devils_advocate: { trunk: 'cheap' } } } });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  for (const role of ['verifier', 'devils_advocate']) {
    assert.deepEqual({ c: out.roles[role].class, m: out.roles[role].model, s: out.roles[role].source, r: out.roles[role].reason },
      { c: 'top', m: 'opus', s: 'floor-raised', r: 'policy_clamped: raised from cheap to top (finder class)' });
  }
});

test('no floor below trunk', (t) => {
  const r = makeRun(t, { size: 'M', config: { model_policy: { verifier: { branch: 'cheap' }, finder: { branch: 'top' } } } });
  const { out } = run(['--run', r.dir, '--stage', 'review'], r);
  assert.equal(out.roles.verifier.model, 'haiku');
  assert.equal(out.roles.verifier.source, 'requested');
});

test('query mode prints one role entry without a run (REQ-5)', (t) => {
  const r = makeRun(t, { size: 'L' });
  const { status, out } = run(['--tier', 'L', '--role', 'verifier'], r);
  assert.equal(status, 0);
  assert.equal(out.ok, true);
  assert.deepEqual({ role: out.role, tier: out.tier, tier_source: out.tier_source, class: out.class, model: out.model }, { role: 'verifier', tier: 'trunk', tier_source: 'size', class: 'top', model: 'opus' });
  assert.equal(run(['--tier', 'leaf', '--role', 'synthesis'], r).out.tier_source, null);
  assert.equal(run(['--tier', 'leaf', '--role', 'synthesis'], r).out.model, 'haiku');
  assert.equal(fs.existsSync(path.join(r.dir, 'models.json')), false);
});

const BAD_FLAGS = [['--role', 'reviewer'], ['--tier', 'core'], ['--stage', 'deploy'], ['--host', 'vscode'], ['--size', 'XL'], ['--bogus', 'x'], ['--role']];
for (const argv of BAD_FLAGS) {
  test(`bad flag ${argv.join(' ')} exits 2 naming the flag (REQ-20)`, (t) => {
    const r = makeRun(t, { size: 'L' });
    const res = run(['--run', r.dir, '--stage', 'review', ...argv], r);
    assert.equal(res.status, 2);
    assert.deepEqual(res.out, { ok: false, error: `bad flag ${argv[0]}` });
    assert.equal(res.stderr.trim().split(/\r?\n/).length, 1);
    assert.ok(res.stderr.includes(argv[0]));
  });
}

test('missing mode flags exit 2', (t) => {
  const r = makeRun(t, { size: 'L' });
  assert.equal(run([], r).status, 2);
  assert.equal(run(['--tier', 'L'], r).status, 2);
});

test('a missing run directory is an internal error with JSON on stdout (exit 1)', (t) => {
  const r = makeRun(t, { size: 'L' });
  const res = run(['--run', path.join(r.root, 'nope'), '--stage', 'review'], r);
  assert.equal(res.status, 1);
  assert.equal(res.out.ok, false);
});

test('the CLI never reads env secrets (REQ-21)', () => {
  for (const rel of ['scripts/select-model.js', 'scripts/lib/model-policy.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Za-z_]+)/g)) assert.ok(['SPINE_HOME', 'SPINE_CURSOR_HOME'].includes(m[1]), `${rel}: ${m[1]}`);
    assert.doesNotMatch(text, /process\.env\[/);
  }
});

test('limitations list the host-independent ids for claude-code', (t) => {
  const r = makeRun(t, { size: 'L' });
  assert.deepEqual(run(['--run', r.dir, '--stage', 'review'], r).out.limitations.map((l) => l.id), ['not-routed', 'inline-skill']);
});
