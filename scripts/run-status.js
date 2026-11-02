'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./lib/state');
const { listRecords } = require('./lib/records');
const { computeMix, mixLine } = require('./lib/model-mix');
const { isCapped } = require('./lib/cap-record');

const CAP_ROLES = Object.freeze({ 'spine:product-lens': 'product_lens', 'spine:ux-finder': 'ux_finder' });

// Counts product-role records and how many the citation cap fired on, per role.
function capSummary(records, productState) {
  const total = {};
  const fired = { product_lens: 0, ux_finder: 0 };
  for (const rec of records) {
    const role = rec && CAP_ROLES[rec.agent];
    if (!role) continue;
    total[role] = (total[role] || 0) + 1;
    if (isCapped(rec)) fired[role] += 1;
  }
  const parts = Object.keys(fired).filter((role) => fired[role] > 0)
    .map((role) => `${fired[role]} of ${total[role]} ${role} findings uncited`);
  const suffix = productState === 'ok' || productState === 'trimmed' ? '' : ', no product.md';
  return { fired, line: parts.length ? `product cap: ${parts.join(', ')}${suffix}` : null, any: Object.keys(total).length > 0 };
}

const HOSTS = ['cursor', 'claude-code'];
const LINE = /^(\S+) (\S+) (\S+)(.*)$/;

function runStatus(runDir) {
  const state = readJson(path.join(runDir, 'state.json')) || {};
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(runDir, 'hooks.log'), 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    lines = [];
  }
  const hooks = {};
  let capReached = false;
  let lastHook = null;
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    const hostMatch = /\bhost=(\S+)/.exec(m[4]);
    const host = hostMatch && HOSTS.includes(hostMatch[1]) ? hostMatch[1] : 'claude-code';
    const key = `${host} ${m[2]}`;
    hooks[key] = (hooks[key] || 0) + 1;
    if (m[2] === 'Stop' && m[3] === 'cap-reached') capReached = true;
    lastHook = m[1];
  }
  const records = listRecords(runDir).map((r) => r.record);
  const mix = computeMix(records);
  const product = readJson(path.join(runDir, 'product.json'));
  const caps = capSummary(records, product && product.state);
  return {
    host: HOSTS.includes(state.host) ? state.host : 'unknown',
    hooks,
    cap_reached: capReached,
    last_hook: lastHook,
    ...(caps.any ? { cap_fired: caps.fired } : {}),
    ...(caps.line ? { cap_line: caps.line } : {}),
    ...(mix ? { model_mix: { ...mix, line: mixLine(mix) } } : {})
  };
}

if (require.main === module) {
  const runDir = process.argv[2];
  if (!runDir) {
    process.stderr.write('usage: run-status.js <run-dir>\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(runStatus(runDir), null, 2) + '\n');
}

module.exports = { runStatus };
