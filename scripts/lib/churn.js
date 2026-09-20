'use strict';
const { spawnSync } = require('node:child_process');

function churn(file, cwd = process.cwd()) {
  const r = spawnSync('git', ['log', '--since=90.days', '--oneline', '--', file], { cwd, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return 0;
  return r.stdout.split(/\r?\n/).filter(Boolean).length;
}

module.exports = { churn };
