'use strict';
// usage: review-comment.js --run <run dir> [--repo owner/name]
// Writes <run>/review-comment.md. It never posts: the skill asks the human
// first, then posts the file with gh.
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { buildReviewComment } = require('./lib/review-comment');

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

function main(argv, root = process.cwd()) {
  const runArg = flag(argv, '--run');
  if (!runArg) throw new Error('usage: review-comment.js --run <run dir> [--repo owner/name]');
  const runDir = path.resolve(root, runArg);
  const review = readJson(path.join(runDir, 'review.json'));
  if (!review) throw new Error('review.json missing: finish the review first');
  const worktree = readJson(path.join(runDir, 'worktree.json'));
  const body = buildReviewComment({
    review,
    records: listRecords(runDir).map((r) => r.record),
    readingMap: readJson(path.join(runDir, 'reading-map.json')),
    proof: readJson(path.join(runDir, 'proof.json')),
    repo: flag(argv, '--repo'),
    sha: worktree && worktree.sha,
  });
  const out = path.join(runDir, 'review-comment.md');
  fs.writeFileSync(out, body);
  return { path: out, chars: body.length };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (e) {
    process.stderr.write(`spine: review-comment: ${String((e && e.message) || e).slice(0, 300)}\n`);
    process.exit(1);
  }
}

module.exports = { main };
