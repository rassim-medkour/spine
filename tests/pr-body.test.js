'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SECTIONS, buildPrBody, parseWritten } = require('../scripts/lib/pr-body');
const { parseDiff } = require('../scripts/lib/diff');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');

const ROOT = path.join(__dirname, '..');
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tree-golden.json'), 'utf8'));
const DIFF = 'diff --git a/src/lib/math.ts b/src/lib/math.ts\n--- a/src/lib/math.ts\n+++ b/src/lib/math.ts\n@@ -1 +1,2 @@\n const a = 1;\n+export const b = 2;\n';
const WRITTEN = [
  '## TL;DR', '', 'Adds subtraction.', '',
  '## The problem, with an example', '', 'Before: callers re-implemented it.', 'After: one shared helper.', '',
  '## The design decision that shaped everything', '', 'Keep math pure; the owner chose no new dependency.', '',
].join('\n');

function data(tier, over = {}) {
  return {
    tier,
    runRel: '.spine/20261015-pr',
    diffFiles: parseDiff(DIFF),
    tree: { ...golden, tier },
    review: { verdict: 'PASS_WITH_ADVISORIES', tier, providers: ['ecc:code-review', 'feature-dev:code-reviewer'], findings: [{ record_id: 'R-0001', severity: 'MEDIUM', corroboration: 1, verified: false }] },
    records: [{ id: 'R-0002', stage: 'review', agent: 'spine:proof', claim: 'tests', evidence: [{ kind: 'command', ref: 'npm test' }], confidence: 1, severity: 'INFO', proof_kind: 'test_run', result: { command: 'npm test', exit_code: 0, counts: { pass: 3, fail: 0 }, status: 'ok' } }],
    proof: { present: [{ requirement: 'test_run', record_ids: ['R-0002'] }], missing: [], info: [] },
    readingMap: { totals: { read_yourself: { hunks: 1, minutes: 1 }, whole: { minutes: 1 } }, groups: { read_yourself: [{ ref: 'src/lib/math.ts:1-2', reasons: ['trunk'] }] } },
    planText: '## Rollback\n\nRun `git revert HEAD`.\n',
    specAssumptions: ['Rates are configurable.'],
    ...over,
  };
}

const sectionBodies = (body) => Object.fromEntries(body.split(/^## /m).filter(Boolean).map((chunk) => {
  const [title, ...rest] = chunk.split('\n');
  return [title.trim(), rest.filter((l) => l.trim())];
}));

