'use strict';
const { pluginOf } = require('./providers');

function pluginNameOf(provider) {
  return provider.plugin || pluginOf(provider.id);
}

function missingFrom(registry, installed) {
  const have = new Set(installed);
  const needed = new Set();
  for (const list of Object.values(registry)) for (const p of list) needed.add(pluginNameOf(p));
  return [...needed].filter((n) => !have.has(n)).sort();
}

function missingPluginsLine(missing) {
  return `spine: missing plugins: ${missing.join(', ')}. Affected providers will be skipped.`;
}

function activeRunLine(run, statusCommand) {
  return `spine: active run ${run.id} at stage ${run.state.stage}, awaiting ${run.state.awaiting || 'none'}. Run ${statusCommand} to resume.`;
}

function buildSessionLines({ missing = [], run = null, statusCommand = '/spine:spine status', extra = [] } = {}) {
  const lines = [];
  if (missing.length) lines.push(missingPluginsLine(missing));
  if (run) lines.push(activeRunLine(run, statusCommand));
  return [...lines, ...extra];
}

module.exports = { pluginNameOf, missingFrom, missingPluginsLine, activeRunLine, buildSessionLines };
