const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeState, setActive, loadConfig } = require('../scripts/lib/state');
const { tmpDir } = require('./helpers/tmp');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'validate-artifact.js');

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
}

function repoWithRun() {
  const cwd = tmpDir('spine-');
  const home = tmpDir('spine-home-');
  const cfg = loadConfig(cwd, home);
  const dir = path.join(cwd, '.spine', '20260920-demo');
  writeState(dir, { id: '20260920-demo', stage: 'intent', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z' });
  setActive(cwd, cfg, '20260920-demo');
  return { cwd, home, dir };
}

test('exits 0 silently when no active run', () => {
  const cwd = tmpDir('spine-');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.md') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('reports problems for an invalid artifact inside the run dir', () => {
  const { cwd, home, dir } = repoWithRun();
  const file = path.join(dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\n---\n\n# no headings\n');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /intent\.md has \d+ problem/);
  assert.match(out.hookSpecificOutput.additionalContext, /missing heading "## Problem"/);
});

test('stays silent for a valid artifact', () => {
  const { cwd, home, dir } = repoWithRun();
  const file = path.join(dir, 'intent.md');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'artifacts', 'intent-valid.md'), file);
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('ignores files outside the run dir', () => {
  const { cwd, home } = repoWithRun();
  const file = path.join(cwd, 'README.md');
  fs.writeFileSync(file, 'hi');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Edit', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('fails open with a spine: message when config is malformed', () => {
  const cwd = tmpDir('spine-');
  const home = tmpDir('spine-home-');
  fs.mkdirSync(path.join(home, '.spine'));
  fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify({ artifacts_dir: 5 }));
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.md') } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^spine: validate-artifact error: /m);
});

const PRODUCT_HEADINGS = '## Users\n## Goals\n## Glossary\n## Invariants\n## Key flows\n## UX principles\n';

test('product.md with a missing heading warns with the heading name only and exits 0, with and without an active run', () => {
  const secret = 'SECRET-BODY-LINE-xyz';
  for (const withRun of [false, true]) {
    const { cwd, home } = withRun ? repoWithRun() : { cwd: tmpDir('spine-'), home: tmpDir('spine-home-') };
    fs.mkdirSync(path.join(cwd, '.spine'), { recursive: true });
    const file = path.join(cwd, '.spine', 'product.md');
    fs.writeFileSync(file, '## Users\n' + secret + '\n## Goals\n## Glossary\n## Key flows\n## UX principles\n');
    const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
    assert.equal(r.status, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /missing heading "## Invariants"/);
    assert.ok(!ctx.includes(secret), 'hook output must not echo the body');
  }
});

test('a valid product.md produces no output', () => {
  const cwd = tmpDir('spine-');
  fs.mkdirSync(path.join(cwd, '.spine'), { recursive: true });
  const file = path.join(cwd, '.spine', 'product.md');
  fs.writeFileSync(file, PRODUCT_HEADINGS);
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('T-2b: product.md defects use the parseProduct rule: a leading-space heading is missing, flow names are not echoed', () => {
  const cwd = tmpDir('spine-');
  fs.mkdirSync(path.join(cwd, '.spine'), { recursive: true });
  const file = path.join(cwd, '.spine', 'product.md');
  fs.writeFileSync(file, ' ## Users\n## Goals\n## Glossary\n## Invariants\n## Key flows\n### SecretFlowName\nweight: huge\npaths: a/**\n## UX principles\n');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /missing heading "## Users"/);
  assert.match(ctx, /line 6/);
  assert.ok(!ctx.includes('SecretFlowName'));
});

test('T-2b: non-UTF-8 product.md reports an error code and exits 0', () => {
  const cwd = tmpDir('spine-');
  fs.mkdirSync(path.join(cwd, '.spine'), { recursive: true });
  const file = path.join(cwd, '.spine', 'product.md');
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x41]));
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /not valid UTF-8/);
});

// T-15a
const hookCtx = (text) => {
  const cwd = tmpDir('spine-');
  fs.mkdirSync(path.join(cwd, '.spine'), { recursive: true });
  const file = path.join(cwd, '.spine', 'product.md');
  fs.writeFileSync(file, text);
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(r.status, 0);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
};
const FULL = (flows) => `## Users\n## Goals\n## Glossary\n## Invariants\n## Key flows\n${flows}## UX principles\n`;

test('T-15a: a heading defect says the file is treated as absent until fixed', () => {
  const ctx = hookCtx(FULL('').replace('## Goals\n', ''));
  assert.match(ctx, /missing heading "## Goals"/);
  assert.match(ctx, /treated as absent until fixed/);
});

test('T-15a: a dropped flow entry says the rest of the file still loads', () => {
  const ctx = hookCtx(FULL('### Pay\nweight: huge\npaths: a/**\n'));
  assert.match(ctx, /line 6: flow entry dropped; the rest of the file still loads/);
  assert.doesNotMatch(ctx, /treated as absent/);
  assert.ok(!ctx.includes('Pay'));
});

function runWithProductJson(pj, version = '0.4.0') {
  const { cwd, home, dir } = repoWithRun();
  writeState(dir, { id: '20260920-demo', stage: 'intent', status: 'active', awaiting: null, size: 'S', updated: '2026-09-20T10:00:00Z', ...(version ? { spine_version: version } : {}) });
  if (pj !== undefined) fs.writeFileSync(path.join(dir, 'product.json'), pj);
  const file = path.join(dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\nstage: intent\nupstream_id: x\nstatus: draft\n---\n\n# x\n');
  const r = runHook({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: file } }, { SPINE_HOME: home });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

test('T-15a: conditional headings follow product.json state, spine_version and a readable file', () => {
  assert.match(runWithProductJson(JSON.stringify({ state: 'ok' })), /missing heading "## Who this is for"/);
  assert.match(runWithProductJson(JSON.stringify({ state: 'trimmed' })), /missing heading "## Who this is for"/);
  for (const state of ['absent', 'malformed']) assert.doesNotMatch(runWithProductJson(JSON.stringify({ state })), /Who this is for/);
  assert.doesNotMatch(runWithProductJson(JSON.stringify({ state: 'ok' }), null), /Who this is for/);
  assert.doesNotMatch(runWithProductJson(JSON.stringify({ state: 'ok' }), '0.3.2'), /Who this is for/);
});

test('T-15a: a corrupt product.json warns with product.json unreadable', () => {
  const ctx = runWithProductJson('{nope');
  assert.match(ctx, /product\.json unreadable/);
  assert.doesNotMatch(ctx, /Who this is for/);
});