test('sections are chosen by change tier, reading map first for trunk', () => {
  assert.deepEqual(buildPrBody(data('leaf'), WRITTEN).sections, ['tldr', 'changed', 'checked', 'how_to_test']);
  assert.deepEqual(buildPrBody(data('branch'), WRITTEN).sections, ['tldr', 'problem', 'changed', 'decisions', 'checked', 'not_verified', 'how_to_test']);
  const trunk = buildPrBody(data('trunk'), WRITTEN);
  assert.deepEqual(trunk.sections, SECTIONS.map((s) => s.key));
  assert.equal(trunk.sections[0], 'reading_map');
  assert.ok(trunk.ok, trunk.errors.join('; '));
  assert.match(trunk.body, /^## Risk and reading map\n\n- Is this trunk code\? yes/);
});

test('Not verified is never omitted when it has content, even for a leaf change', () => {
  const gap = { requirement: 'static_check', kinds: ['lint', 'typecheck'], tier: 'leaf', files: ['src/lib/math.ts'], reason: 'no proof record', hint: 'h' };
  const out = buildPrBody(data('leaf', { proof: { present: [], missing: [gap], info: [] } }), WRITTEN);
  assert.ok(out.sections.includes('not_verified'));
  assert.match(out.body, /## Not verified\n\n- static_check: src\/lib\/math\.ts \(no proof record\)/);
  assert.match(buildPrBody(data('branch'), WRITTEN).body, /## Not verified\n\n- Nothing unverified\./);
});

test('every section of every tier stays within its cap', () => {
  const many = Array.from({ length: 200 }, (_, i) => i);
  const bigDiff = many.map((i) => `diff --git a/a${i}/b/f.ts b/a${i}/b/f.ts\n--- a/a${i}/b/f.ts\n+++ b/a${i}/b/f.ts\n@@ -1 +1 @@\n-x\n+y\n`).join('');
  const records = many.map((i) => ({ id: `R-${1000 + i}`, stage: 'review', agent: 'spine:devils-advocate', claim: `objection ${i}`, dissent: 'd', evidence: [{ kind: 'unverified', ref: 'x' }], confidence: 0.5, severity: 'MEDIUM', proof_kind: 'test_run', result: { command: `cmd ${i}` } }));
  const missing = many.map((i) => ({ requirement: `req_${i}`, kinds: ['test_run'], tier: 'trunk', files: [`f${i}.ts`], reason: 'no proof record', hint: 'h' }));
  const rm = { totals: { read_yourself: { hunks: 200, minutes: 50 }, whole: { minutes: 60 } }, groups: { read_yourself: many.map((i) => ({ ref: `f${i}.ts:1-1`, reasons: ['trunk'] })) } };
  for (const tier of ['leaf', 'branch', 'trunk']) {
    const big = data(tier, { diffFiles: parseDiff(bigDiff), records, proof: { present: [], missing, info: [] }, readingMap: rm, planText: `## Rollback\n\n${many.map((i) => `- revert step ${i}`).join('\n')}`, specAssumptions: many.map((i) => `assumption ${i}`) });
    const out = buildPrBody(big, WRITTEN);
    assert.ok(out.ok, `${tier}: ${out.errors.join('; ')}`);
    const bodies = sectionBodies(out.body);
    for (const s of SECTIONS.filter((x) => out.sections.includes(x.key))) {
      assert.ok(bodies[s.title].length <= s.caps[tier], `${tier} ${s.key}: ${bodies[s.title].length} > ${s.caps[tier]}`);
    }
    assert.match(out.body, /\.\.\.and \d+ more/);
  }
});

test('written sections: required, capped, problem needs before and after, no attribution', () => {
  const missingProblem = buildPrBody(data('branch'), '## TL;DR\n\nx\n');
  assert.ok(missingProblem.errors.includes('missing written section "## The problem, with an example"'));
  const long = buildPrBody(data('leaf'), `## TL;DR\n\n${'line\n'.repeat(4)}`);
  assert.ok(long.errors.includes('"## TL;DR" has 4 lines; the cap for leaf is 3'));
  const noExample = buildPrBody(data('branch'), WRITTEN.replace('Before: callers re-implemented it.\nAfter: one shared helper.', 'It was bad.'));
  assert.ok(noExample.errors.includes('"## The problem, with an example" needs a before and an after example'));
  const attributed = buildPrBody(data('leaf'), '## TL;DR\n\nx\nCo-Authored-By: someone <a@b.c>\n');
  assert.ok(attributed.errors.includes('"## TL;DR" contains an attribution line'));
  assert.equal(attributed.body, null);
});

test('generated sections draw on the run: changes by area, checks, commands, decisions', () => {
  const body = buildPrBody(data('trunk'), WRITTEN).body;
  assert.match(body, /\| `src\/lib` \| 1 \| \+1 \/ -0 \| trunk \|/);
  assert.match(body, /- Reviewers: ecc:code-review, feature-dev:code-reviewer/);
  assert.match(body, /- `npm test`/);
  assert.match(body, /- Spec assumption: Rates are configurable\./);
  assert.match(body, /Run `git revert HEAD`\./);
  assert.doesNotMatch(body, /co-authored-by|generated with/i);
});

test('parseWritten splits on level-2 headings', () => {
  assert.deepEqual([...parseWritten('## A\n\nx\n## B\ny\n')], [['A', 'x'], ['B', 'y']]);
});

test('CLI refuses to run before G3 and writes pr-body.md after it', () => {
  const root = tmpDir('spine-pr-');
  const runDir = path.join(root, '.spine', '20261015-pr');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ stage: 'review' }));
  fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify({ id: 'x', upstream_id: 'none', verdict: 'PASS', providers: [], findings: [], dissent: [] }));
  fs.writeFileSync(path.join(runDir, 'diff.patch'), DIFF);
  fs.writeFileSync(path.join(runDir, 'pr-written.md'), WRITTEN);
  const cli = () => JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pr-body.js'), '--run', runDir], { cwd: root, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: root }) }).stdout);
  assert.equal(cli().ok, false);
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ stage: 'done' }));
  const out = cli();
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.tier, 'branch');
  assert.match(fs.readFileSync(path.join(runDir, 'pr-body.md'), 'utf8'), /^## TL;DR/);
});
