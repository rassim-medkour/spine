'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, readJson } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { tierConfig } = require('./lib/tier-config');
const { parseDiff } = require('./lib/diff');
const { buildPrBody } = require('./lib/pr-body');
const { checkProof } = require('./check-proof');

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function assumptions(specText) {
  const m = /^## Assumptions\s*$/m.exec(specText);
  if (!m) return [];
  const rest = specText.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).replace(/\*\*/g, '').trim()).slice(0, 5);
}

function loadData(runDir, root, tc) {
  const state = readJson(path.join(runDir, 'state.json'));
  if (!state || state.stage !== 'done') throw new Error('pr-body.js runs after G3 approval (state.json stage must be done)');
  const review = readJson(path.join(runDir, 'review.json'));
  if (!review) throw new Error('review.json missing');
  const tree = readJson(path.join(runDir, 'tree.json'));
  const records = listRecords(runDir).map((r) => r.record);
  return {
    tier: (tree && tree.tier) || review.tier || 'branch',
    runRel: path.relative(root, runDir).replace(/\\/g, '/'),
    diffFiles: parseDiff(readText(path.join(runDir, 'diff.patch'))),
    tree, review, records,
    proof: tree ? checkProof({ runDir, root, tree, records, tc }) : null,
    readingMap: readJson(path.join(runDir, 'reading-map.json')),
    planText: ['review.md', 'plan.md'].map((n) => readText(path.join(runDir, n))).join('\n'),
    specAssumptions: assumptions(readText(path.join(runDir, 'spec.md'))),
  };
}

function main(argv, root = process.cwd()) {
  const at = (flag) => (argv.indexOf(flag) >= 0 ? argv[argv.indexOf(flag) + 1] : undefined);
  if (!at('--run')) throw new Error('usage: pr-body.js --run <run dir> [--written <file>]');
  const runDir = path.resolve(root, at('--run'));
  const writtenPath = at('--written') ? path.resolve(root, at('--written')) : path.join(runDir, 'pr-written.md');
  const result = buildPrBody(loadData(runDir, root, tierConfig(loadConfig(root))), readText(writtenPath));
  if (result.ok) fs.writeFileSync(path.join(runDir, 'pr-body.md'), result.body);
  return { ok: result.ok, tier: result.tier, sections: result.sections, errors: result.errors, path: result.ok ? path.relative(root, path.join(runDir, 'pr-body.md')).replace(/\\/g, '/') : null };
}

if (require.main === module) {
  let result;
  try {
    result = main(process.argv.slice(2));
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { main };
