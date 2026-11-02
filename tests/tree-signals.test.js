'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { detectSignals, detectGating, SIGNAL_KEYS, SECURITY_RE } = require('../scripts/lib/tiers');

const BASE = {
  parser: 'typescript', text: '', hunks: [],
  fanIn: { value: 0, resolved: true, rule: 'direct importers (typescript)' },
  tested: { value: true, rule: 'imported by test' },
  churn: { value: 0, rule: 'commits in 90 days' },
  declaredEntry: false, flagNames: [],
};
const s = (o) => detectSignals({ ...BASE, ...o });
const hunk = (...added) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: added.length, added: added.map((text, i) => ({ line: i + 1, text })), removed: [] });

test('the signals object always has the nine keys in a fixed order', () => {
  assert.deepEqual(Object.keys(s({ path: 'src/a.ts' })), SIGNAL_KEYS);
  assert.deepEqual(SIGNAL_KEYS, ['fan_in', 'entry_point', 'shared_state', 'public_interface', 'one_way_door', 'security_path', 'churn', 'tested', 'gated']);
  const fi = s({ path: 'src/a.ts' }).fan_in;
  assert.deepEqual(Object.keys(fi), ['value', 'resolved', 'rule']);
});

test('entry point rules', () => {
  assert.equal(s({ path: 'cmd/tool/main.go' }).entry_point.value, true);
  assert.equal(s({ path: 'src/index.ts' }).entry_point.value, true);
  assert.equal(s({ path: 'src/deep/nested/index.ts' }).entry_point.value, false);
  assert.equal(s({ path: 'pkg/run.py', parser: 'python', text: "if __name__ == '__main__':\n    main()\n" }).entry_point.value, true);
  assert.equal(s({ path: 'tools/x.go', parser: 'go', text: 'package main\n' }).entry_point.value, true);
  assert.equal(s({ path: 'lib/x.js', parser: 'javascript', declaredEntry: true }).entry_point.rule, 'declared entry (package.json main/bin/exports)');
  assert.equal(s({ path: 'src/main.test.ts' }).entry_point.value, false);
  assert.equal(s({ path: 'bin/run.js', parser: 'javascript', text: ['#!/usr/bin/env node', 'require.main === module;'].join(String.fromCharCode(10)) }).entry_point.value, false);
});

test('shared state, config or schema and security paths', () => {
  assert.equal(s({ path: 'scripts/lib/state.js' }).shared_state.value, true);
  assert.equal(s({ path: 'src/config.ts' }).shared_state.value, true);
  assert.equal(s({ path: 'schemas/tree.json', parser: 'none' }).shared_state.value, true);
  assert.equal(s({ path: 'src/stateful.ts' }).shared_state.value, false);
  assert.equal(s({ path: 'src/auth/login.ts' }).security_path.value, true);
  assert.equal(s({ path: 'src/view.ts' }).security_path.value, false);
});

test('SECURITY_RE is the same pattern as scripts/classify.js', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'classify.js'), 'utf8');
  assert.equal(/const SECURITY_RE = (\/.*\/i);/.exec(text)[1], String(SECURITY_RE));
});

test('one-way door: migrations, contracts and data deletion in executed SQL', () => {
  assert.equal(s({ path: 'db/migrations/0004_x.py', parser: 'python' }).one_way_door.rule, 'migration path');
  assert.equal(s({ path: 'alembic/versions/a1_drop.py', parser: 'python', text: 'def upgrade():\n    op.drop_table("t")\n\ndef downgrade():\n    pass\n' }).one_way_door.rule, 'migration with empty down step');
  assert.equal(s({ path: 'api/schema.graphql', parser: 'none' }).one_way_door.rule, 'external contract file');
  const del = s({ path: 'src/repo.ts', hunks: [hunk("await db.execute('DROP TABLE users');")] }).one_way_door;
  assert.deepEqual(del, { value: true, rule: 'data deletion: DROP TABLE/COLUMN' });
  assert.ok(!del.rule.includes('users'), 'rules never quote diff text');
  assert.equal(s({ path: 'src/rules.ts', hunks: [hunk('const DROP = /\\bDROP\\s+TABLE\\b/;')] }).one_way_door.value, false);
  assert.equal(s({ path: 'src/q.ts', hunks: [hunk("db.query('DELETE FROM sessions WHERE id = 1');")] }).one_way_door.value, false);
  assert.equal(s({ path: 'src/q.ts', hunks: [hunk("db.query('DELETE FROM sessions');")] }).one_way_door.rule, 'data deletion: DELETE without WHERE');
  assert.equal(s({ path: 'docs/ops.md', parser: 'none', hunks: [hunk('DROP TABLE users;')] }).one_way_door.value, false);
});

