'use strict';
const path = require('node:path');

const JS_TEST_START = /(?<![.\w$])(test|it)(\.(skip|todo|only))?\s*\(/g;
const BODY_OPEN = /=>\s*\{|function\s*[\w$]*\s*\([^)]*\)\s*\{/g;
const JS_ASSERTION = /\b(assert\w*|expect\w*|verify\w*|check\w*)\s*\(|\bassert\.\w+\s*\(|\bt\.(is|ok|deepEqual|equal|throws|snapshot|true|false)\s*\(|\.should\b/;
const JS_TRIVIAL = Object.freeze([
  /\bassert(?:\.ok)?\(\s*(true|1)\s*\)/,
  /\bexpect\(\s*(true|1|null|undefined)\s*\)\.(toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
  /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*([\w.$]+|'[^']*'|"[^"]*"|\d+)\s*,\s*\1\s*\)/,
  /\bexpect\(\s*([\w.$]+)\s*\)\.(toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/,
]);
const JS_MOCK = /\b(?:jest\.mock|vi\.mock|mock\.module)\(\s*(['"])([^'"]+)\1/g;
const PY_ASSERT = /^\s*assert\b|\bself\.assert\w*\(|\bpytest\.raises\(|\.assert_\w+\(|\b(assert|expect|verify|check)\w*\(/;
const PY_TRIVIAL = Object.freeze([/^\s*assert\s+(True|1)\s*$/, /^\s*assert\s+([\w.]+)\s*==\s*\1\s*$/, /\bself\.assert(True|Equal)\(\s*(True|1)\s*(,\s*\2)?\s*\)/]);
const PY_SKIP = /@(pytest\.mark\.(skip|xfail)|unittest\.skip)/;
const GO_FAIL = /\b(\w+)\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\b(assert|require)\.\w+\(/;
const GO_SUBTEST = /\.Run\(\s*"[^"]*"\s*,\s*func\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{/g;

const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

// Replaces comment characters with spaces so indexes and line numbers stay the same.
function blankComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      // Template literal bodies are blanked: code inside them is a string, not a test.
      const keep = (ch) => (quote === '`' && ch !== '\n' && ch !== quote ? ' ' : ch);
      if (c === '\\' && i + 1 < text.length) { out += keep(c) + keep(n); i += 1; } else {
        out += keep(c);
        if (c === quote) quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; } out += i < text.length ? '\n' : ''; continue; }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) === 0) return i;
  }
  return text.length;
}

// True for every index inside a '...', "..." or `...` literal (quote characters excluded).
function stringMask(src) {
  const mask = new Array(src.length).fill(false);
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (!quote) {
      if (c === '"' || c === "'" || c === '`') quote = c;
    } else if (c === '\\') {
      mask[i] = true;
      if (i + 1 < src.length) mask[i + 1] = true;
      i += 1;
    } else if (c === quote || (c === '\n' && quote !== '`')) {
      quote = null;
    } else {
      mask[i] = true;
    }
  }
  return mask;
}

function jsFlags(text, changed) {
  const src = blankComments(text);
  const inString = stringMask(src);
  const starts = [...src.matchAll(JS_TEST_START)].filter((m) => !inString[m.index]);
  const flags = [];
  starts.forEach((m, k) => {
    const line = lineAt(src, m.index);
    if (!changed(line)) return;
    const limit = k + 1 < starts.length ? starts[k + 1].index : src.length;
    const header = src.slice(m.index, Math.min(limit, m.index + 400)).split(/=>|function/)[0];
    if (m[3] === 'skip' || m[3] === 'todo' || /[,(]\s*\{[^}]*\b(skip|todo)\s*:\s*(true|['"`])/.test(header)) {
      flags.push({ line, rule: 'skip-only' });
      return;
    }
    BODY_OPEN.lastIndex = m.index;
    const open = BODY_OPEN.exec(src);
    if (!open || open.index >= limit) return;
    const start = open.index + open[0].length - 1;
    const asserts = src.slice(start + 1, matchBrace(src, start)).split('\n').filter((l) => JS_ASSERTION.test(l));
    if (!asserts.length) flags.push({ line, rule: 'no-assertion' });
    else if (asserts.every((l) => JS_TRIVIAL.some((re) => re.test(l)))) flags.push({ line, rule: 'trivial-assertion' });
  });
  return flags;
}

function jsMock(file, text) {
  const unit = path.posix.basename(file).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, '');
  for (const m of text.matchAll(JS_MOCK)) {
    if (path.posix.basename(m[2]).replace(/\.[cm]?[jt]sx?$/, '') === unit) return { line: lineAt(text, m.index), rule: 'mocks-unit-under-test' };
  }
  return null;
}

function stripDocstring(body) {
  if (!body.length) return body;
  const first = body[0].trim();
  const q = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : null;
  if (!q) return body;
  if (first.length >= 6 && first.endsWith(q)) return body.slice(1);
  const end = body.findIndex((l, k) => k > 0 && l.includes(q));
  return end < 0 ? [] : body.slice(end + 1);
}

function pyBody(lines, i, indent) {
  const body = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (!lines[j].trim()) continue;
    if (lines[j].search(/\S/) <= indent) break;
    body.push(lines[j]);
  }
  return stripDocstring(body).filter((l) => !/^\s*#/.test(l));
}

function pyFlags(text, changed) {
  const lines = text.split(/\r?\n/);
  const flags = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(lines[i]);
    if (!m || !changed(i + 1)) continue;
    let d = i - 1;
    let skipped = false;
    while (d >= 0 && /^\s*@/.test(lines[d])) {
      if (PY_SKIP.test(lines[d])) skipped = true;
      d -= 1;
    }
    const code = pyBody(lines, i, m[1].length);
    const asserts = code.filter((l) => PY_ASSERT.test(l));
    let rule = null;
    if (skipped || (code.length && /^\s*pytest\.skip\(/.test(code[0]))) rule = 'skip-only';
    else if (!code.length || code.every((l) => /^\s*(pass|\.\.\.)\s*$/.test(l))) rule = 'pass-only';
    else if (!asserts.length) rule = 'no-assertion';
    else if (asserts.every((l) => PY_TRIVIAL.some((re) => re.test(l)))) rule = 'trivial-assertion';
    if (rule) flags.push({ line: i + 1, rule });
  }
  return flags;
}

function pyMock(file, text) {
  const unit = path.posix.basename(file).replace(/^test_/, '').replace(/(_test)?\.py$/, '');
  for (const m of text.matchAll(/\bpatch\(\s*(['"])([\w.]+)\1/g)) {
    if (m[2] === unit || m[2].endsWith(`.${unit}`)) return { line: lineAt(text, m.index), rule: 'mocks-unit-under-test' };
  }
  return null;
}

function goFlags(text, changed) {
  const src = blankComments(text);
  const flags = [];
  for (const m of src.matchAll(/^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{/gm)) {
    const line = lineAt(src, m.index);
    const open = m.index + m[0].length - 1;
    const body = src.slice(open + 1, matchBrace(src, open));
    const trimmed = body.trim();
    if (changed(line)) {
      if (/^\w+\.Skip(f|Now)?\(/.test(trimmed) && !trimmed.includes('\n')) flags.push({ line, rule: 'skip-only' });
      else if (!GO_FAIL.test(body)) flags.push({ line, rule: 'no-failure-path' });
    }
    for (const s of body.matchAll(GO_SUBTEST)) {
      const sOpen = open + 1 + s.index + s[0].length - 1;
      const sLine = lineAt(src, open + 1 + s.index);
      if (changed(sLine) && !GO_FAIL.test(src.slice(sOpen + 1, matchBrace(src, sOpen)))) flags.push({ line: sLine, rule: 'no-failure-path' });
    }
  }
  return flags;
}

function findHollowTests(file, text, changedLines = null) {
  if (typeof text !== 'string') return [];
  const changed = (n) => !changedLines || changedLines.has(n);
  const withMock = (flags, mock) => (mock && changed(mock.line) ? [...flags, mock] : flags);
  try {
    let flags = [];
    if (/\.[cm]?[jt]sx?$/.test(file)) flags = withMock(jsFlags(text, changed), jsMock(file, text));
    else if (file.endsWith('.py')) flags = withMock(pyFlags(text, changed), pyMock(file, text));
    else if (file.endsWith('_test.go')) flags = goFlags(text, changed);
    return flags.sort((a, b) => a.line - b.line);
  } catch {
    return [];
  }
}

module.exports = { findHollowTests };
