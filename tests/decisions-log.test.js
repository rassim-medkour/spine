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
  assert.equal(loaded.loadedLines, 10 + 10);
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

// T-15a
test('T-15a: loadProduct text ends with a Decisions (last 10) block that never counts toward the budget', (t) => {
  const root = tmpDir('spine-dec-', t);
  fs.mkdirSync(path.join(root, '.spine'));
  fs.writeFileSync(path.join(root, '.spine', 'product.md'), productText());
  for (let i = 1; i <= 12; i++) appendDecision(path.join(root, '.spine', 'decisions.md'), { ...base, recordId: `R-${String(i).padStart(4, '0')}` });
  const ok = loadProduct(root, { product_context_max_lines: 11 }, []);
  const lines = ok.text.split('\n');
  assert.equal(lines[lines.length - 11], '## Decisions (last 10)');
  assert.deepEqual(lines.slice(-10), ok.decisionsTail);
  assert.equal(ok.loadedLines, 10 + 10);
  const trimmed = loadProduct(root, { product_context_max_lines: 4 }, []);
  assert.equal(trimmed.state, 'trimmed');
  assert.deepEqual(trimmed.text.split('\n').slice(-10), trimmed.decisionsTail);
  assert.equal(trimmed.loadedLines, 4 + 10);
});

test('T-15a: no decisions, no block', (t) => {
  const root = tmpDir('spine-dec-', t);
  fs.mkdirSync(path.join(root, '.spine'));
  fs.writeFileSync(path.join(root, '.spine', 'product.md'), productText());
  assert.ok(!loadProduct(root, {}, []).text.includes('Decisions (last 10)'));
});

test('T-15a: --decide writes one decision record holding the whole answer; a cut line points at it', (t) => {
  const r = setupRun(t);
  const long = 'é'.repeat(260);
  const out = main(['--run', r.runDir, '--decide', '--record', 'R-0001', '--answer', long], r.root);
  assert.equal(out.written, true);
  const rec = JSON.parse(read(path.join(r.runDir, 'records', 'R-0002.json')));
  assert.equal(rec.agent, 'spine:orchestrator');
  assert.equal(rec.severity, 'INFO');
  assert.equal(rec.claim, `decision for R-0001: ${'é'.repeat(120)}`);
  assert.deepEqual(rec.resolution, { kind: 'decision', text: long });
  assert.equal(rec.resolves, 'R-0001');
  assert.equal(rec.evidence[0].kind, 'doc');
  assert.equal(rec.evidence[0].ref, '.spine/decisions.md');
  const line = read(path.join(r.root, '.spine', 'decisions.md')).split('\n').find((l) => l.startsWith('- '));
  assert.match(line, / · R-0001 · /);
  assert.ok(line.endsWith('(cut, full text in R-0002)'), line);
  main(['--run', r.runDir, '--decide', '--record', 'R-0001', '--answer', long], r.root);
  assert.equal(fs.readdirSync(path.join(r.runDir, 'records')).length, 2);
});

test('T-15a: two failed renames write one MEDIUM naming the decision and return ok false', (t) => {
  const r = setupRun(t);
  const io = { ...pc.defaultDecisionsIo, rename() { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
  const out = main(['--run', r.runDir, '--decide', '--record', 'R-0001', '--answer', 'yes'], r.root, io);
  assert.deepEqual([out.ok, out.written, out.error], [false, false, 'EPERM']);
  const mediums = fs.readdirSync(path.join(r.runDir, 'records')).map((f) => JSON.parse(read(path.join(r.runDir, 'records', f)))).filter((x) => /^decision not written/.test(x.claim));
  assert.equal(mediums.length, 1);
  assert.match(mediums[0].claim, /decision not written: R-0001/);
  assert.ok(!fs.existsSync(path.join(r.root, '.spine', 'decisions.md')));
});

test('T-15a: the decisions tail comes from the main checkout while product.md comes from the working root', (t) => {
  const r = setupRun(t);
  const wt = tmpDir('spine-dec-wt-', t);
  fs.writeFileSync(path.join(r.runDir, 'worktree.json'), JSON.stringify({ path: wt }));
  fs.mkdirSync(path.join(wt, '.spine'));
  fs.writeFileSync(path.join(wt, '.spine', 'product.md'), productText());
  appendDecision(path.join(r.root, '.spine', 'decisions.md'), base);
  const out = main(['--run', r.runDir], wt);
  assert.equal(out.state, 'ok');
  const ctx = read(path.join(r.runDir, 'product-context.md'));
  assert.match(ctx, /## Decisions \(last 10\)\n- 2026-11-02 · 20261102-decisions · R-0007/);
});

test('T-15a: a rerun repairs product.json.decisions from the log without a second line or exit 1', (t) => {
  const r = setupRun(t);
  decide(r);
  const pj = path.join(r.runDir, 'product.json');
  fs.unlinkSync(pj);
  const out = decide(r);
  assert.deepEqual([out.ok, out.written], [true, false]);
  const fixed = JSON.parse(read(pj));
  assert.equal(fixed.decisions.length, 1);
  assert.equal(fixed.decisions[0].record, 'R-0001');
  assert.match(fixed.decisions[0].line, /R-0001/);
  assert.equal(read(path.join(r.root, '.spine', 'decisions.md')).split('\n').filter((l) => l.startsWith('- ')).length, 1);
  assert.equal(fs.readdirSync(path.join(r.runDir, 'records')).length, 2);
});

test('T-15a: a product.json that cannot be written after a successful append still returns ok', (t) => {
  const r = setupRun(t);
  const io = { ...pc.defaultDecisionsIo, write(file, text) { return fs.writeFileSync(file, text); } };
  const blocker = path.join(r.runDir, 'product.json');
  // A directory in place of the file makes the later write fail while the read-side check sees no file content.
  const realWrite = fs.writeFileSync;
  let tripped = false;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file) === blocker && !tripped) { tripped = true; throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    return realWrite.call(this, file, ...rest);
  };
  let out;
  try {
    out = main(['--run', r.runDir, '--decide', '--record', 'R-0001', '--answer', 'yes'], r.root, io);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(tripped, true);
  assert.deepEqual([out.ok, out.written], [true, true]);
  assert.equal(read(path.join(r.root, '.spine', 'decisions.md')).split('\n').filter((l) => l.startsWith('- ')).length, 1);
});

test('T-15a: --record must look like R-0001, else ok false and no file access', (t) => {
  const r = setupRun(t);
  for (const bad of ['../../x', 'R-1', 'r-0001', 'R-0001/../R-0001']) {
    const out = main(['--run', r.runDir, '--decide', '--record', bad, '--answer', 'yes'], r.root);
    assert.deepEqual([out.ok, out.error], [false, 'invalid record id'], bad);
  }
  assert.ok(!fs.existsSync(path.join(r.root, '.spine', 'decisions.md')));
});
