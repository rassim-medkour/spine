'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { globToRegExp } = require('../classify');
const { TEST_FILE } = require('./graph');

const HEADINGS = Object.freeze(['## Users', '## Goals', '## Glossary', '## Invariants', '## Key flows', '## UX principles']);
const WEIGHTS = Object.freeze(['critical', 'important', 'minor']);
const MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 150;
const DECISIONS_TAIL = 10;
const KEPT_WHEN_TRIMMED = Object.freeze(['## Glossary', '## Invariants']);

const defaultIo = {
  // Reads at most maxBytes + 1 bytes so an oversize file is detected without loading it all.
  read(file, maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  },
  // sha256 over the whole file, streamed, so the byte cap limits parsing and never the hash.
  hash(file) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let n;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) h.update(chunk.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  },
  // Tracked repo files (git ls-files), falling back to a directory walk when git is unavailable.
  listFiles(root) {
    const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (git.status === 0 && typeof git.stdout === 'string' && git.stdout) return git.stdout.split('\0').filter(Boolean);
    return walkFiles(root);
  },
};

const WALK_SKIP = new Set(['.git', 'node_modules']);
const WALK_LIMIT = 50000;

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < WALK_LIMIT) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (WALK_SKIP.has(e.name)) continue;
      const child = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) stack.push(child);
      else out.push(child);
    }
  }
  return out;
}

