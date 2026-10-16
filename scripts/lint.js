'use strict';
// Static check: `node --check` on every tracked .js file under scripts/ and tests/.
// workflows/*.js are skipped on purpose: they are ESM fragments (export const meta)
// that node --check cannot parse as CommonJS; scripts/lib/workflow-lint.js covers them.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHECKED = /^(scripts|tests)\/.+\.js$/;

function trackedFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter((f) => CHECKED.test(f));
}

function lint(root) {
  const files = trackedFiles(root);
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, checked: files.indexOf(file) + 1, total: files.length, file, message: (r.stderr || '').trim() };
  }
  return { ok: true, checked: files.length, total: files.length };
}

function main(argv) {
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.resolve(__dirname, '..');
  const result = lint(root);
  if (!result.ok) {
    process.stderr.write(`${result.message}\nlint failed: ${result.file}\n`);
    return 1;
  }
  process.stdout.write(`lint ok: ${result.checked} files syntax-checked (scripts/, tests/)\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { lint, trackedFiles };
