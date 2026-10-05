const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

test('.gitattributes normalizes text files to LF', () => {
  assert.match(read('.gitattributes'), /^\* text=auto eol=lf$/m);
});

test('.gitignore ignores stackdumps and local tool dirs', () => {
  const lines = read('.gitignore').split(/\r?\n/);
  for (const entry of ['*.stackdump', '.spine/', '.worktrees/', '.superpowers/']) {
    assert.ok(lines.includes(entry), `.gitignore is missing ${entry}`);
  }
});

test('no stackdump is tracked', () => {
  assert.deepEqual(trackedFiles().filter((f) => f.endsWith('.stackdump')), []);
});

// Patterns are built from fragments so this file never matches itself.
const USER = ['ras', 'si'].join('');
const PERSONAL_PATH = new RegExp(
  [`[A-Za-z]:[\\\\/]Users[\\\\/]${USER}`, ['/c', 'Users', ''].join('/'), `/Users/${USER}`, `/home/${USER}`].join('|'),
  'i',
);
const WORK_TRACE = new RegExp([['allo', 'sylvia'].join(''), ['services', 'main'].join('/'), ['appoint', 'ments'].join('')].join('|'), 'i');
// .mailmap must name the old author addresses to remap them; they are already public in history.
const SCAN_ALLOW = new Set(['.mailmap']);
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf)$/i;

function scan(pattern) {
  const hits = [];
  for (const file of trackedFiles()) {
    if (SCAN_ALLOW.has(file) || BINARY.test(file) || !fs.existsSync(path.join(ROOT, file))) continue;
    read(file).split(/\r?\n/).forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  return hits;
}

test('no personal absolute paths in tracked files', () => {
  assert.deepEqual(scan(PERSONAL_PATH), []);
});

test('no work-project traces in tracked files', () => {
  assert.deepEqual(scan(WORK_TRACE), []);
});

test('design spec kept under docs/design, ring-1 plan removed', () => {
  const files = trackedFiles();
  assert.ok(files.includes('docs/design/spine-plugin-design.md'));
  assert.deepEqual(files.filter((f) => f.startsWith('docs/superpowers/')), []);
});

// Checks only the maintainer's own addresses listed in .mailmap, so commits by
// other contributors never fail this test.
test('.mailmap remaps every listed maintainer address to the public identity', () => {
  const PUBLIC = 'Rassim Medkour <23105160+rassim-medkour@users.noreply.github.com>';
  const addresses = read('.mailmap')
    .split(/\r?\n/)
    .flatMap((line) => [...line.matchAll(/<([^>]+)>/g)].map((m) => m[1]));
  assert.ok(addresses.length >= 3, '.mailmap lists the public and both old addresses');
  for (const address of new Set(addresses)) {
    const mapped = execFileSync('git', ['check-mailmap', `<${address}>`], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(mapped, PUBLIC, `${address} is not remapped`);
  }
});

const { loadRegistry, pluginOf } = require('../scripts/lib/providers');

function between(text, start, end) {
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  assert.ok(i >= 0 && j > i, `README is missing ${start} ... ${end}`);
  return text.slice(i + start.length, j);
}

function tableRows(block) {
  return block.split(/\r?\n/).filter((l) => /^\|\s*`[^`]+`\s*\|/.test(l));
}

test('README is labelled alpha 0.1.0 near the top', () => {
  const head = read('README.md').split(/\r?\n/).slice(0, 30).join('\n');
  assert.match(head, /alpha/i);
  assert.match(head, /0\.1\.0/);
});

test('README install uses the GitHub marketplace', () => {
  const text = read('README.md');
  assert.match(text, /claude plugin marketplace add rassim-medkour\/spine/);
  assert.match(text, /claude plugin install spine@spine/);
  assert.match(text, /claude plugin uninstall spine@spine/);
  assert.match(text, /v0\.1\.0/);
});

test('README required dependency rows equal providers.json plugins', () => {
  const rows = tableRows(between(read('README.md'), '<!-- deps:required:start -->', '<!-- deps:required:end -->'));
  const names = rows.map((r) => r.match(/^\|\s*`([^`]+)`/)[1]).sort();
  const expected = [...new Set(Object.values(loadRegistry()).flat().map((p) => pluginOf(p.id)))].sort();
  assert.deepEqual(names, expected);
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 4, `row needs 4 cells: ${row}`);
    assert.match(cells[1], /claude plugin install \S+@\S+/);
    assert.ok(cells[3].length > 0, `missing degradation note: ${row}`);
  }
});

test('README lists i-have-adhd as optional, not required', () => {
  const optional = between(read('README.md'), '<!-- deps:optional:start -->', '<!-- deps:optional:end -->');
  assert.match(optional, /`i-have-adhd`/);
});

test('README and SKILL.md agree on the Workflow-tool fallback', () => {
  assert.match(read('README.md'), /workflow tool unavailable, ran inline/);
  assert.match(read('skills/spine/SKILL.md'), /workflow tool unavailable, ran inline/);
});

test('README documents hooks, escape hatch and issue reporting', () => {
  const text = read('README.md');
  for (const needle of ['SessionStart', 'SubagentStop', 'PostToolUse', '"strictness": "warn"', 'github.com/rassim-medkour/spine/issues']) {
    assert.ok(text.includes(needle), `README is missing ${needle}`);
  }
  assert.match(text, /itself errors[\s\S]{0,120}spine:/);
  assert.ok(text.includes('"src/payments/**"'));
});

test('README documents the Workflow tool, safety and operations sections', () => {
  const text = read('README.md');
  for (const needle of ['## What this plugin runs', '## Contributing', 'acceptEdits', '~/.spine/config.json', 'Node 22']) {
    assert.ok(text.includes(needle), `README is missing ${needle}`);
  }
  assert.match(text, /Workflow tool/);
});

test('CHANGELOG has a 0.1.0 entry with known limitations', () => {
  const text = read('CHANGELOG.md');
  assert.match(text, /^## 0\.1\.0/m);
  assert.match(text, /known limitations/i);
});

test('CI runs npm test on 3 OSes with Node 22, read-only', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.match(ci, new RegExp(os));
  assert.match(ci, /actions\/checkout@v\d+/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /actions\/setup-node@v\d+/);
  assert.match(ci, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(ci, /'22'/);
  assert.match(ci, /node: '24'/);
  assert.match(ci, /branches: \[master\]/);
  assert.match(ci, /^\s*pull_request:/m);
  assert.match(ci, /permissions:\s*\n\s+contents: read/);
  assert.match(ci, /MIN_TESTS: \d+/);
  assert.match(ci, /-lt "\$MIN_TESTS"/);
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.doesNotMatch(ci, /secrets\./);
});
