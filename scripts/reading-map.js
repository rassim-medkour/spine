'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, readJson } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { tierConfig } = require('./lib/tier-config');
const { parseDiff } = require('./lib/diff');
const { validateTree } = require('./lib/validate');
const { buildReadingMap, renderReadingMap, summarize } = require('./lib/reading-map');
const { checkProof } = require('./check-proof');
const { rollbackAnswer } = require('./lib/proof');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function rollbackLine(proof, tier) {
  if (!proof.required.includes('rollback_or_flag_plan')) return `not required for tier ${tier}`;
  const gap = proof.missing.find((m) => m.requirement === 'rollback_or_flag_plan');
  return gap ? `missing: ${gap.reason}` : 'passed the mechanical check; confirm it in review.md ## Rollback';
}

function withRollbackAnswer(tree, proof, records) {
  const knob = tree.knobs && tree.knobs.instant_rollback;
  if (!knob) return tree.knobs;
  return { ...tree.knobs, instant_rollback: { ...knob, answer: rollbackAnswer(tree, proof, records) } };
}

function readingMap({ runDir, root, tc }) {
  const diffPath = path.join(runDir, 'diff.patch');
  if (!fs.existsSync(diffPath)) throw new Error('diff.patch missing: save the reviewed diff to <run>/diff.patch first');
  const treePath = path.join(runDir, 'tree.json');
  if (!tc.enabled || !fs.existsSync(treePath)) return { ok: true, skipped: 'no tree.json' };
  const treeBuf = fs.readFileSync(treePath);
  const tree = JSON.parse(treeBuf.toString('utf8'));
  const problems = validateTree(tree);
  if (problems.length) throw new Error(`tree.json invalid: ${problems.length} problem(s)`);
  const diffBuf = fs.readFileSync(diffPath);
  const records = listRecords(runDir).map((r) => r.record);
  const proof = checkProof({ runDir, root, tree, records, tc });
  const map = buildReadingMap({ diffFiles: parseDiff(diffBuf.toString('utf8')), tree, records, proof, tc });
  const review = readJson(path.join(runDir, 'review.json')) || {};
  const meta = {
    runId: path.basename(runDir), diffSha: sha(diffBuf), treeSha: sha(treeBuf),
    stale: sha(diffBuf) !== tree.inputs.diff_sha256, tier: tree.tier, verdict: review.verdict,
    knobs: withRollbackAnswer(tree, proof, records), rollback: rollbackLine(proof, tree.tier),
    relPath: path.relative(fs.realpathSync(root), path.join(fs.realpathSync(runDir), 'reading-map.md')).replace(/\\/g, '/'),
  };
  fs.writeFileSync(path.join(runDir, 'reading-map.md'), renderReadingMap(map, meta));
  fs.writeFileSync(path.join(runDir, 'reading-map.json'), `${JSON.stringify({ meta, groups: map.groups, totals: map.totals }, null, 2)}\n`);
  return summarize(map, meta);
}

if (require.main === module) {
  let result;
  try {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--run');
    if (i < 0 || !argv[i + 1]) throw new Error('usage: reading-map.js --run <run dir>');
    const root = process.cwd();
    result = readingMap({ runDir: path.resolve(root, argv[i + 1]), root, tc: tierConfig(loadConfig(root)) });
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { readingMap };
