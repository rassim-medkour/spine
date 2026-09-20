'use strict';
const { spawnSync } = require('node:child_process');

function churn(file, cwd = process.cwd()) {
  const r = spawnSync('git', ['log', '--since=90.days', '--oneline', '--', file], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return 0;
  return r.stdout.split(/\r?\n/).filter(Boolean).length;
}

// One `git log` pass for every file instead of one subprocess per file.
// A matching commit's --name-only listing can include files outside `files`
// (any file that commit touched), so counts are filtered back to `files`.
function churnCounts(files, cwd = process.cwd()) {
  const counts = new Map(files.map((f) => [f, 0]));
  if (files.length === 0) return counts;
  const r = spawnSync('git', ['log', '--since=90.days', '--name-only', '--pretty=format:', '--', ...files], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return counts;
  const wanted = new Set(files);
  for (const line of r.stdout.split(/\r?\n/)) {
    const f = line.trim();
    if (f && wanted.has(f)) counts.set(f, counts.get(f) + 1);
  }
  return counts;
}

module.exports = { churn, churnCounts };
