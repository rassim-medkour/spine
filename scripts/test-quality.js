'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseDiff, addedLineSet } = require('./lib/diff');
const { TEST_FILE } = require('./lib/graph');
const { findHollowTests } = require('./lib/test-quality');
const { readJson } = require('./lib/state');

function hollowRecords({ runDir, root }) {
  const diffText = fs.readFileSync(path.join(runDir, 'diff.patch'), 'utf8');
  const tree = readJson(path.join(runDir, 'tree.json'));
  const revision = tree && tree.inputs ? `${tree.inputs.head_sha}:${tree.inputs.diff_sha256}` : 'none';
  const files = parseDiff(diffText).filter((f) => f.status !== 'deleted' && TEST_FILE.test(f.path));
  const flags = files.flatMap((f) => {
    let text = null;
    try {
      text = fs.readFileSync(path.join(root, f.path), 'utf8');
    } catch {
      text = null;
    }
    return findHollowTests(f.path, text, f.status === 'added' ? null : addedLineSet(f)).map((x) => ({ ...x, path: f.path }));
  });
  const command = `node scripts/test-quality.js --run ${path.relative(root, runDir).replace(/\\/g, '/')}`;
  const proof = {
    stage: 'review', agent: 'spine:test-quality', claim: `test-quality check: ${flags.length} hollow test(s) in ${files.length} changed test file(s)`,
    evidence: [{ kind: 'command', ref: command }], confidence: 1, severity: 'INFO',
    proof_kind: 'test_quality', revision, scope: ['*'], result: { command, exit_code: 0, status: 'ok' },
  };
  const flagged = flags.map((x) => ({
    stage: 'review', agent: 'spine:test-quality', claim: `hollow test: ${x.rule}`,
    evidence: [{ kind: 'file', ref: `${x.path}:${x.line}` }], confidence: 0.7, severity: 'MEDIUM', hollow_rule: x.rule,
  }));
  return [proof, ...flagged];
}

if (require.main === module) {
  let result;
  try {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--run');
    if (i < 0 || !argv[i + 1]) throw new Error('usage: test-quality.js --run <run dir>');
    result = hollowRecords({ runDir: path.resolve(argv[i + 1]), root: process.cwd() });
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { hollowRecords };
