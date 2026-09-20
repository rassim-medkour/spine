'use strict';
const path = require('node:path');
const { loadConfig } = require('./lib/state');
const { churnCounts } = require('./lib/churn');

const SERVICE_ROOTS = new Set(['services', 'apps', 'packages']);
const SECURITY_RE = /(auth|login|password|token|secret|upload|payment|billing|crypto)/i;
const DATABASE_RE = /(migrat|schema|\.sql$)/i;
const CHURN_CRITICAL = 20;
const LANG_BY_EXT = { '.py': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.go': 'go', '.rs': 'rust' };

function globToRegExp(glob) {
  const tokens = glob.split(/(\*\*\/|\*\*|\*|\?)/);
  const pattern = tokens
    .map((tok) => {
      if (tok === '**/') return '(?:.*/)?';
      if (tok === '**') return '.*';
      if (tok === '*') return '[^/]*';
      if (tok === '?') return '[^/]';
      return tok.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`);
}

function normalize(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function countServices(files) {
  const names = new Set();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length > 1 && SERVICE_ROOTS.has(parts[0])) names.add(parts[1]);
  }
  return Math.max(1, names.size);
}

function isLowRisk(file) {
  return file.startsWith('docs/') || file.startsWith('tests/') || file.endsWith('.md');
}

function sizeOf(files, services, migration, newSubsystem) {
  if (migration || newSubsystem || files.length > 12 || services > 2) return 'L';
  if (files.length <= 3 && services <= 1) return 'S';
  return 'M';
}

function blastRadius(files, config, churnFn) {
  const patterns = (config.critical_paths || []).map(globToRegExp);
  const critical = files.some((f) => patterns.some((re) => re.test(f)) || churnFn(f) >= CHURN_CRITICAL);
  if (critical) return 'critical';
  if (files.length && files.every(isLowRisk)) return 'low';
  return 'normal';
}

function lensesFor(files, radius) {
  const lenses = new Set(['correctness']);
  if (radius === 'critical' || files.some((f) => SECURITY_RE.test(f))) lenses.add('security');
  for (const f of files) {
    const ext = path.extname(f);
    if (LANG_BY_EXT[ext]) lenses.add(LANG_BY_EXT[ext]);
    if (ext === '.tsx' || ext === '.jsx') lenses.add('react');
    if (DATABASE_RE.test(f)) lenses.add('database');
  }
  return [...lenses];
}

function classify(input, config, churnFn) {
  const files = (input.files || []).map(normalize);
  const migration = Boolean(input.migration) || files.some((f) => /migrat/i.test(f));
  const services = countServices(files);
  const size = sizeOf(files, services, migration, Boolean(input.new_subsystem));
  const radius = blastRadius(files, config, churnFn);
  const lensBudget = config.lens_budget || 6;
  return {
    size,
    blast_radius: radius,
    signals: { files: files.length, services, migration, new_subsystem: Boolean(input.new_subsystem) },
    lenses: lensesFor(files, radius).slice(0, lensBudget),
    devils_advocate: size === 'L' || radius === 'critical',
    workflows: { spec: size === 'L', implement: size !== 'S', review: size !== 'S' },
  };
}

function parseArgs(argv) {
  const out = { files: [], migration: false, new_subsystem: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') out.files = (argv[++i] || '').split(',').filter(Boolean);
    else if (argv[i] === '--migration') out.migration = true;
    else if (argv[i] === '--new-subsystem') out.new_subsystem = true;
  }
  return out;
}

if (require.main === module) {
  const cwd = process.cwd();
  const input = parseArgs(process.argv.slice(2));
  const files = (input.files || []).map(normalize);
  const counts = churnCounts(files, cwd);
  const result = classify(input, loadConfig(cwd), (f) => counts.get(f) || 0);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { classify, globToRegExp };
