'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers/tmp');
const { cleanEnv } = require('./helpers/claude-cases');
const { buildReviewComment, MAX_CHARS } = require('../scripts/lib/review-comment');

const ROOT = path.join(__dirname, '..');
const finding = (id, severity, ref, claim, over = {}) => ({ id, stage: 'review', agent: 'ecc:code-review', claim, evidence: [{ kind: 'file', ref }], confidence: 0.8, severity, ...over });

function data(over = {}) {
  const records = [
    finding('R-0001', 'HIGH', 'tools/tests/test_edge.py:19', 'CI never runs the edge tests', { verified: true }),
    finding('R-0002', 'HIGH', 'edge.py:885', 'unlisted files ship unchecked', { verified: false }),
    finding('R-0003', 'MEDIUM', 'edge.py:793', 'models sync leaves a second copy'),
    finding('R-0004', 'LOW', 'cli.py:202', 'AWS profile is picked alphabetically'),
    { ...finding('R-0005', 'MEDIUM', 'edge.py:708', 'partial fetch is never repaired'), agent: 'spine:devils-advocate', verifier_note: 'devils advocate HIGH not confirmed by a verifier' },
    { id: 'R-0006', stage: 'review', agent: 'spine:proof', claim: 'test_run', evidence: [{ kind: 'command', ref: 'pytest' }], confidence: 1, severity: 'INFO', proof_kind: 'test_run', result: { command: 'uv run pytest', exit_code: 0, counts: { pass: 41, fail: 0 }, status: 'ok' } },
    { id: 'R-0007', stage: 'review', agent: 'spine:proof', claim: 'typecheck', evidence: [{ kind: 'command', ref: 'mypy' }], confidence: 1, severity: 'INFO', proof_kind: 'typecheck', result: { command: 'uv run mypy .', exit_code: 1, status: 'ok' } },
  ];
  return {
    review: { verdict: 'UNPROVEN', tier: 'trunk', findings: records.filter((r) => r.agent !== 'spine:proof').map((r) => ({ record_id: r.id, severity: r.severity, verified: Boolean(r.verified) })) },
    records,
    readingMap: {
      totals: { read_yourself: { hunks: 2, minutes: 18 }, read_if_time: { hunks: 9, minutes: 44 } },
      groups: { read_yourself: [{ ref: 'edge.py:793-811', reasons: ['finding'], records: ['R-0003'] }, { ref: 'cli.py:1-40', reasons: ['trunk'], records: [] }], read_if_time: [] },
    },
    proof: { missing: [{ requirement: 'integration_or_runtime', files: ['edge.py', 'cli.py'], hint: 'run the integration tests' }] },
    ...over,
  };
}

