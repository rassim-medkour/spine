// tests/cursor-after-edit.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BASE, FIX, cursorRepo, fixture, runCursor, tmp } = require('./helpers/cursor-repo');
const { realPathInside } = require('../scripts/lib/paths');

const edit = (r, file) => runCursor('after-edit.js', { ...fixture('post-tool-use.json'), workspace_roots: [r.root], tool_input: { file_path: file } }, { SPINE_HOME: r.home });

test('an invalid artifact in the run dir yields additional_context with the count and the file', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const file = path.join(r.dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\n---\n\n# no headings\n');
  const res = edit(r, file);
  assert.equal(res.status, 0);
  const ctx = JSON.parse(res.stdout).additional_context;
  assert.match(ctx, /intent\.md has 7 problem\(s\)/);
  assert.match(ctx, /missing heading "## Problem"/);
});
test('a valid artifact writes nothing', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const file = path.join(r.dir, 'intent.md');
  fs.copyFileSync(path.join(FIX, 'artifacts', 'intent-valid.md'), file);
  assert.equal(edit(r, file).stdout, '');
});
test('a path outside the run dir writes nothing', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const file = path.join(r.root, 'README.md');
  fs.writeFileSync(file, 'hi');
  assert.equal(edit(r, file).stdout, '');
});
test('a junction or symlink inside the run dir pointing outside is skipped', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const outside = tmp('spine-outside-');
  fs.writeFileSync(path.join(outside, 'spec.md'), 'bad');
  fs.symlinkSync(outside, path.join(r.dir, 'linked'), 'junction');
  assert.equal(edit(r, path.join(r.dir, 'linked', 'spec.md')).stdout, '');
});
test('a relative file path resolves against the project root', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  fs.writeFileSync(path.join(r.dir, 'intent.md'), '---\nid: x\n---\n');
  const rel = path.relative(r.root, path.join(r.dir, 'intent.md'));
  assert.match(JSON.parse(edit(r, rel).stdout).additional_context, /intent\.md has/);
});
test('realPathInside rejects the dir itself, parents and missing files', () => {
  const d = tmp('spine-in-');
  assert.equal(realPathInside(d, d), null);
  assert.equal(realPathInside(d, path.dirname(d)), null);
  assert.equal(realPathInside(d, path.join(d, 'nope')), null);
});

test('an afterFileEdit payload (top-level file_path) is validated too', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const file = path.join(r.dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\n---\n');
  const payload = { hook_event_name: 'afterFileEdit', conversation_id: 'conv-docs-1', workspace_roots: [r.root], file_path: file, edits: [] };
  const res = runCursor('after-edit.js', payload, { SPINE_HOME: r.home });
  assert.match(JSON.parse(res.stdout).additional_context, /intent\.md has/);
});
test('afterFileEdit file_path wins over tool_input.file_path', () => {
  const r = cursorRepo({ ...BASE, stage: 'intent' });
  const file = path.join(r.dir, 'intent.md');
  fs.writeFileSync(file, '---\nid: x\n---\n');
  const payload = { workspace_roots: [r.root], file_path: file, tool_input: { file_path: path.join(r.root, 'other.md') } };
  const res = runCursor('after-edit.js', payload, { SPINE_HOME: r.home });
  assert.match(JSON.parse(res.stdout).additional_context, /intent\.md has/);
});
