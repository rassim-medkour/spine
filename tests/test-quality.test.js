'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findHollowTests } = require('../scripts/lib/test-quality');
const { validateRecord } = require('../scripts/lib/validate');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'test-quality', name), 'utf8');

test('JS and TS (node:test, jest, vitest style): every hollow pattern', () => {
  assert.deepEqual(findHollowTests('src/util.test.js', fx('hollow-js.txt')), [
    { line: 4, rule: 'mocks-unit-under-test' },
    { line: 7, rule: 'no-assertion' },
    { line: 11, rule: 'trivial-assertion' },
    { line: 15, rule: 'trivial-assertion' },
    { line: 20, rule: 'skip-only' },
    { line: 24, rule: 'skip-only' },
  ]);
});

test('Python: pass-only, constant, skip, no assert, mocking the unit', () => {
  assert.deepEqual(findHollowTests('tests/test_util.py', fx('hollow-py.txt')), [
    { line: 6, rule: 'pass-only' },
    { line: 10, rule: 'trivial-assertion' },
    { line: 15, rule: 'skip-only' },
    { line: 19, rule: 'no-assertion' },
    { line: 23, rule: 'mocks-unit-under-test' },
  ]);
});

test('Go: tests and subtests with no failure path, skip-only', () => {
  assert.deepEqual(findHollowTests('store/store_test.go', fx('hollow-go.txt')), [
    { line: 5, rule: 'no-failure-path' },
    { line: 15, rule: 'no-failure-path' },
    { line: 20, rule: 'skip-only' },
  ]);
});

test('zero flags on real tests: snapshots, properties, custom helpers, testify', () => {
  assert.deepEqual(findHollowTests('src/math.test.js', fx('real-js.txt')), []);
  assert.deepEqual(findHollowTests('tests/test_math.py', fx('real-py.txt')), []);
  assert.deepEqual(findHollowTests('store/get_test.go', fx('real-go.txt')), []);
});

test('only changed lines are flagged', () => {
  assert.deepEqual(findHollowTests('src/util.test.js', fx('hollow-js.txt'), new Set([11, 12])), [{ line: 11, rule: 'trivial-assertion' }]);
});

test('never throws on null, binary or unbalanced input', () => {
  assert.deepEqual(findHollowTests('a.test.js', null), []);
  assert.doesNotThrow(() => findHollowTests('a.test.js', "test('x', () => { assert.ok(1"));
  assert.doesNotThrow(() => findHollowTests('a_test.go', 'func TestX(t *testing.T) {'));
  assert.deepEqual(findHollowTests('README.md', 'test("x", () => {})'), []);
});

test('CLI prints a proof record plus one MEDIUM record per flag, all valid records', () => {
  const root = tmpDir('spine-tq-');
  const runDir = path.join(root, '.spine', '20261015-tq');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'util.test.js'), fx('hollow-js.txt'));
  const lines = fx('hollow-js.txt').split('\n').filter((l, i, a) => i < a.length - 1 || l);
  fs.writeFileSync(path.join(runDir, 'diff.patch'), ['diff --git a/src/util.test.js b/src/util.test.js', 'new file mode 100644', '--- /dev/null', '+++ b/src/util.test.js', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n');
  const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
  fs.writeFileSync(path.join(runDir, 'tree.json'), JSON.stringify(tree));
  const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-quality.js'), '--run', runDir], { cwd: root, encoding: 'utf8', env: cleanEnv() });
  assert.equal(out.status, 0, out.stderr);
  const records = JSON.parse(out.stdout);
  assert.equal(records[0].proof_kind, 'test_quality');
  assert.equal(records[0].revision, `${tree.inputs.head_sha}:${tree.inputs.diff_sha256}`);
  assert.equal(records.length, 7);
  assert.ok(records.slice(1).every((r) => r.severity === 'MEDIUM' && /^src\/util\.test\.js:\d+$/.test(r.evidence[0].ref)));
  for (const r of records) assert.deepEqual(validateRecord({ ...r, id: 'R-0000' }), []);
});

test('test calls inside a template literal are strings, not tests', () => {
  const src = "const code = `\ntest('x', () => { run(); });\n`;\n";
  assert.deepEqual(findHollowTests('src/gen.test.js', src), []);
});
