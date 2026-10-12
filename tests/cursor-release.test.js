'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;

function currentEntry() {
  const text = read('CHANGELOG.md');
  const start = text.indexOf(`## ${VERSION}`);
  assert.ok(start >= 0);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? undefined : next);
}

test('every manifest carries the same version', () => {
  for (const rel of ['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    assert.equal(JSON.parse(read(rel)).version, VERSION, rel);
  }
  for (const rel of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
    for (const plugin of JSON.parse(read(rel)).plugins) assert.equal(plugin.version, VERSION, rel);
  }
});

test('README pins the current version', () => {
  const text = read('README.md');
  assert.ok(text.includes(`alpha (${VERSION})`));
  assert.ok(text.includes(`#v${VERSION}`));
});

test('every bullet in the current CHANGELOG entry names the host it affects', () => {
  const bullets = currentEntry().split('\n').filter((l) => /^- /.test(l));
  assert.ok(bullets.length > 0);
  for (const b of bullets) assert.match(b, /^- \[(claude-code|cursor|both)\] /, b);
});

test('the CHANGELOG says Cursor support is experimental and the live smoke test is pending', () => {
  const entry = currentEntry();
  assert.match(entry, /experimental/i);
  assert.match(entry, /smoke test is pending/i);
});

test('the manual Cursor smoke checklist exists with its required steps', () => {
  const text = read('docs/cursor-smoke-test.md');
  for (const needle of ['cursor-agent -p', 'hooks.log', 'Windows', 'macOS or Linux', 'intent', 'done', 'Stop cap-reached', 'Evidence']) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('CI MIN_TESTS was raised above the pre-Cursor count', () => {
  const min = Number(/MIN_TESTS: (\d+)/.exec(read('.github/workflows/ci.yml'))[1]);
  assert.ok(min > 142, `MIN_TESTS ${min} was not raised`);
});
