'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { globToRegExp } = require('../classify');

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
};

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
      issues.push({ line: flow.line, message: `flow "${flow.name}" has an unknown weight` });
      return;
    }
    if (!flow.paths.length) {
      issues.push({ line: flow.line, message: `flow "${flow.name}" has empty paths` });
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
  const bad = [];
  for (const glob of flow.paths) {
    try {
      res.push(globToRegExp(toPosix(glob)));
    } catch {
      bad.push({ flow: flow.name, glob, message: 'glob does not compile', line: flow.line });
    }
  }
  return { res, bad };
}

function touchedFlows(flows, changedFiles) {
  const files = changedFiles.map(toPosix);
  const touched = [];
  const flowIssues = [];
  for (const flow of flows) {
    const { res, bad } = compileFlow(flow);
    flowIssues.push(...bad);
    const hit = files.filter((f) => res.some((re) => re.test(f)));
    if (hit.length) touched.push({ name: flow.name, weight: flow.weight, files: hit });
  }
  return { touched, flowIssues };
}

function budgetText(lines, parsed, touchedNames, max) {
  const keep = [];
  const leftOut = [];
  for (const [heading, sec] of parsed.sections) {
    const headingIdx = sec.start - 1;
    if (KEPT_WHEN_TRIMMED.includes(heading)) {
      keep.push(...lines.slice(headingIdx, sec.end));
    } else if (heading === '## Key flows') {
      keep.push(lines[headingIdx]);
      for (const b of parsed.flowBlocks) {
        if (touchedNames.has(b.flow.name)) keep.push(...lines.slice(b.start, b.end));
        else leftOut.push(`flow ${b.flow.name}`);
      }
    } else {
      leftOut.push(heading);
    }
  }
  return { text: keep.slice(0, max).join('\n'), leftOut };
}

function result(extra) {
  return {
    state: 'absent', sha256: null, lines: 0, loadedLines: 0, text: '', flows: [], flowsTouched: [],
    flowIssues: [], leftOut: [], issue: null, decisionsTail: [], ...extra,
  };
}

const malformed = (message, extra = {}) => result({ state: 'malformed', issue: { line: 0, message }, ...extra });

// Stub until the decisions log lands: no tail yet.
function readDecisionsTail() {
  return [];
}

function maxLinesFrom(config) {
  const n = config && config.product_context_max_lines;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_LINES;
}

function loadProduct(root, config = {}, changedFiles = [], io = defaultIo) {
  const dir = (config && config.artifacts_dir) || '.spine';
  const file = path.join(root, dir, 'product.md');
  let buf;
  try {
    buf = io.read(file, MAX_BYTES);
  } catch (e) {
    if (e && e.code === 'ENOENT') return result({});
    return malformed(`read error ${(e && e.code) || 'unknown'}`);
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.length > MAX_BYTES) return malformed('size over limit', { sha256 });
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return malformed('not valid UTF-8', { sha256 });
  }
  const text = normalizeText(raw);
  const lines = splitLines(text);
  const parsed = parseProduct(text);
  if (!parsed.ok) return result({ state: 'malformed', sha256, lines: lines.length, issue: parsed.issues[0] });
  const { touched, flowIssues } = touchedFlows(parsed.flows, changedFiles || []);
  const base = { sha256, lines: lines.length, flows: parsed.flows, flowsTouched: touched, flowIssues, decisionsTail: readDecisionsTail() };
  if (lines.length <= maxLinesFrom(config)) {
    return result({ ...base, state: 'ok', text: lines.join('\n'), loadedLines: lines.length });
  }
  const trimmed = budgetText(lines, parsed, new Set(touched.map((t) => t.name)), maxLinesFrom(config));
  return result({ ...base, state: 'trimmed', text: trimmed.text, loadedLines: splitLines(trimmed.text).length, leftOut: trimmed.leftOut });
}

module.exports = { HEADINGS, WEIGHTS, MAX_BYTES, DEFAULT_MAX_LINES, DECISIONS_TAIL, parseProduct, loadProduct, readDecisionsTail };
