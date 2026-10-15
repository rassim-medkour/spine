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
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