test('public interface: paths and exported declarations per language', () => {
  assert.equal(s({ path: 'src/api/routes.ts' }).public_interface.value, true);
  assert.equal(s({ path: 'src/x.ts', hunks: [hunk('export function f() {}')] }).public_interface.value, true);
  assert.equal(s({ path: 'src/x.ts', hunks: [hunk('function g() {}')] }).public_interface.value, false);
  assert.equal(s({ path: 'pkg/y.go', parser: 'go', hunks: [hunk('func Exported() {}')] }).public_interface.value, true);
  assert.equal(s({ path: 'internal/y/y.go', parser: 'go', hunks: [hunk('func Exported() {}')] }).public_interface.value, false);
  assert.equal(s({ path: 'pkg/m.py', parser: 'python', hunks: [hunk('def _private():')] }).public_interface.value, false);
  assert.equal(s({ path: 'pkg/m.py', parser: 'python', hunks: [hunk('def public():')] }).public_interface.value, true);
});

test('flag gating is conservative', () => {
  assert.equal(detectGating([hunk("if (isEnabled('new-checkout')) {", '  run();')], []).value, true);
  assert.equal(detectGating([hunk('// isEnabled is how we gate this', 'run();')], []).value, false);
  assert.equal(detectGating([hunk("log('new_checkout');")], ['new_checkout']).value, false);
  assert.equal(detectGating([hunk("if (client.variation('new_checkout')) {")], ['new_checkout']).value, true);
  assert.equal(detectGating([hunk("if (client.variation('new_checkout')) {")], []).value, false);
  assert.equal(detectGating([hunk('if (FEATURE_NEW_UI) {'), hunk('run();')], []).value, false, 'every hunk must be gated');
  assert.deepEqual(detectGating([], []), { value: false, rule: 'not detected: no diff' });
  assert.equal(detectGating([hunk('if (flags.newUi) {', 'const x = a?.b;')], []).value, true);
  assert.equal(detectGating([hunk('const x = a?.b;', 'if (flags.newUi) {')], []).value, false, 'gate must precede the other added lines');
  assert.equal(detectGating([hunk('const y = cfg?.flags;')], []).value, false);
});

test('churn, tested and fan_in pass through unchanged', () => {
  const out = s({ path: 'src/a.ts', churn: { value: null, rule: 'churn unknown: shallow clone' }, fanIn: { value: null, resolved: false, rule: 'fan-in unknown: binary file' } });
  assert.deepEqual(out.churn, { value: null, rule: 'churn unknown: shallow clone' });
  assert.deepEqual(out.fan_in, { value: null, resolved: false, rule: 'fan-in unknown: binary file' });
});

test('flags.push is not a feature flag; added files are never gated by their own content', () => {
  assert.equal(detectGating([hunk('const flags = [];', 'flags.push(x);', 'if (a && b) {')], []).value, false);
  assert.equal(detectGating([hunk('flags.newUi && render();')], []).value, false, 'bare flags.x outside an if-condition');
  const added = s({ path: 'scripts/lib/test-quality.js', parser: 'javascript', status: 'added', hunks: [hunk("if (isEnabled('x')) {", '  flags.push(1);')] });
  assert.equal(added.gated.value, false);
  const modified = s({ path: 'scripts/lib/test-quality.js', parser: 'javascript', status: 'modified', hunks: [hunk("if (isEnabled('x')) {", '  flags.push(1);')] });
  assert.equal(modified.gated.value, true);
});

test('an added file with exports is public only by path or with an importer outside its directory', () => {
  const h = [hunk('export function helper() {}')];
  const base = { path: 'src/lib/helper.ts', hunks: h, status: 'added' };
  assert.equal(s({ ...base, importers: [] }).public_interface.value, false);
  assert.equal(s({ ...base, importers: ['src/lib/other.ts'] }).public_interface.value, false);
  assert.equal(s({ ...base, importers: ['src/app/page.ts'] }).public_interface.value, true);
  assert.equal(s({ ...base, path: 'src/api/helper.ts', importers: [] }).public_interface.value, true);
  assert.equal(s({ ...base, status: 'modified', importers: [] }).public_interface.value, true);
});

// Same pattern as classify.js (kept identical to master for REQ-2). Over-matching "author" is accepted:
// a false security signal only adds review depth, while missing "authorization" would remove it.
test('security path matches every auth* path, including authorization, authorize and authority', () => {
  for (const p of ['src/auth/login.ts', 'src/oauth.ts', 'src/authz.js', 'src/AuthService.ts', 'src/password.ts',
    'src/authorization/policy.js', 'src/authorize.ts', 'src/authority.go']) assert.equal(s({ path: p }).security_path.value, true, p);
  assert.equal(s({ path: 'src/widgets/button.ts' }).security_path.value, false);
});

