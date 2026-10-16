'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, RUN_ID_RE } = require('./lib/state');
const { tierConfig } = require('./lib/tier-config');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function saveEvidence({ runDir, from, name, cap }) {
  if (!runDir || !RUN_ID_RE.test(path.basename(runDir)) || !fs.existsSync(path.join(runDir, 'state.json'))) throw new Error('--run must be an existing run directory');
  if (!NAME_RE.test(name || '') || name.includes('..')) throw new Error('--name must be a plain file name');
  const src = fs.readFileSync(from);
  const truncated = src.length > cap;
  const marker = Buffer.from(`\n[spine: truncated at ${cap} of ${src.length} bytes]\n`);
  const body = truncated ? Buffer.concat([src.subarray(0, Math.max(0, cap - marker.length)), marker]) : src;
  const dir = path.join(runDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, { flag: 'wx' });
  return { ok: true, path: `evidence/${name}`, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, truncated, original_bytes: src.length };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  let result;
  try {
    const argv = process.argv.slice(2);
    const cap = tierConfig(loadConfig(process.cwd())).evidence_cap_bytes;
    result = saveEvidence({ runDir: flag(argv, '--run'), from: flag(argv, '--from'), name: flag(argv, '--name'), cap });
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { saveEvidence };
