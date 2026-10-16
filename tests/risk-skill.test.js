'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SKILLS = ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md'];
const NEEDLES = [
  'scripts/tree.js --run', 'scripts/check-proof.js --run', 'scripts/save-evidence.js --run', 'scripts/test-quality.js --run',
  'scripts/verdict.js --run', 'scripts/reading-map.js --run', '<run>/diff.patch', 'UNPROVEN', '"unproven_blocks": true',
  '"risk_tiers": false', '"waives"', '"resolves"', '--no-checkout', 'proof_timeout_seconds', '"spine:proof"', 'revision',
  'file tier', 'change tier', '## Rollback', 'Confirm at G3', 'check out the branch to collect proof',
];

for (const rel of SKILLS) {
  test(`${rel} wires tree, proof, verdict and reading map`, () => {
    const text = read(rel);
    for (const needle of NEEDLES) assert.ok(text.includes(needle), `${rel} is missing ${needle}`);
  });
}

test('both skills run the scripts in the same order', () => {
  const order = (text) => ['tree.js --run', 'check-proof.js --run', 'test-quality.js --run', 'verdict.js --run', 'reading-map.js --run'].map((s) => text.indexOf(`scripts/${s}`));
  for (const rel of SKILLS) {
    const idx = order(read(rel));
    assert.ok(idx.every((i) => i > 0), rel);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, rel);
  }
});

test('the Claude skill passes tree to the review workflow; the Cursor skill puts it in finder prompts', () => {
  assert.match(read('skills/spine/SKILL.md'), /tree: \{ tier, files: \[\{ path, tier \}\] \}/);
  assert.match(read('cursor/skills/spine/SKILL.md'), /Change tier: <tier>\. Trunk files \(read these hardest\): <paths>\./);
});

test('the verdict is never written by hand in either skill', () => {
  for (const rel of SKILLS) assert.match(read(rel), /never write `verdict`, `tier` or `missing_proof` by hand/i);
});
