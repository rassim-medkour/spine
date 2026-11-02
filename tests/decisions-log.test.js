const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers/tmp');
const { writeState } = require('../scripts/lib/state');
const { main } = require('../scripts/product-context');
const pc = require('../scripts/lib/product-context');

const { formatDecisionLine, appendDecision, readDecisionsTail, loadProduct, DECISIONS_HEADER, DECISION_LINE_RE } = pc;
const RUN_ID = '20261102-decisions';
const base = { runId: RUN_ID, recordId: 'R-0007', date: '2026-11-02', question: 'Should refunds be partial?', answer: 'yes, partial' };
const read = (f) => fs.readFileSync(f, 'utf8');

test('formatDecisionLine fixed field order and delimiter', () => {
  const line = formatDecisionLine(base);
  assert.equal(line, '- 2026-11-02 · 20261102-decisions · R-0007 · Should refunds be partial? · yes, partial');
  assert.match(line, DECISION_LINE_RE);
});

test('question over 120 and answer over 200 code points are cut; the answer carries the cut marker', () => {
  const q = '😀'.repeat(150);
  const a = 'é😀'.repeat(150);
  const line = formatDecisionLine({ ...base, question: q, answer: a });
  const parts = line.split(' · ');
  assert.equal([...parts[3]].length, 120);
  assert.equal(parts[4], [...a].slice(0, 200).join('') + ' (cut, full text in R-0007)');
  assert.ok(!line.includes('�'));
  const whole = formatDecisionLine({ ...base, answer: 'x'.repeat(200) });
  assert.ok(!whole.includes('(cut'));
});

test('newlines and a leading # are neutralized', () => {
  const line = formatDecisionLine({ ...base, question: '# head\nsecond', answer: '## no\r\nway' });
  assert.ok(!/[\r\n]/.test(line));
  const parts = line.split(' · ');
  assert.ok(!parts[3].startsWith('#'));
  assert.ok(!parts[4].startsWith('#'));
});

test('appendDecision creates the file with the header when absent', (t) => {
  const f = path.join(tmpDir('spine-dec-', t), '.spine', 'decisions.md');
  const r = appendDecision(f, base);
  assert.deepEqual([r.ok, r.written], [true, true]);
  assert.equal(read(f), DECISIONS_HEADER + '\n' + r.line + '\n');
});

test('idempotent on run id plus record id', (t) => {
  const f = path.join(tmpDir('spine-dec-', t), 'decisions.md');
  appendDecision(f, base);
  const second = appendDecision(f, { ...base, answer: 'different' });
  assert.deepEqual([second.ok, second.written], [true, false]);
  assert.equal(read(f).split('\n').filter((l) => l.startsWith('- ')).length, 1);
  assert.equal(appendDecision(f, { ...base, recordId: 'R-0008' }).written, true);
});

test('no existing line changes and CRLF is kept', (t) => {
  const f = path.join(tmpDir('spine-dec-', t), 'decisions.md');
  const old = `${DECISIONS_HEADER}\r\n- 2026-10-01 · older · R-0001 · q · a\r\n`;
  fs.writeFileSync(f, old);
  appendDecision(f, base);
  const now = read(f);
  assert.ok(now.startsWith(old));
  assert.ok(now.endsWith('\r\n'));
  assert.equal(now.replace(/\r\n/g, '').includes('\n'), false);
});

test('a concurrent edit to product.md between read and append is untouched', (t) => {
  const dir = tmpDir('spine-dec-', t);
  const p = path.join(dir, 'product.md');
  fs.writeFileSync(p, 'original');
  appendDecision(path.join(dir, 'decisions.md'), base, {
    ...pc.defaultDecisionsIo,
    rename(a, b) { fs.writeFileSync(p, 'edited by human'); return fs.renameSync(a, b); },
  });
  assert.equal(read(p), 'edited by human');
});

test('simulated crash between temp write and rename leaves old or new file intact', (t) => {
  const dir = tmpDir('spine-dec-', t);
  const f = path.join(dir, 'decisions.md');
  appendDecision(f, base);
  const before = read(f);
  const r = appendDecision(f, { ...base, recordId: 'R-0009' }, { ...pc.defaultDecisionsIo, rename() { throw Object.assign(new Error('boom'), { code: 'EIO' }); } });
  assert.equal(r.ok, false);
  assert.equal(read(f), before);
  assert.deepEqual(fs.readdirSync(dir), ['decisions.md']);
});