function normalizeText(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Sections keyed by "## Heading"; start is the 1-based line of the heading, end the 0-based exclusive end index.
function findSections(lines) {
  const sections = new Map();
  let current = null;
  lines.forEach((raw, i) => {
    const m = /^(## [^#].*?)\s*$/.exec(raw);
    if (m) {
      if (current) current.end = i;
      current = { start: i + 1, end: lines.length, lines: [] };
      if (!sections.has(m[1])) sections.set(m[1], current);
      return;
    }
    if (current) current.lines.push(raw);
  });
  return sections;
}

function parseFlowBlock(lines, startIdx, endIdx) {
  const name = lines[startIdx].replace(/^###\s+/, '').trim();
  const line = startIdx + 1;
  let weight = null;
  let paths = [];
  const steps = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const w = /^\s*weight:\s*(.*?)\s*$/i.exec(lines[i]);
    if (w) { weight = w[1].toLowerCase(); continue; }
    const p = /^\s*paths:\s*(.*?)\s*$/i.exec(lines[i]);
    if (p) { paths = p[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    const s = /^\s*\d+[.)]\s+(.*?)\s*$/.exec(lines[i]);
    if (s) steps.push(s[1]);
  }
  return { name, weight, paths, steps, line };
}

function parseFlows(lines, keySection) {
  const flows = [];
  const flowBlocks = [];
  const issues = [];
  if (!keySection) return { flows, flowBlocks, issues };
  const heads = [];
  for (let i = keySection.start; i < keySection.end; i++) if (/^###\s+\S/.test(lines[i])) heads.push(i);
  heads.forEach((idx, n) => {
    const end = n + 1 < heads.length ? heads[n + 1] : keySection.end;
    const flow = parseFlowBlock(lines, idx, end);
    if (!WEIGHTS.includes(flow.weight)) {
      issues.push({ line: flow.line, flow: flow.name, message: `flow "${flow.name}" has an unknown weight` });
      return;
    }
    if (!flow.paths.length) {
      issues.push({ line: flow.line, flow: flow.name, message: `flow "${flow.name}" has empty paths` });
      return;
    }
    flows.push(flow);
    flowBlocks.push({ flow, start: idx, end });
  });
  return { flows, flowBlocks, issues };
}

// Pure and total: never throws on any input. Line numbers are 1-based.
function parseProduct(input) {
  try {
    const text = normalizeText(typeof input === 'string' ? input : '');
    const lines = splitLines(text);
    const sections = findSections(lines);
    const issues = [];
    for (const h of HEADINGS) if (!sections.has(h)) issues.push({ line: 0, message: `missing heading "${h}"` });
    const parsed = parseFlows(lines, sections.get('## Key flows'));
    return {
      ok: issues.length === 0,
      sections,
      flows: parsed.flows,
      flowBlocks: parsed.flowBlocks,
      issues: [...issues, ...parsed.issues],
      lineCount: lines.length,
    };
  } catch {
    return { ok: false, sections: new Map(), flows: [], flowBlocks: [], issues: [{ line: 0, message: 'parse error' }], lineCount: 0 };
  }
}

const toPosix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

function compileFlow(flow) {
  const res = [];
  const entries = [];
  const bad = [];
  for (const glob of flow.paths) {
    try {
      const re = globToRegExp(toPosix(glob));
      res.push(re);
      entries.push({ glob, re });
    } catch {
      bad.push({ flow: flow.name, glob, message: 'glob does not compile', line: flow.line });
    }
  }
  return { res, entries, bad };
}

// Compiles every flow glob once. byFile maps a POSIX path to every flow it matches, in flow order;
// issues lists globs that do not compile (never thrown). compiled is aligned with flows.
function matchFlows(flows, files) {
  const compiled = flows.map(compileFlow);
  const issues = compiled.flatMap((c) => c.bad);
  const byFile = new Map();
  for (const raw of files) {
    const f = toPosix(raw);
    flows.forEach((flow, i) => {
      if (!compiled[i].res.some((re) => re.test(f))) return;
      byFile.set(f, [...(byFile.get(f) || []), { name: flow.name, weight: flow.weight }]);
    });
  }
  return { byFile, issues, compiled: compiled.map((c) => c.res), entries: compiled.map((c) => c.entries) };
}

// A glob is an issue when it does not compile or when no tracked repo file (or changed file) matches it.
// Globs are judged one by one and the flow keeps its other globs. A flow the change does not touch is not an issue.
function touchedFlows(flows, changedFiles, repoFiles) {
  const files = changedFiles.map(toPosix);
  const { byFile, issues, entries } = matchFlows(flows, files);
  const universe = flows.length ? [...new Set([...repoFiles().map(toPosix), ...files])] : [];
  const touched = [];
  const flowIssues = [...issues];
  flows.forEach((flow, i) => {
    const hit = files.filter((f) => (byFile.get(f) || []).some((m) => m.name === flow.name));
    if (hit.length) touched.push({ name: flow.name, weight: flow.weight, files: hit });
    for (const { glob, re } of entries[i]) {
      if (!universe.some((f) => re.test(f))) flowIssues.push({ flow: flow.name, glob, message: 'no matching files', line: flow.line });
    }
  });
  return { touched, flowIssues, byFile };
}

const USER_FACING_PATH_RULES = Object.freeze([
  [/\.(jsx|tsx|vue|svelte|html|hbs|ejs|njk)$/i, 'ui template'],
  [/(^|\/)(locales?|i18n|messages|translations)\//i, 'i18n or copy'],
  [/(^|\/)(emails?|notifications?)\/.*\.(html|txt|mjml|hbs)$/i, 'email or notification template'],
]);
const USER_FACING_LINE_RULES = Object.freeze([
  [/\bres\.(json|send|render)\(/, 'response shape writer'],
  [/\w*(Serializer|Dto|DTO)\b|\btoJSON\b/, 'serializer or DTO'],
]);

// Test files are never user-facing. Path rules first, then added-line rules.
function userFacing(file, addedLines = []) {
  const p = toPosix(file);
  if (TEST_FILE.test(p)) return { value: false, rule: 'test file' };
  const byPath = USER_FACING_PATH_RULES.find(([re]) => re.test(p));
  if (byPath) return { value: true, rule: byPath[1] };
  const byLine = USER_FACING_LINE_RULES.find(([re]) => addedLines.some((l) => re.test(String(l))));
  return byLine ? { value: true, rule: byLine[1] } : { value: false, rule: 'no user-facing rule' };
}

// null unless product context loaded (ok or trimmed): absent and malformed leave tree.json as 0.3.2 wrote it.
function productSignals(file, addedLines, loaded, matched) {
  if (!loaded || (loaded.state !== 'ok' && loaded.state !== 'trimmed')) return null;
  const flows = (matched && matched.get(toPosix(file))) || [];
  return {
    user_facing: userFacing(file, addedLines),
    key_flow: flows.length
      ? { value: true, rule: 'matches key flow ' + flows.map((f) => f.name + ' (' + f.weight + ')').join(', '), flows }
      : { value: false, rule: 'matches no key flow', flows: [] },
  };
}

const SECTION_HEADING_RE = /^(## [^#].*?)\s*$/;

// Text a trimmed load can never carry: the preamble, the Key flows intro and repeated headings.
function unreachableParts(lines, parsed) {
  const out = [];
  const firstHeading = lines.findIndex((l) => SECTION_HEADING_RE.test(l));
  const preamble = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  if (preamble.some((l) => l.trim())) out.push('preamble');
  const flows = parsed.sections.get('## Key flows');
  if (flows) {
    let end = flows.end;
    for (let i = flows.start; i < flows.end; i++) {
      if (/^###\s+\S/.test(lines[i])) { end = i; break; }
    }
    if (lines.slice(flows.start, end).some((l) => l.trim())) out.push('## Key flows (intro)');
  }
  const seen = new Map();
  for (const l of lines) {
    const m = SECTION_HEADING_RE.exec(l);
    if (!m) continue;
    const n = (seen.get(m[1]) || 0) + 1;
    seen.set(m[1], n);
    if (n > 1) out.push(m[1] + ' (' + n + ')');
  }
  return out;
}

// Chunks are taken in document order up to max lines; every chunk cut wholly or in part is named in leftOut.
function budgetText(lines, parsed, touchedNames, max) {
  const chunks = [];
  const leftOut = [];
  for (const [heading, sec] of parsed.sections) {
    const headingIdx = sec.start - 1;
    if (KEPT_WHEN_TRIMMED.includes(heading)) {
      chunks.push({ label: heading, lines: lines.slice(headingIdx, sec.end) });
    } else if (heading === '## Key flows') {
      chunks.push({ label: heading, lines: [lines[headingIdx]] });
      for (const b of parsed.flowBlocks) {
        if (touchedNames.has(b.flow.name)) chunks.push({ label: 'flow ' + b.flow.name, lines: lines.slice(b.start, b.end) });
        else leftOut.push('flow ' + b.flow.name);
      }
    } else {
      leftOut.push(heading);
    }
  }
  const keep = [];
  for (const chunk of chunks) {
    const room = Math.max(0, max - keep.length);
    keep.push(...chunk.lines.slice(0, room));
    if (room < chunk.lines.length) leftOut.push(room > 0 ? chunk.label + ' (cut)' : chunk.label);
  }
  return { text: keep.join('\n'), leftOut: [...leftOut, ...unreachableParts(lines, parsed)] };
}

// Plain, JSON-safe section map: { '## Invariants': { start, end, blank: [lines], headings: [lines] } }.
// product.json.sections holds this shape; the workflows check citations against it (REQ-13, REQ-23).
function sectionMapOf(sections) {
  if (!(sections instanceof Map)) return sections && typeof sections === 'object' ? sections : null;
  const out = {};
  for (const [heading, s] of sections) {
    const lines = Array.isArray(s.lines) ? s.lines : [];
    const blank = [];
    const headings = [];
    lines.forEach((text, i) => {
      const n = s.start + 1 + i;
      if (String(text).trim() === '') blank.push(n);
      else if (/^\s*#/.test(text)) headings.push(n);
    });
    out[heading] = { start: s.start, end: s.end, blank, headings };
  }
  return out;
}

function result(extra) {
  return {
    state: 'absent', sha256: null, lines: 0, loadedLines: 0, text: '', flows: [], matched: new Map(), flowsTouched: [],
    flowIssues: [], leftOut: [], issue: null, decisionsTail: [], sections: null, ...extra,
  };
}

const malformed = (message, extra = {}) => result({ state: 'malformed', issue: { line: 0, message }, ...extra });

const DECISIONS_HEADER = '# Decisions log (append-only; one line per human answer, written by spine at gates)';
const DECISION_LINE_RE = /^- (\d{4}-\d{2}-\d{2}) · (\S+) · (R-\d{4,}) · (.*) · (.*)$/;
const QUESTION_MAX = 120;
const ANSWER_MAX = 200;
const RETRY_CODES = new Set(['EPERM', 'EBUSY']);

const cutPoints = (text, max) => [...text].slice(0, max).join('');
// One line, no leading '#' (a decisions line must never read as a heading).
const flatten = (text) => String(text == null ? '' : text).replace(/\s*[\r\n]+\s*/g, ' ').trim().replace(/^#/, '＃');

// fullTextRecordId names the record holding the whole answer; it defaults to the source record.
function formatDecisionLine({ date, runId, recordId, question, answer, fullTextRecordId }) {
  const q = cutPoints(flatten(question), QUESTION_MAX);
  const full = flatten(answer);
  const a = [...full].length > ANSWER_MAX ? `${cutPoints(full, ANSWER_MAX)} (cut, full text in ${fullTextRecordId || recordId})` : full;
  return `- ${date} · ${runId} · ${recordId} · ${q} · ${a}`;
}

const defaultDecisionsIo = {
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  },
  write: (file, text) => fs.writeFileSync(file, text),
  rename: (from, to) => fs.renameSync(from, to),
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  unlink: (file) => fs.unlinkSync(file),
};

const alreadyLogged = (text, runId, recordId) => text.split(/\r?\n/).some((l) => {
  const m = DECISION_LINE_RE.exec(l);
  return m && m[2] === runId && m[3] === recordId;
});

// Rereads right before writing; temp file + rename in the same directory; one retry on EPERM or EBUSY.
function appendDecision(file, entry, io = defaultDecisionsIo) {
  const line = formatDecisionLine(entry);
  let tmp = null;
  try {
    const current = io.read(file);
    if (current !== null && alreadyLogged(current, entry.runId, entry.recordId)) return { ok: true, written: false, line: null, error: null };
    const eol = current !== null && current.includes('\r\n') ? '\r\n' : '\n';
    const head = current === null ? DECISIONS_HEADER + eol : current === '' || current.endsWith('\n') ? current : current + eol;
    io.mkdir(path.dirname(file));
    tmp = `${file}.${process.pid}.tmp`;
    io.write(tmp, head + line + eol);
    try {
      io.rename(tmp, file);
    } catch (e) {
      if (!RETRY_CODES.has(e && e.code)) throw e;
      io.rename(tmp, file);
    }
    return { ok: true, written: true, line, error: null };
  } catch (e) {
    if (tmp) {
      try { io.unlink(tmp); } catch { /* best effort */ }
    }
    return { ok: false, written: false, line: null, error: (e && e.code) || 'write failed' };
  }
}

function readDecisionsTail(file, n = DECISIONS_TAIL) {
  if (!file) return [];
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => DECISION_LINE_RE.test(l)).slice(-n);
  } catch {
    return [];
  }
}

function maxLinesFrom(config) {
  const n = config && config.product_context_max_lines;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_LINES;
}

// Decodes raw product.md bytes. error is a short message (code or heading, never body text) or null.
function decodeProduct(buf, sha256) {
  if (buf.length > MAX_BYTES) return { sha256, error: 'size over limit', text: '' };
  try {
    return { sha256, error: null, text: normalizeText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)) };
  } catch {
    return { sha256, error: 'not valid UTF-8', text: '' };
  }
}

const DECISIONS_BLOCK_HEADING = '## Decisions (last ' + DECISIONS_TAIL + ')';

// The tail rides at the end of the prompt text; it never counts toward product_context_max_lines.
const withDecisionsTail = (text, tail) => (tail.length ? (text ? text + '\n\n' : '') + DECISIONS_BLOCK_HEADING + '\n' + tail.join('\n') : text);

// opts.decisionsRoot: the main checkout, when product.md is read from a review worktree.
function loadProduct(root, config = {}, changedFiles = [], io = defaultIo, opts = {}) {
  const dir = (config && config.artifacts_dir) || '.spine';
  const file = path.join(root, dir, 'product.md');
  let buf;
  let sha256;
  try {
    buf = io.read(file, MAX_BYTES);
    sha256 = buf.length > MAX_BYTES && io.hash ? io.hash(file) : crypto.createHash('sha256').update(buf).digest('hex');
  } catch (e) {
    if (e && e.code === 'ENOENT') return result({});
    return malformed('read error ' + ((e && e.code) || 'unknown'));
  }
  const decoded = decodeProduct(buf, sha256);
  if (decoded.error) return malformed(decoded.error, { sha256 });
  const lines = splitLines(decoded.text);
  const parsed = parseProduct(decoded.text);
  if (!parsed.ok) return result({ state: 'malformed', sha256, lines: lines.length, issue: parsed.issues[0] });
  const listFiles = () => (io.listFiles ? io.listFiles(root) : []);
  const { touched, flowIssues, byFile } = touchedFlows(parsed.flows, changedFiles || [], listFiles);
  const dropped = parsed.issues.filter((i) => i.flow).map((i) => ({ flow: i.flow, glob: null, message: i.message, line: i.line }));
  const decisionsTail = readDecisionsTail(path.join(opts.decisionsRoot || root, dir, 'decisions.md'));
  const base = { sections: sectionMapOf(parsed.sections), sha256, lines: lines.length, flows: parsed.flows, matched: byFile, flowsTouched: touched, flowIssues: [...dropped, ...flowIssues], decisionsTail };
  if (lines.length <= maxLinesFrom(config)) {
    return result({ ...base, state: 'ok', text: withDecisionsTail(lines.join('\n'), decisionsTail), loadedLines: lines.length + decisionsTail.length });
  }
  const trimmed = budgetText(lines, parsed, new Set(touched.map((t) => t.name)), maxLinesFrom(config));
  return result({ ...base, state: 'trimmed', text: withDecisionsTail(trimmed.text, decisionsTail), loadedLines: splitLines(trimmed.text).length + decisionsTail.length, leftOut: trimmed.leftOut });
}

// product.json: missing (ENOENT) is a normal state; anything else that is not a JSON object is unreadable.
function readProductJson(runDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(runDir, 'product.json'), 'utf8');
  } catch (e) {
    return { status: e && e.code === 'ENOENT' ? 'missing' : 'unreadable', data: null };
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? { status: 'ok', data } : { status: 'unreadable', data: null };
  } catch {
    return { status: 'unreadable', data: null };
  }
}

// What the artifact validators need to know about product context for a run directory.
function productContextFor(runDir) {
  let spineVersion = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    if (s && typeof s.spine_version === 'string') spineVersion = s.spine_version;
  } catch {
    spineVersion = null;
  }
  const pj = readProductJson(runDir);
  const state = pj.status === 'ok' && typeof pj.data.state === 'string' ? pj.data.state : null;
  return { productContext: state === 'ok' || state === 'trimmed', spineVersion, state, unreadable: pj.status === 'unreadable' };
}

module.exports = {
  sectionMapOf, readProductJson, productContextFor, DECISIONS_BLOCK_HEADING, HEADINGS, WEIGHTS, MAX_BYTES, DEFAULT_MAX_LINES, DECISIONS_TAIL, parseProduct, loadProduct, matchFlows, userFacing, productSignals, USER_FACING_PATH_RULES, USER_FACING_LINE_RULES, readDecisionsTail, decodeProduct, defaultIo, DECISIONS_HEADER, DECISION_LINE_RE, formatDecisionLine, appendDecision, defaultDecisionsIo };
