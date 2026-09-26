'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./lib/validate');

const SKILL_REL = '.claude/skills/verify';

function normalize(file) {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!f || f.startsWith('/') || /^[a-zA-Z]:/.test(f) || f.split('/').includes('..')) return null;
  return f;
}

function isVerifySkill(skillDir) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
    return Boolean(fm && fm.name === 'verify');
  } catch {
    return false;
  }
}

function featuresOf(skillDir) {
  try {
    return fs.readdirSync(path.join(skillDir, 'features'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

// Nearest project-local verify skill for one repo-relative file, walking up to the root.
function nearestSkill(file, repoRoot, cache) {
  let dir = path.posix.dirname(file);
  for (;;) {
    const rel = dir === '.' ? SKILL_REL : `${dir}/${SKILL_REL}`;
    if (!cache.has(rel)) cache.set(rel, isVerifySkill(path.join(repoRoot, rel)));
    if (cache.get(rel)) return rel;
    if (dir === '.') return null;
    dir = path.posix.dirname(dir);
  }
}

function findVerifySkills(changedFiles, repoRoot) {
  const cache = new Map();
  const groups = new Map();
  for (const raw of changedFiles) {
    const file = normalize(raw);
    if (!file) continue;
    const skillDir = nearestSkill(file, repoRoot, cache);
    if (!skillDir) continue;
    if (!groups.has(skillDir)) groups.set(skillDir, []);
    groups.get(skillDir).push(file);
  }
  return [...groups.entries()].map(([skillDir, covers]) => ({
    skillDir,
    skillFile: `${skillDir}/SKILL.md`,
    covers,
    features: featuresOf(path.join(repoRoot, skillDir)),
  }));
}

if (require.main === module) {
  const i = process.argv.indexOf('--files');
  const files = i >= 0 ? (process.argv[i + 1] || '').split(',').filter(Boolean) : [];
  const skills = findVerifySkills(files, process.cwd());
  process.stdout.write(JSON.stringify({ found: skills.length > 0, skills }, null, 2) + '\n');
}

module.exports = { findVerifySkills };
