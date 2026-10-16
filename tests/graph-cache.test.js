'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpDir } = require('./helpers/tmp');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitBlobSha, cachePath, loadCache, saveCache, CACHE_FORMAT } = require('../scripts/lib/graph-cache');
const { PARSER_VERSION } = require('../scripts/lib/imports');

const tmp = () => tmpDir('spine-cache-');
const KA = `typescript:${'a'.repeat(40)}`;
const KB = `python:${'b'.repeat(40)}`;
const entries = () => new Map([
  [KA, { parser: 'typescript', specs: [{ specifier: './x', literal: true }] }],
  [KB, { parser: 'python', specs: [{ specifier: 'os', literal: true, names: [] }, { specifier: null, literal: false }] }],
]);

test('round trip keeps valid entries and prunes keys not in use', () => {
  const file = path.join(tmp(), 'cache', 'imports-p1.json');
  assert.equal(saveCache(file, entries(), new Set([KA])), 'saved');
  const loaded = loadCache(file);
  assert.equal(loaded.status, 'loaded');
  assert.deepEqual([...loaded.entries.keys()], [KA]);
  assert.deepEqual(loaded.entries.get(KA), entries().get(KA));
});

test('missing, garbage, truncated, wrong version and bad keys are discarded, never thrown', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  assert.equal(loadCache(file).status, 'missing');
  for (const body of [
    'garbage{',
    JSON.stringify({ format: CACHE_FORMAT, parser_version: PARSER_VERSION, entries: { [KA]: entries().get(KA) } }).slice(0, -5),
    JSON.stringify({ format: CACHE_FORMAT, parser_version: 'old', entries: {} }),
    JSON.stringify({ format: CACHE_FORMAT, parser_version: PARSER_VERSION, entries: { 'not-a-key': entries().get(KA) } }),
    JSON.stringify({ format: CACHE_FORMAT, parser_version: PARSER_VERSION, entries: { [KA]: { parser: 'typescript', specs: 'nope' } } }),
  ]) {
    fs.writeFileSync(file, body);
    const out = loadCache(file);
    assert.equal(out.status, 'discarded', body.slice(0, 40));
    assert.equal(out.entries.size, 0);
  }
});

test('gitBlobSha matches git hash-object', () => {
  const buf = Buffer.from('export const a = 1;\n');
  const expected = execFileSync('git', ['hash-object', '--stdin'], { input: buf }).toString().trim();
  assert.equal(gitBlobSha(buf), expected);
});

test('an unwritable cache path is reported, never thrown', () => {
  const blocker = path.join(tmp(), 'file');
  fs.writeFileSync(blocker, 'x');
  assert.equal(saveCache(path.join(blocker, 'cache', 'c.json'), entries(), new Set([KA])), 'not-saved');
});

test('cachePath sits under the artifacts dir and names the parser version', () => {
  assert.equal(cachePath('/repo', '.spine'), path.join('/repo', '.spine', 'cache', `imports-p${PARSER_VERSION}.json`));
});
