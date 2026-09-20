const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../scripts/classify');
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
