#!/usr/bin/env node
'use strict';
// Captures the artifacts a given spine checkout produces for one fixed change
// with no .spine/product.md, so a later version can prove byte-identity.
//
//   node tests/fixtures/product/absent-baseline/capture.js --spine-root <checkout> --out <dir>
//
// The change is deterministic: the typescript graph fixture is committed with
// fixed author, committer and dates, then two files are edited. Every artifact
// is produced by <checkout>/scripts/*.js exactly as the spine skill runs them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const RUN_ID = '20261101-absent-baseline';
const FILES = ['src/lib/math.ts', 'src/app.ts'];
const GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Baseline', GIT_AUTHOR_EMAIL: 'baseline@example.com', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Baseline', GIT_COMMITTER_EMAIL: 'baseline@example.com', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z',
});
const REVIEW = { id: RUN_ID, upstream_id: 'none', verdict: 'PASS', providers: [], findings: [], dissent: [] };
const WRITTEN = [
  '## TL;DR', '', 'Baseline change for the absent product context proof.', '',
  '## The problem, with an example', '', 'Before: no baseline existed.', 'After: one captured baseline.', '',
  '## The design decision that shaped everything', '', 'Capture real 0.3.2 output, never a hand-written fixture.', '',
].join('\n');
const SPEC = ['# Spec', '', '## Assumptions', '', '- Baseline assumption one.', ''].join('\n');
const ARTIFACTS = ['classify.json', 'tree.json', 'diagnostics.json', 'reading-map.md', 'reading-map.json', 'pr-body.md'];

function parseArgs(argv) {
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  const spineRoot = at('--spine-root');
  const out = at('--out');
  if (!spineRoot || !out) throw new Error('usage: capture.js --spine-root <checkout> --out <dir>');
  return { spineRoot: path.resolve(spineRoot), out: path.resolve(out) };
}

function cleanEnv(extra) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CURSOR_/.test(k) && k !== 'CLAUDE_PROJECT_DIR'));
  return { ...base, ...extra };
}

function makeRepo(spineRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-absent-baseline-'));
  fs.cpSync(path.join(spineRoot, 'tests', 'fixtures', 'graph', 'typescript'), dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  git('init', '-q');
  git('config', 'user.email', GIT_ENV.GIT_AUTHOR_EMAIL);
  git('config', 'user.name', GIT_ENV.GIT_AUTHOR_NAME);
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  fs.appendFileSync(path.join(dir, 'src/lib/math.ts'), 'export const sub = (a: number, b: number) => a - b;\n');
  fs.appendFileSync(path.join(dir, 'src/app.ts'), '// touch\n');
  return { dir, git, headSha: git('rev-parse', 'HEAD').trim() };
}

function runScript(spineRoot, repoDir, name, args) {
  const r = spawnSync(process.execPath, [path.join(spineRoot, 'scripts', name), ...args], { cwd: repoDir, encoding: 'utf8', env: cleanEnv({ SPINE_HOME: repoDir }) });
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Sorted POSIX paths of everything under the run folder, files and directories alike.
function listFolder(runDir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(runDir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      out.push(child);
      if (e.isDirectory()) walk(child);
    }
  };
  walk('');
  return out.sort();
}

function capture({ spineRoot, out, productContext = false }) {
  const { dir, git, headSha } = makeRepo(spineRoot);
  const runRel = path.join('.spine', RUN_ID);
  const runDir = path.join(dir, runRel);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify({ id: RUN_ID, stage: 'review', status: 'active', awaiting: null, size: 'S', host: 'claude-code' })}\n`);
  fs.writeFileSync(path.join(runDir, 'diff.patch'), git('diff'));
  fs.writeFileSync(path.join(runDir, 'classify.json'), runScript(spineRoot, dir, 'classify.js', ['--files', FILES.join(',')]));
  const tree = runScript(spineRoot, dir, 'tree.js', ['--run', runRel, '--files', FILES.join(','), '--diff', path.join(runRel, 'diff.patch'), '--base', 'HEAD']);
  // Optional orchestrator step (0.4.0 only): the bootstrap call that writes the one absent INFO record.
  if (productContext) runScript(spineRoot, dir, 'product-context.js', ['--run', runRel, '--files', FILES.join(',')]);
  const readingMap = runScript(spineRoot, dir, 'reading-map.js', ['--run', runRel]);
  fs.writeFileSync(path.join(runDir, 'review.json'), `${JSON.stringify(REVIEW)}\n`);
  fs.writeFileSync(path.join(runDir, 'pr-written.md'), WRITTEN);
  fs.writeFileSync(path.join(runDir, 'spec.md'), SPEC);
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify({ id: RUN_ID, stage: 'done', status: 'active', awaiting: null, size: 'S', host: 'claude-code' })}\n`);
  const prBody = runScript(spineRoot, dir, 'pr-body.js', ['--run', runRel]);
  fs.mkdirSync(out, { recursive: true });
  const copied = ARTIFACTS.filter((name) => fs.existsSync(path.join(runDir, name)));
  for (const name of copied) fs.copyFileSync(path.join(runDir, name), path.join(out, name));
  const records = fs.existsSync(path.join(runDir, 'records')) ? fs.readdirSync(path.join(runDir, 'records')).sort() : [];
  const recordBodies = records.map((f) => JSON.parse(fs.readFileSync(path.join(runDir, 'records', f), 'utf8')));
  const runStatus = JSON.parse(runScript(spineRoot, dir, 'run-status.js', [runRel]));
  const manifest = { head_sha: headSha, files: FILES, artifacts: copied, records, run_status: runStatus, run_folder: listFolder(runDir), outputs: { tree: JSON.parse(tree), reading_map: JSON.parse(readingMap), pr_body: JSON.parse(prBody) } };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...manifest, record_bodies: recordBodies };
}

if (require.main === module) {
  try {
    const m = capture(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, head_sha: m.head_sha, artifacts: m.artifacts, records: m.records })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { capture, RUN_ID, FILES, ARTIFACTS };