const section = (body, title) => {
  const start = body.indexOf(`### ${title}`);
  if (start < 0) return null;
  const rest = body.slice(start + 4);
  const end = rest.search(/\n### /);
  return end < 0 ? rest : rest.slice(0, end);
};

test('the header carries verdict and tier, then what to read yourself with minutes', () => {
  const body = buildReviewComment(data());
  assert.match(body, /^## Spine review · verdict UNPROVEN · tier trunk\n/);
  assert.match(body, /\*\*Read yourself \(18 min\):\*\* 1\. `edge\.py:793-811` \(R-0003\) · 2\. `cli\.py:1-40`/);
  assert.match(body, /\*\*Then, if you have time \(44 min\):\*\* 9 more hunks in the reading map\./);
});

test('only verified CRITICAL/HIGH block; an unverified HIGH goes to Not verified', () => {
  const body = buildReviewComment(data());
  assert.match(section(body, 'Blocking'), /`tools\/tests\/test_edge\.py:19` · CI never runs the edge tests · R-0001/);
  assert.doesNotMatch(section(body, 'Blocking'), /R-0002/);
  assert.match(section(body, 'Not verified'), /HIGH not verified: `edge\.py:885` · unlisted files ship unchecked · R-0002/);
  assert.match(section(body, 'Not verified'), /devils advocate HIGH not confirmed by a verifier · R-0005/);
});

test('MEDIUM is Should fix, LOW is collapsed under Nits', () => {
  const body = buildReviewComment(data());
  assert.match(section(body, 'Should fix'), /R-0003/);
  assert.match(section(body, 'Nits'), /<details><summary>1 LOW<\/summary>[\s\S]*R-0004[\s\S]*<\/details>/);
});

test('Proof lists what ran with results and what is missing', () => {
  const p = section(buildReviewComment(data()), 'Proof');
  assert.match(p, /ran: test_run ✓ 41 pass \(`uv run pytest`\)/);
  assert.match(p, /ran: typecheck ✗ exit 1 \(`uv run mypy \.`\)/);
  assert.match(p, /missing: integration_or_runtime · edge\.py, cli\.py/);
});

test('file references become links when the repo and commit are known', () => {
  const body = buildReviewComment(data({ repo: 'acme/app', sha: 'a'.repeat(40) }));
  assert.ok(body.includes(`[\`tools/tests/test_edge.py:19\`](https://github.com/acme/app/blob/${'a'.repeat(40)}/tools/tests/test_edge.py#L19)`));
});

test('reviewer text cannot ping people, break out of code spans or inject HTML', () => {
  const evil = data();
  evil.records[2] = finding('R-0003', 'MEDIUM', 'edge.py:793', 'ping @everyone and @org/team `x` <img src=x onerror=alert(1)>\nnext line');
  const body = buildReviewComment(evil);
  assert.doesNotMatch(body, /@everyone|@org\/team/);
  assert.doesNotMatch(body, /<img/);
  assert.ok(!section(body, 'Should fix').includes('\nnext line'));
});

test('an empty review says so, and the comment stays under the GitHub size limit', () => {
  const empty = buildReviewComment({ review: { verdict: 'PASS', tier: 'leaf', findings: [] }, records: [], readingMap: null, proof: { missing: [] } });
  assert.match(empty, /No findings\./);
  const many = data();
  for (let i = 0; i < 3000; i += 1) many.records.push(finding(`R-${9000 + i}`, 'LOW', `f${i}.py:1`, 'x'.repeat(200)));
  many.review.findings = many.records.filter((r) => r.agent !== 'spine:proof').map((r) => ({ record_id: r.id, severity: r.severity, verified: Boolean(r.verified) }));
  const big = buildReviewComment(many);
  assert.ok(big.length <= MAX_CHARS, `${big.length}`);
  assert.match(big, /truncated/);
});

test('review-comment.js writes <run>/review-comment.md and never posts anything', (t) => {
  const root = tmpDir('spine-rc-', t);
  const runDir = path.join(root, '.spine', '20261028-pr-885');
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  const d = data();
  fs.writeFileSync(path.join(runDir, 'state.json'), '{}');
  fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify(d.review));
  fs.writeFileSync(path.join(runDir, 'proof.json'), JSON.stringify(d.proof));
  fs.writeFileSync(path.join(runDir, 'reading-map.json'), JSON.stringify(d.readingMap));
  for (const r of d.records) fs.writeFileSync(path.join(runDir, 'records', `${r.id}.json`), JSON.stringify(r));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'review-comment.js'), '--run', runDir], { cwd: root, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.path, path.join(runDir, 'review-comment.md'));
  assert.match(fs.readFileSync(out.path, 'utf8'), /^## Spine review · verdict UNPROVEN/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'review-comment.js'), 'utf8'), /gh pr comment|child_process/);
});

test('both skills build the review comment at G3 and post it only after an explicit yes', () => {
  for (const rel of ['skills/spine/SKILL.md', 'cursor/skills/spine/SKILL.md']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(text.includes('scripts/review-comment.js --run <run>'), rel);
    assert.match(text, /Post only after an explicit yes/, rel);
    assert.match(text, /never post on your own/, rel);
  }
});
