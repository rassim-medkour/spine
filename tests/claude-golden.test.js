// tests/claude-golden.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CASES, runCase } = require('./helpers/claude-cases');

const GOLDEN = path.join(__dirname, 'fixtures', 'claude-golden.json');

test('golden file has exactly one entry per Claude hook case', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(golden).sort(), CASES.map((c) => c.name).sort());
});

for (const c of CASES) {
  test(`Claude hook output is byte-identical: ${c.name}`, () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(runCase(c), golden[c.name]);
  });
}
