'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ROUTER = ['scripts/lib/model-policy.js', 'scripts/select-model.js', 'scripts/lib/cursor-models.js', 'scripts/lib/cursor-state-reader.js', 'scripts/lib/model-mix.js'];

function hookEntries() {
  const out = new Set();
  for (const rel of ['hooks/hooks.json', 'hooks/cursor-hooks.json']) {
    for (const m of read(rel).matchAll(/scripts\/[\w/.-]+\.js/g)) out.add(m[0]);
  }
  return [...out];
}

function closure(entry) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of read(rel).matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      visit(target.endsWith('.js') ? target : `${target}.js`);
    }
  };
  visit(entry);
  return seen;
}

test('hook entry points exist and include every hook script', () => {
  const entries = hookEntries();
  for (const e of ['scripts/session-start.js', 'scripts/stop-gate.js', 'scripts/subagent-gate.js', 'scripts/validate-artifact.js', 'scripts/cursor/session-start.js', 'scripts/cursor/stop.js', 'scripts/cursor/subagent-stop.js', 'scripts/cursor/after-edit.js']) assert.ok(entries.includes(e), e);
});

for (const entry of hookEntries()) {
  test(`no hook reaches the model router: ${entry} (REQ-46)`, () => {
    const reach = closure(entry);
    for (const r of ROUTER) assert.ok(!reach.has(r), `${entry} requires ${r}`);
  });
}

test('claude-golden.json is byte-identical to 0.3.0 (REQ-47)', () => {
  const h = crypto.createHash('sha256').update(read('tests/fixtures/claude-golden.json').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(h, '2d16f7511fa8388ac95b4265a2768f9b4e8ffb8169f02abd221000f2455b6e6f');
});

test('package.json has no dependencies (REQ-48)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('no test reads an API key or token env var (REQ-49)', () => {
  const bad = /process\.env\.(ANTHROPIC_[A-Z_]*|OPENAI_[A-Z_]*|CURSOR_[A-Z_]*(KEY|TOKEN)[A-Z_]*|[A-Z_]*API_KEY)\b|process\.env\[['"][A-Z_]*(API_KEY|TOKEN)['"]\]/;
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walk(`${dir}/${e.name}`)) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
  for (const rel of walk('tests')) assert.doesNotMatch(read(rel), bad, rel);
});

test('no hook script reads user_email (REQ-44)', () => {
  for (const entry of hookEntries()) for (const rel of closure(entry)) assert.doesNotMatch(read(rel), /user_email/, rel);
});
