'use strict';
// Manual benchmark, never run by npm test. Usage: node tests/bench/tree-bench.js [files]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSyntheticRepo } = require('../helpers/synthetic-repo');
const { buildGraph } = require('../../scripts/lib/graph');

const n = Number(process.argv[2] || 10000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-bench-'));
const ms = (a, b) => Number(b - a) / 1e6;
try {
  const paths = makeSyntheticRepo(dir, { files: n });
  const t0 = process.hrtime.bigint();
  const files = paths.map((p) => ({ path: p, text: fs.readFileSync(path.join(dir, p), 'utf8') }));
  const t1 = process.hrtime.bigint();
  const graph = buildGraph({ files, hints: { goModules: [{ module: 'example.com/syn', dir: '' }], pyRoots: [''] } });
  const t2 = process.hrtime.bigint();
  process.stdout.write(`${JSON.stringify({ files: n, read_ms: ms(t0, t1), graph_ms: ms(t1, t2), sample_fan_in: graph.fanIn(paths[1]).value })}\n`);

  if (process.argv.includes('--tree')) {
    const { buildTree } = require('../../scripts/tree');
    const { tierConfig } = require('../../scripts/lib/tier-config');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-bench-tree-'));
    try {
      const paths = makeSyntheticRepo(repo, { files: n, git: true });
      const tc = tierConfig({ tiers: { tree_budget_ms: 600000, tree_max_files: 100000 } });
      const once = () => {
        const t = process.hrtime.bigint();
        buildTree({ root: repo, files: [paths[1]], tc });
        return ms(t, process.hrtime.bigint());
      };
      process.stdout.write(`${JSON.stringify({ files: n, tree_cold_ms: once(), tree_warm_ms: once() })}\n`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
