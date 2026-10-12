'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readHookInput } = require('../scripts/lib/hook-io');

test('readHookInput parses a BOM-prefixed payload and treats BOM-only as empty', () => {
  assert.deepEqual(readHookInput('﻿{"a":1}'), { a: 1 });
  assert.deepEqual(readHookInput('﻿'), {});
});

test('readGuardedInput accepts a BOM-prefixed payload and ignores BOM-only stdin', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spine-bom-')), 'in');
  const probe = (content) => {
    fs.writeFileSync(file, content);
    const code = `const {readGuardedInput}=require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib', 'hook-io.js'))});` +
      `const fd=require('fs').openSync(${JSON.stringify(file)},'r');console.log(JSON.stringify(readGuardedInput('t',fd)));`;
    return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  };
  const ok = probe('﻿{"cwd":"/x"}');
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { cwd: '/x' });
  const empty = probe('﻿');
  assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /ignored empty stdin/);
});
