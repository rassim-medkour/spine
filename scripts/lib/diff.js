'use strict';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HEADER_RE = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/;

function unquote(p) {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

function sidePath(raw) {
  const p = unquote(raw.trim());
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '').replace(/\\/g, '/');
}

function finalize(f) {
  const hunks = f.hunks.map(({ oldLeft, newLeft, ...h }) => h);
  const p = (f.status === 'deleted' ? f.oldPath : f.path) || f.oldPath;
  return { path: p ? p.replace(/\\/g, '/') : null, oldPath: f.oldPath ? f.oldPath.replace(/\\/g, '/') : null, status: f.status, binary: f.binary, hunks };
}

// Inside a hunk the remaining line counts decide what a line is, so a removed
// line whose text starts with "-- " is never mistaken for a "--- " header.
function bodyLine(state, line) {
  const h = state.hunk;
  if (!h || (h.oldLeft <= 0 && h.newLeft <= 0)) return false;
  const c = line[0];
  if (c === '+') {
    h.added.push({ line: state.newLine++, text: line.slice(1) });
    h.newLeft--;
  } else if (c === '-') {
    h.removed.push({ line: state.oldLine++, text: line.slice(1) });
    h.oldLeft--;
  } else if (c === ' ' || line === '') {
    state.oldLine++;
    state.newLine++;
    h.oldLeft--;
    h.newLeft--;
  } else {
    return false;
  }
  return true;
}

function startHunk(state, m) {
  const oldLines = m[2] === undefined ? 1 : Number(m[2]);
  const newLines = m[4] === undefined ? 1 : Number(m[4]);
  state.hunk = { oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, added: [], removed: [], oldLeft: oldLines, newLeft: newLines };
  state.file.hunks.push(state.hunk);
  state.oldLine = Number(m[1]);
  state.newLine = Number(m[3]);
}

function headerLine(state, line) {
  const f = state.file;
  if (line.startsWith('new file mode')) f.status = 'added';
  else if (line.startsWith('deleted file mode')) f.status = 'deleted';
  else if (line.startsWith('rename from ')) {
    f.oldPath = line.slice(12);
    f.status = 'renamed';
  } else if (line.startsWith('rename to ')) f.path = line.slice(10);
  else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) f.binary = true;
  else if (line.startsWith('--- ')) {
    const p = sidePath(line.slice(4));
    if (p) f.oldPath = p;
  } else if (line.startsWith('+++ ')) {
    const p = sidePath(line.slice(4));
    if (p) f.path = p;
    else f.status = 'deleted';
  } else {
    const m = HUNK_RE.exec(line);
    if (m) startHunk(state, m);
  }
}

function parseDiff(text) {
  const files = [];
  const state = { file: null, hunk: null, oldLine: 0, newLine: 0 };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      if (state.file) files.push(finalize(state.file));
      const m = HEADER_RE.exec(line);
      state.file = { oldPath: m ? m[1] : null, path: m ? m[2] : null, status: 'modified', binary: false, hunks: [] };
      state.hunk = null;
      continue;
    }
    if (!state.file || line.startsWith('\\ ')) continue;
    if (bodyLine(state, line)) continue;
    headerLine(state, line);
  }
  if (state.file) files.push(finalize(state.file));
  return files.filter((f) => f.path);
}

function hunkLineCount(h) {
  return h.added.length + h.removed.length;
}

function addedLineSet(file) {
  return new Set(file.hunks.flatMap((h) => h.added.map((l) => l.line)));
}

module.exports = { parseDiff, hunkLineCount, addedLineSet };
