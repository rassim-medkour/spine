'use strict';
// usage: review-worktree.js --run <run dir> (--pr <n> | --branch <name>) [--remote origin]
//        review-worktree.js --run <run dir> --remove
const path = require('node:path');
const { prepareWorktree, removeWorktree } = require('./lib/worktree');

const USAGE = 'usage: review-worktree.js --run <run dir> (--pr <n> | --branch <name>) [--remote <name>] | --run <run dir> --remove';

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

function main(argv, root = process.cwd()) {
  const runArg = flag(argv, '--run');
  if (!runArg) throw new Error(USAGE);
  const runDir = path.resolve(root, runArg);
  if (argv.includes('--remove')) {
    removeWorktree({ root, runDir });
    return { removed: true };
  }
  return prepareWorktree({ root, runDir, pr: flag(argv, '--pr'), branch: flag(argv, '--branch'), remote: flag(argv, '--remote') || 'origin' });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (e) {
    process.stderr.write(`spine: review-worktree: ${String((e && e.message) || e).slice(0, 300)}\n`);
    process.exit(1);
  }
}

module.exports = { main };
