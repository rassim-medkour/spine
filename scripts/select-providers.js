'use strict';
const { selectProviders, loadRegistry } = require('./lib/providers');
const { installedProviders } = require('./lib/cursor-providers');
const { loadConfig } = require('./lib/state');

const HOSTS = ['claude', 'cursor'];

function parseArgs(argv) {
  const positional = [];
  let host = 'claude';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = argv[++i];
    else positional.push(argv[i]);
  }
  return { stage: positional[0], size: positional[1], host };
}

const { stage, size, host } = parseArgs(process.argv.slice(2));
if (!stage || !size || !HOSTS.includes(host)) {
  process.stderr.write('usage: select-providers.js <spec|plan|implement|review> <S|M|L> [--host claude|cursor]\n');
  process.exit(1);
}
const config = loadConfig(process.cwd());
const selected = selectProviders(stage, size, installedProviders(host), loadRegistry(host), config.lens_budget);
process.stdout.write(JSON.stringify(selected, null, 2) + '\n');
