'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiff, hunkLineCount, addedLineSet } = require('../scripts/lib/diff');

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' import x from "./x";',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' export { a };',
  '@@ -10,2 +11,2 @@',
  ' line10',
  '-old11',
  '+new12',
  'diff --git a/db/drop.sql b/db/drop.sql',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/db/drop.sql',
  '@@ -0,0 +1,2 @@',
  '+-- drop the table',
  '+DROP TABLE users;',
  'diff --git a/old.py b/old.py',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.py',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-import os',
  '--- a removed line that starts with dashes',
  'diff --git a/lib/one.js b/lib/two.js',
  'similarity index 90%',
  'rename from lib/one.js',
  'rename to lib/two.js',
  'index 5555555..6666666 100644',
  '--- a/lib/one.js',
  '+++ b/lib/two.js',
  '@@ -1 +1 @@',
  '-module.exports = 1;',
  '+module.exports = 2;',
  '\\ No newline at end of file',
  'diff --git a/img/logo.png b/img/logo.png',
  'index 7777777..8888888 100644',
  'Binary files a/img/logo.png and b/img/logo.png differ',
  'diff --git "a/docs/my file.md" "b/docs/my file.md"',
  'index 9999999..aaaaaaa 100644',
  '--- "a/docs/my file.md"',
  '+++ "b/docs/my file.md"',
  '@@ -1 +1 @@',
  '-a',
  '+b',
].join('\n') + '\n';

test('parses files, statuses and hunks', () => {
  const files = parseDiff(SAMPLE);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [
    ['src/a.ts', 'modified', false],
    ['db/drop.sql', 'added', false],
    ['old.py', 'deleted', false],
    ['lib/two.js', 'renamed', false],
    ['img/logo.png', 'modified', true],
    ['docs/my file.md', 'modified', false],
  ]);
  const a = files[0];
  assert.equal(a.hunks.length, 2);
  assert.deepEqual(a.hunks[0].added, [{ line: 2, text: 'const a = 2;' }, { line: 3, text: 'const b = 3;' }]);
  assert.deepEqual(a.hunks[0].removed, [{ line: 2, text: 'const a = 1;' }]);
  assert.deepEqual(a.hunks[1].added, [{ line: 12, text: 'new12' }]);
  assert.deepEqual([...addedLineSet(a)], [2, 3, 12]);
  assert.equal(hunkLineCount(a.hunks[0]), 3);
});

test('a removed line starting with dashes stays inside its hunk', () => {
  const old = parseDiff(SAMPLE)[2];
  assert.deepEqual(old.hunks[0].removed.map((l) => l.text), ['import os', '-- a removed line that starts with dashes']);
  assert.equal(old.oldPath, 'old.py');
});

test('rename keeps old and new path', () => {
  const r = parseDiff(SAMPLE)[3];
  assert.equal(r.oldPath, 'lib/one.js');
  assert.equal(r.path, 'lib/two.js');
  assert.equal(r.hunks.length, 1);
});

test('binary files have no hunks', () => {
  assert.deepEqual(parseDiff(SAMPLE)[4].hunks, []);
});

test('CRLF diff parses the same as LF', () => {
  assert.deepEqual(parseDiff(SAMPLE.replace(/\n/g, '\r\n')), parseDiff(SAMPLE));
});

test('empty and garbage input give no files and never throw', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff(null), []);
  assert.deepEqual(parseDiff('@@ -1 +1 @@\n+orphan\n'), []);
});
