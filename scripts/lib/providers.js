'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COUNT_BY_SIZE = { S: 1, M: 2, L: 3 };

function loadRegistry() {
  const registryPath = process.env.SPINE_REGISTRY_PATH || path.join(__dirname, '..', '..', 'providers.json');
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

function pluginOf(id) {
  return id.split(':')[0];
}

function installedPlugins(claudeHome = process.env.SPINE_CLAUDE_HOME || path.join(os.homedir(), '.claude')) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = data.plugins || data;
    return Object.keys(entries).map((k) => k.split('@')[0]);
  } catch {
    return [];
  }
}

function selectProviders(stage, size, installed, registry = loadRegistry(), lensBudget = 6) {
  const wanted = Math.min(COUNT_BY_SIZE[size] || 1, lensBudget);
  const available = (registry[stage] || [])
    .filter((p) => installed.includes(pluginOf(p.id)))
    .sort((a, b) => a.rank - b.rank);
  const chosen = [];
  const authors = new Set();
  for (const p of available) {
    if (chosen.length >= wanted) break;
    if (!authors.has(p.author)) {
      chosen.push(p);
      authors.add(p.author);
    }
  }
  for (const p of available) {
    if (chosen.length >= wanted) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen;
}

module.exports = { COUNT_BY_SIZE, loadRegistry, pluginOf, installedPlugins, selectProviders };