test('one retry on EPERM then success; two failures report an error', (t) => {
  const f = path.join(tmpDir('spine-dec-', t), 'decisions.md');
  let n = 0;
  const flaky = (limit) => ({ ...pc.defaultDecisionsIo, rename(a, b) { if (n++ < limit) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return fs.renameSync(a, b); } });
  assert.equal(appendDecision(f, base, flaky(1)).written, true);
  n = 0;
  const bad = appendDecision(f, { ...base, recordId: 'R-0010' }, flaky(2));
  assert.deepEqual([bad.ok, bad.error], [false, 'EPERM']);
});

test('readDecisionsTail returns the last 10 lines', (t) => {
  const f = path.join(tmpDir('spine-dec-', t), 'decisions.md');
  for (let i = 1; i <= 14; i++) appendDecision(f, { ...base, recordId: `R-${String(i).padStart(4, '0')}` });
  const tail = readDecisionsTail(f);
  assert.equal(tail.length, 10);
  assert.match(tail[9], /R-0014/);
  assert.match(tail[0], /R-0005/);
  assert.deepEqual(readDecisionsTail(path.join(path.dirname(f), 'nope.md')), []);
});

const productText = () => '## Users\nu\n## Goals\ng\n## Glossary\n## Invariants\ni\n## Key flows\n## UX principles\nx\n';

test('loadProduct excludes decisions.md from the budget count and loads the tail over budget', (t) => {
  const root = tmpDir('spine-dec-', t);
  fs.mkdirSync(path.join(root, '.spine'));
  fs.writeFileSync(path.join(root, '.spine', 'product.md'), productText());
  for (let i = 1; i <= 12; i++) appendDecision(path.join(root, '.spine', 'decisions.md'), { ...base, recordId: `R-${String(i).padStart(4, '0')}` });
  const loaded = loadProduct(root, { product_context_max_lines: 11 }, []);
  assert.equal(loaded.state, 'ok');
  assert.equal(loaded.decisionsTail.length, 10);
  assert.equal(loaded.loadedLines, loaded.text.split('\n').length + 10);
});

function setupRun(t, agent = 'spine:product-lens') {
  const root = tmpDir('spine-dec-root-', t);
  const runDir = path.join(root, '.spine', RUN_ID);
  writeState(runDir, { id: RUN_ID, stage: 'review', status: 'active', awaiting: 'human', size: 'M', updated: '2026-11-02T00:00:00Z', host: 'claude-code', spine_version: '0.4.0' });
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'records', 'R-0001.json'), JSON.stringify({
    id: 'R-0001', stage: 'review', agent, claim: 'c', evidence: [{ kind: 'doc', ref: 'README.md', note: 'n' }], confidence: 0.5, severity: 'MEDIUM',
    dissent: null, resolution: { kind: 'question', text: 'assumption to confirm: refunds partial?' }, alternatives: [],
  }));
  return { root, runDir };
}
const decide = (r, cwd = r.root) => main(['--run', r.runDir, '--decide', '--record', 'R-0001', '--answer', 'yes'], cwd);

test('--decide on a record from spine:synthesis is refused', (t) => {
  const r = setupRun(t, 'spine:synthesis');
  const out = decide(r);
  assert.equal(out.ok, false);
  assert.ok(!fs.existsSync(path.join(r.root, '.spine', 'decisions.md')));
});

test('--decide twice writes one line', (t) => {
  const r = setupRun(t);
  assert.equal(decide(r).written, true);
  assert.equal(decide(r).written, false);
  const lines = read(path.join(r.root, '.spine', 'decisions.md')).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /R-0001 · assumption to confirm: refunds partial\? · yes$/);
  const pj = JSON.parse(read(path.join(r.runDir, 'product.json')));
  assert.equal(pj.decisions.length, 1);
});

test('with worktree.json present the append lands in the main checkout', (t) => {
  const r = setupRun(t);
  const wt = tmpDir('spine-dec-wt-', t);
  fs.writeFileSync(path.join(r.runDir, 'worktree.json'), JSON.stringify({ path: wt }));
  assert.equal(decide(r, wt).written, true);
  assert.ok(fs.existsSync(path.join(r.root, '.spine', 'decisions.md')));
  assert.ok(!fs.existsSync(path.join(wt, '.spine', 'decisions.md')));
});
