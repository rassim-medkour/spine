const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STALE_COMMAND = /\/spine (intent|adopt|implement|review|status|resume)\b/;

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// Recursively collect files under `dir` (relative to ROOT) whose basename
// matches `nameMatch`. No third-party deps — just fs.readdirSync.
function findFiles(dir, nameMatch) {
  const abs = path.join(ROOT, dir);
  const found = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(relPath, nameMatch));
    } else if (nameMatch(entry.name)) {
      found.push(relPath);
    }
  }
  return found;
}

function docFiles() {
  const files = [
    'README.md',
    ...findFiles('skills', (name) => name === 'SKILL.md'),
    ...findFiles('agents', (name) => name.endsWith('.md')),
    'commands/spine.md',
    'tests/fixtures/dogfood/README.md',
  ];
  return [...new Set(files)];
}

for (const relPath of docFiles()) {
  test(`${relPath} has no un-namespaced /spine subcommand reference`, () => {
    const text = relPath === 'commands/spine.md' ? stripFrontmatter(read(relPath)) : read(relPath);
    assert.doesNotMatch(text, STALE_COMMAND);
  });
}

test('README.md documents the namespaced /spine:spine review command', () => {
  assert.match(read('README.md'), /\/spine:spine review/);
});

test('skills/spine/SKILL.md documents the namespaced /spine:spine review command', () => {
  assert.match(read('skills/spine/SKILL.md'), /\/spine:spine review/);
});
