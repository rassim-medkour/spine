const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateJson, validateMarkdown, validateRecord, validateArtifactFile } = require('../scripts/lib/validate');

const FIX = path.join(__dirname, 'fixtures');
const read = (p) => fs.readFileSync(path.join(FIX, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

test('validateJson reports missing required keys and bad enums', () => {
  const schema = { kind: 'json', required: ['id', 'stage'], enums: { stage: ['intent'] } };
  assert.deepEqual(validateJson({ id: 'x', stage: 'bogus' }, schema), ['stage must be one of intent, got bogus']);
  assert.deepEqual(validateJson({ stage: 'intent' }, schema), ['missing required key id']);
});

test('validateJson validates array item shapes', () => {
  const schema = { kind: 'json', required: [], arrays: { evidence: { required: ['kind'], enums: { kind: ['file'] } } } };
  assert.deepEqual(validateJson({ evidence: [{ kind: 'nope' }] }, schema), ['evidence[0].kind must be one of file, got nope']);
  assert.deepEqual(validateJson({ evidence: 'notarray' }, schema), ['evidence must be an array']);
});

test('validateRecord accepts a valid record', () => {
  assert.deepEqual(validateRecord(readJson('records/valid.json')), []);
});

test('validateRecord caps severity when evidence is only unverified', () => {
  const errors = validateRecord(readJson('records/unverified-high.json'));
  assert.deepEqual(errors, ['severity HIGH requires at least one evidence item that is not unverified']);
});

test('validateMarkdown checks frontmatter keys and headings', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'intent.json'), 'utf8'));
  assert.deepEqual(validateMarkdown(read('artifacts/intent-valid.md'), schema), []);
  assert.deepEqual(validateMarkdown(read('artifacts/intent-missing-heading.md'), schema), [
    'missing heading "## Acceptance criteria"',
    'missing heading "## Constraints"',
    'missing heading "## Out of scope"',
  ]);
});

test('validateArtifactFile picks schema by basename and ignores unknown files', () => {
  assert.deepEqual(validateArtifactFile(path.join(FIX, 'artifacts', 'intent-valid.md'), 'intent.md'), []);
  assert.deepEqual(validateArtifactFile(path.join(FIX, 'records', 'valid.json'), 'records/R-0001.json'), []);
  assert.deepEqual(validateArtifactFile(path.join(FIX, 'records', 'valid.json'), 'notes.txt'), []);
});
