'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BASE, ROOT, cursorRepo } = require('./helpers/cursor-repo');
const { cleanEnv } = require('./helpers/claude-cases');

const SCRIPTS = { 'stop-gate.js': 'stop gate', 'subagent-gate.js': 'subagent gate', 'session-start.js': 'session-start', 'validate-artifact.js': 'validate-artifact' };
const INPUTS = { empty: '', 'non-json': 'not json', 'non-object': '[1,2]', oversized: '{"x":"' + 'a'.repeat(1024 * 1024) + '"}' };
const KIND = { empty: 'empty', 'non-json': 'non-json', 'non-object': 'non-json', oversized: 'oversized' };

for (const [script, hook] of Object.entries(SCRIPTS)) {
  for (const [name, content] of Object.entries(INPUTS)) {
    test(`${script} exits 0 with one stderr line and no state writes on ${name} stdin`, () => {
      const r = cursorRepo({ ...BASE, stage: 'intent' });
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spine-in-')), 'stdin');
      fs.writeFileSync(file, content);
      const fd = fs.openSync(file, 'r');
      const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', cwd: r.root, env: cleanEnv({ SPINE_HOME: r.home }) });
      fs.closeSync(fd);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, `spine: ${hook} ignored ${KIND[name]} stdin\n`);
      assert.equal(fs.existsSync(path.join(r.dir, 'hooks.log')), false);
    });
  }
}