// ---- T-3: product signals ----
const { PRODUCT_SIGNAL_KEYS, keyFlowFloor } = require('../scripts/lib/tiers');
const { matchFlows, userFacing, productSignals } = require('../scripts/lib/product-context');

const flow = (name, weight, paths, line = 1) => ({ name, weight, paths, steps: [], line });

test('PRODUCT_SIGNAL_KEYS is separate from the nine SIGNAL_KEYS', () => {
  assert.deepEqual(PRODUCT_SIGNAL_KEYS, ['user_facing', 'key_flow']);
  assert.equal(SIGNAL_KEYS.length, 9);
  assert.ok(!SIGNAL_KEYS.includes('user_facing'));
});

test('matchFlows matches prefix glob, star glob and no match on slash and backslash paths', () => {
  const flows = [flow('Checkout', 'critical', ['src/checkout/**']), flow('Pay', 'important', ['src/pay*.js'])];
  const { byFile } = matchFlows(flows, ['src/checkout/cart.js', 'src\\checkout\\deep\\x.js', 'src/pay2.js', 'src/other.js']);
  assert.deepEqual(byFile.get('src/checkout/cart.js'), [{ name: 'Checkout', weight: 'critical' }]);
  assert.deepEqual(byFile.get('src/checkout/deep/x.js'), [{ name: 'Checkout', weight: 'critical' }]);
  assert.deepEqual(byFile.get('src/pay2.js'), [{ name: 'Pay', weight: 'important' }]);
  assert.equal(byFile.has('src/other.js'), false);
});

test('a bad glob is skipped with an issue, never thrown', () => {
  const bad = { toString() { throw new Error('boom'); } };
  const flows = [flow('Odd', 'minor', [bad, 'src/ok/**'], 7)];
  const out = matchFlows(flows, ['src/ok/a.js']);
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].flow, 'Odd');
  assert.equal(out.issues[0].line, 7);
  assert.deepEqual(out.byFile.get('src/ok/a.js'), [{ name: 'Odd', weight: 'minor' }]);
});

test('a file on several flows records every name and weight', () => {
  const flows = [flow('A', 'minor', ['src/**']), flow('B', 'critical', ['src/x.js'])];
  const { byFile } = matchFlows(flows, ['src/x.js']);
  assert.deepEqual(byFile.get('src/x.js'), [{ name: 'A', weight: 'minor' }, { name: 'B', weight: 'critical' }]);
  const sig = productSignals('src/x.js', [], { state: 'ok' }, byFile);
  assert.equal(sig.key_flow.value, true);
  assert.equal(keyFlowFloor(sig), 'trunk');
});

test('userFacing table', () => {
  const rows = [
    ['src/App.tsx', [], true], ['locales/en.json', [], true], ['emails/welcome.html', [], true],
    ['src/api.js', ['  res.json({ ok: true });'], true], ['src/api.js', ['const x = 1;'], false],
    ['src/user.ts', ['class UserDto {'], true], ['src/order.ts', ['export class OrderDTO'], true], ['src/user.ts', ['class UserSerializer extends Base {'], true], ['src/user.ts', ['const dtoCount = 1;'], false],
    ['tests/x.test.js', ['res.json(1)'], false], ['src/App.test.tsx', [], false], ['scripts/lib/tiers.js', [], false],
  ];
  for (const [p, added, want] of rows) assert.equal(userFacing(p, added).value, want, p);
  assert.equal(userFacing('src/App.tsx').rule, 'ui template');
});

test('productSignals is null for absent and malformed, both keys otherwise', () => {
  assert.equal(productSignals('src/a.js', [], { state: 'absent' }, new Map()), null);
  assert.equal(productSignals('src/a.js', [], { state: 'malformed' }, new Map()), null);
  const sig = productSignals('src/a.js', [], { state: 'ok' }, new Map());
  assert.deepEqual(Object.keys(sig), PRODUCT_SIGNAL_KEYS);
  assert.equal(sig.key_flow.value, false);
});

test('user_facing marks under 5% of the spike corpus', () => {
  const { execFileSync } = require('node:child_process');
  const files = execFileSync('git', ['ls-files'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).split('\n').filter(Boolean);
  const marked = files.filter((f) => userFacing(f, []).value).length;
  assert.ok(marked / files.length < 0.05, `${marked}/${files.length}`);
});
