const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, globToRegExp } = require('../scripts/classify');
const { DEFAULTS } = require('../scripts/lib/state');
const { validateJson, loadSchema } = require('../scripts/lib/validate');

const noChurn = () => 0;
const cfg = { ...DEFAULTS };

test('three doc files is S and low blast radius', () => {
  const r = classify({ files: ['docs/a.md', 'docs/b.md', 'README.md'] }, cfg, noChurn);
  assert.equal(r.size, 'S');
  assert.equal(r.blast_radius, 'low');
  assert.deepEqual(r.lenses, ['correctness']);
  assert.equal(r.devils_advocate, false);
  assert.deepEqual(r.workflows, { spec: false, implement: false, review: false });
});

test('migration forces L and database lens', () => {
  const r = classify({ files: ['services/main/migrations/0004_x.py'], migration: true }, cfg, noChurn);
  assert.equal(r.size, 'L');
  assert.ok(r.lenses.includes('database'));
  assert.ok(r.lenses.includes('python'));
  assert.equal(r.devils_advocate, true);
});

test('two services with nine files is M', () => {
  const files = [
    'services/main/a.py', 'services/main/b.py', 'services/main/c.py', 'services/main/d.py',
    'services/booking/x.ts', 'services/booking/y.ts', 'services/booking/z.ts', 'services/booking/w.tsx', 'services/booking/v.tsx',
  ];
  const r = classify({ files }, cfg, noChurn);
  assert.equal(r.size, 'M');
  assert.equal(r.signals.services, 2);
  assert.ok(r.lenses.includes('typescript'));
  assert.ok(r.lenses.includes('react'));
  assert.deepEqual(r.workflows, { spec: false, implement: true, review: true });
});

test('critical_paths glob marks blast radius critical and adds security', () => {
  const r = classify({ files: ['services/main/appointments/create.py'] }, { ...cfg, critical_paths: ['services/main/appointments/**'] }, noChurn);
  assert.equal(r.blast_radius, 'critical');
  assert.ok(r.lenses.includes('security'));
  assert.equal(r.devils_advocate, true);
});

test('high churn marks critical', () => {
  const r = classify({ files: ['src/hot.py'] }, cfg, () => 25);
  assert.equal(r.blast_radius, 'critical');
});

test('auth path adds security lens', () => {
  const r = classify({ files: ['src/auth/login.py'] }, cfg, noChurn);
  assert.ok(r.lenses.includes('security'));
});

test('output validates against class schema', () => {
  const r = classify({ files: ['src/a.py'] }, cfg, noChurn);
  assert.deepEqual(validateJson(r, loadSchema('class')), []);
});

test('globToRegExp: ** matches across directories', () => {
  const re = globToRegExp('services/main/appointments/**');
  assert.ok(re.test('services/main/appointments/a/b/c.py'));
});

test('globToRegExp: **/*.py matches nested and top-level files, not other extensions', () => {
  const re = globToRegExp('src/**/*.py');
  assert.ok(re.test('src/c.py'));
  assert.ok(re.test('src/a/b/c.py'));
  assert.ok(!re.test('src/c.js'));
});

test('globToRegExp: a/**/b matches zero or more intervening directories', () => {
  const re = globToRegExp('a/**/b');
  assert.ok(re.test('a/b'));
  assert.ok(re.test('a/x/y/b'));
});

test('globToRegExp: *.md matches top-level only', () => {
  const re = globToRegExp('*.md');
  assert.ok(re.test('README.md'));
  assert.ok(!re.test('docs/x.md'));
});

test('globToRegExp: ? matches exactly one non-slash character', () => {
  const re = globToRegExp('a?c');
  assert.ok(re.test('abc'));
  assert.ok(!re.test('ac'));
  assert.ok(!re.test('a/c'));
  assert.ok(!re.test('abbc'));
});
