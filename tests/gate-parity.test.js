// tests/gate-parity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE, FIX, ROOT, cursorRepo, fixture, runCursor, passRecord } = require('./helpers/cursor-repo');
const { cleanEnv } = require('./helpers/claude-cases');
const { loadConfig, findActiveRun } = require('../scripts/lib/state');
const { collectIssues, collectErrors, stopReason } = require('../scripts/lib/gate');
const { buildStopFollowup } = require('../scripts/lib/safe-text');

const SCENARIOS = {
  'missing artifact': [{ ...BASE, stage: 'intent' }, () => {}, {}],
  'invalid artifact': [{ ...BASE, stage: 'intent' }, (d) => fs.writeFileSync(path.join(d, 'intent.md'), '---\nid: x\n---\n'), {}],
  'boundary missing': [{ ...BASE, stage: 'intent' }, (d) => fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(d, 'intent.md')), {}],
  'gate-clean': [{ ...BASE, stage: 'intent' }, (d) => { fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), path.join(d, 'intent.md')); passRecord(d, 'intent'); }, {}],
  'warn strictness': [{ ...BASE, stage: 'intent' }, () => {}, { strictness: 'warn' }],
  'awaiting G2': [{ ...BASE, stage: 'plan', awaiting: 'G2' }, () => {}, {}],
};

function claudeVerdict(r) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'stop-gate.js')], { input: JSON.stringify({ cwd: r.root, stop_hook_active: false }), encoding: 'utf8', env: cleanEnv({ SPINE_HOME: r.home }) });
  if (res.status === 2) return { verdict: 'block', text: res.stderr };
  return { verdict: res.stdout ? 'warn' : 'allow', text: res.stdout };
}

function cursorVerdict(r) {
  const res = runCursor('stop.js', { ...fixture('stop.json'), workspace_roots: [r.root] }, { SPINE_HOME: r.home });
  const out = res.stdout.trim() ? JSON.parse(res.stdout) : {};
  if (out.followup_message) return { verdict: 'block', text: out.followup_message };
  return { verdict: res.stderr.includes('not gate-clean') ? 'warn' : 'allow', text: res.stderr };
}

for (const [name, [state, prep, cfg]] of Object.entries(SCENARIOS)) {
  test(`Claude and Cursor stop adapters agree: ${name}`, () => {
    const a = cursorRepo(state, cfg);
    const b = cursorRepo(state, cfg);
    prep(a.dir);
    prep(b.dir);
    const run = findActiveRun(a.root, loadConfig(a.root, a.home));
    const claude = claudeVerdict(a);
    const cursor = cursorVerdict(b);
    assert.equal(cursor.verdict, claude.verdict);
    if (claude.verdict === 'block') {
      assert.equal(claude.text, `spine: ${stopReason(run, collectErrors(run))}\n`);
      assert.equal(cursor.text, buildStopFollowup(run, collectIssues(run)));
    }
  });
}

test('the Claude entry points hold no gate logic of their own', () => {
  const stopSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'stop-gate.js'), 'utf8');
  const subSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'subagent-gate.js'), 'utf8');
  assert.match(stopSrc, /require\('\.\/lib\/gate'\)/);
  assert.match(subSrc, /require\('\.\/lib\/gate'\)/);
  assert.doesNotMatch(stopSrc, /function collectErrors|STAGE_ARTIFACTS\s*=/);
  assert.doesNotMatch(subSrc, /function extractRecordBlock/);
  for (const f of ['stop.js', 'subagent-stop.js']) {
    const p = path.join(ROOT, 'scripts', 'cursor', f);
    if (fs.existsSync(p)) assert.match(fs.readFileSync(p, 'utf8'), /require\('\.\.\/lib\/gate'\)/);
  }
});
