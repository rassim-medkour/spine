'use strict';
const { selectProviders, installedPlugins } = require('./lib/providers');
const { loadConfig } = require('./lib/state');

const [stage, size] = process.argv.slice(2);
if (!stage || !size) {
  process.stderr.write('usage: select-providers.js <spec|plan|implement|review> <S|M|L>\n');
  process.exit(1);
}
const config = loadConfig(process.cwd());
const selected = selectProviders(stage, size, installedPlugins(), undefined, config.lens_budget);
process.stdout.write(JSON.stringify(selected, null, 2) + '\n');
