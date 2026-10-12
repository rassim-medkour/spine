'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE, ROOT, tmp, cursorRepo, fixture, runCursor, passRecord } = require('./helpers/cursor-repo');
const { cleanEnv } = require('./helpers/claude-cases');

const CANARY = { CURSOR_API_KEY: 'canary-cursor-7f3a9c', ANTHROPIC_API_KEY: 'canary-anthropic-2b8d1e' };
const ADAPTERS = { 'stop.js': 'stop.json', 'subagent-stop.js': 'subagent-stop.json', 'after-edit.js': 'post-tool-use.json', 'session-start.js': 'session-start.json' };

function filesUnder(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('no spine output or run file ever contains an API key value', () => {
  const outputs = [];
  const dirs = [];
  for (const cfg of [{}, { strictness: 'warn' }]) {
    for (const [script, fx] of Object.entries(ADAPTERS)) {
      const r = cursorRepo({ ...BASE, stage: 'intent' }, cfg);
      dirs.push(r.dir);
      for (let i = 0; i < 5; i++) {
        const res = runCursor(script, { ...fixture(fx), workspace_roots: [r.root], tool_input: { file_path: path.join(r.dir, 'intent.md') } }, { SPINE_HOME: r.home, ...CANARY });
        outputs.push(res.stdout, res.stderr);
      }
    }
  }
  for (const script of ['stop-gate.js', 'subagent-gate.js', 'session-start.js', 'validate-artifact.js']) {
    const r = cursorRepo({ ...BASE, stage: 'intent' });
    dirs.push(r.dir);
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { input: JSON.stringify({ cwd: r.root }), encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home, ...CANARY }) });
    outputs.push(res.stdout, res.stderr);
  }
  const r = cursorRepo({ ...BASE, stage: 'intent', host: 'cursor' });
  passRecord(r.dir, 'intent');
  for (const [script, args] of [['run-status.js', [r.dir]], ['check-cross-author.js', [r.dir]], ['da-gate.js', [r.dir, '--devils-advocate', 'true']]]) {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', env: cleanEnv(CANARY) });
    outputs.push(res.stdout, res.stderr);
  }
  const all = outputs.join('\n') + dirs.flatMap(filesUnder).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const value of Object.values(CANARY)) assert.ok(!all.includes(value), `leaked ${value}`);
});

test('no SDK, no API key reads and no network modules in plugin code', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  const NET = /require\(['"](node:)?(http|https|http2|net|tls|dns|dgram)['"]\)|@cursor\/sdk|CURSOR_API_KEY|ANTHROPIC_API_KEY/;
  const code = [...filesUnder(path.join(ROOT, 'scripts')), ...filesUnder(path.join(ROOT, 'hooks')), ...filesUnder(path.join(ROOT, '.cursor-plugin'))];
  for (const f of code) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), NET, path.relative(ROOT, f));
});

function assertFailOpen(res, label) {
  assert.equal(res.status, 0, label);
  const out = res.stdout.trim();
  if (!out) return;
  const parsed = JSON.parse(out);
  assert.equal(parsed.followup_message, undefined, label);
  assert.equal(parsed.permission, undefined, label);
}

for (const [script, fx] of Object.entries(ADAPTERS)) {
  test(`${script} fails open on empty, non-JSON and oversized stdin with one stderr line`, () => {
    for (const [name, input] of [['empty', ''], ['non-json', 'nope'], ['oversized', '{"x":"' + 'a'.repeat(1024 * 1024) + '"}']]) {
      const res = runCursor(script, input);
      assertFailOpen(res, `${script} ${name}`);
      assert.equal(res.stderr.trim().split('\n').length, 1, `${script} ${name}: ${res.stderr}`);
    }
  });
  test(`${script} fails open when the workspace root is a file, missing, has no .spine, or config throws`, () => {
    const file = path.join(tmp('spine-f-'), 'file');
    fs.writeFileSync(file, 'x');
    assertFailOpen(runCursor(script, { ...fixture(fx), workspace_roots: [file] }), 'root is file');
    assertFailOpen(runCursor(script, { ...fixture(fx), workspace_roots: [path.join(tmp('spine-m-'), 'gone')] }), 'missing root');
    assertFailOpen(runCursor(script, { ...fixture(fx), workspace_roots: [tmp('spine-e-')] }), 'no .spine');
    const home = tmp('spine-bad-');
    fs.mkdirSync(path.join(home, '.spine'));
    fs.writeFileSync(path.join(home, '.spine', 'config.json'), JSON.stringify({ artifacts_dir: 5 }));
    const res = runCursor(script, { ...fixture(fx), workspace_roots: [tmp('spine-t-')] }, { SPINE_HOME: home });
    assertFailOpen(res, 'config throws');
    assert.match(res.stderr, /^spine: cursor \w+ error: /m);
  });
}
