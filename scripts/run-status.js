'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./lib/state');

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
  return { host: HOSTS.includes(state.host) ? state.host : 'unknown', hooks, cap_reached: capReached, last_hook: lastHook };
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
