'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionLines, missingFrom } = require('../scripts/lib/session');

const registry = { review: [{ id: 'ecc:code-review' }, { id: 'superpowers:x' }, { id: 'ecc:other', plugin: 'everything-claude-code' }] };

test('missingFrom lists needed plugins not installed, honoring a plugin override, sorted', () => {
  assert.deepEqual(missingFrom(registry, ['ecc']), ['everything-claude-code', 'superpowers']);
});

test('buildSessionLines keeps the Claude wording by default', () => {
  const run = { id: '20260920-demo', state: { stage: 'plan', awaiting: 'G2' } };
  assert.deepEqual(buildSessionLines({ missing: ['x'], run }), [
    'spine: missing plugins: x. Affected providers will be skipped.',
    'spine: active run 20260920-demo at stage plan, awaiting G2. Run /spine:spine status to resume.',
  ]);
});

test('buildSessionLines takes a host status command and extra lines', () => {
  const run = { id: '20260920-demo', state: { stage: 'plan', awaiting: null } };
  assert.deepEqual(buildSessionLines({ run, statusCommand: '/spine status', extra: ['e'] }), [
    'spine: active run 20260920-demo at stage plan, awaiting none. Run /spine status to resume.', 'e',
  ]);
  assert.deepEqual(buildSessionLines({}), []);
});
