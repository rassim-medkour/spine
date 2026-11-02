'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nextRecordId } = require('./records');
const { issueText } = require('./safe-text');
const { LOOP_LIMIT } = require('./followup-counter');

const RECORD_STAGES = new Set(['intent', 'spec', 'plan', 'implement', 'review']);

function writeCapRecord(run, issues) {
  const stage = run.state.stage;
  if (!RECORD_STAGES.has(stage)) return null;
  const id = nextRecordId(run.dir);
  const record = {
    id,
    stage,
    agent: 'spine:stop-hook',
    claim: `Stop cap-reached: stage ${stage} ended without being gate-clean after ${LOOP_LIMIT} followups`,
    evidence: [{ kind: 'doc', ref: 'hooks.log', note: issues.map(issueText).join('; ') }],
    confidence: 1,
    severity: 'MEDIUM',
    dissent: null,
    resolution: null,
    alternatives: [],
    host: 'cursor',
  };
  const recDir = path.join(run.dir, 'records');
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return id;
}

// Citation cap for the two product roles (REQ-11 to REQ-13). Decided by evidence shape only.
const PRODUCT_AGENTS = Object.freeze(['spine:product-lens', 'spine:ux-finder']);
const CAP_PREFIX = 'assumption to confirm: ';
const CAP_CONFIDENCE = 0.5;
const DOC_FILE_RE = /(\.(md|markdown|rst|txt)$)|(^|\/)docs\//i;
const ISSUE_RE = /^(#\d+|[\w.-]+\/[\w.-]+#\d+)$/;
const URL_RE = /^https?:\/\//i;
const SECTION_NOTE_RE = /§\s*(.+?)\s*$/;
const LINE_SPEC_RE = /:(\d+)(?:-(\d+))?$/;
const DEFAULT_PRODUCT_PATH = '.spine/product.md';
const STRONG = new Set(['CRITICAL', 'HIGH']);

const toPosix = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');

// The plain section map is built where sections are parsed (product-context.js). Required lazily: product-context.js
// sits in the gate's require chain, which already reaches this module through safe-text.js.
const sectionMapOf = (sections) => require('./product-context').sectionMapOf(sections);

// A cited line qualifies when it is non-blank, not a heading, and inside the section named by the note.
function lineQualifies(line, section) {
  return line > section.start && line <= section.end && !(section.blank || []).includes(line) && !(section.headings || []).includes(line);
}

function productCitationQualifies(spec, note, sections) {
  const m = SECTION_NOTE_RE.exec(String(note || ''));
  const map = sectionMapOf(sections);
  if (!spec || !m || !map) return false;
  const section = map['## ' + m[1].replace(/^#+\s*/, '')];
  if (!section) return false;
  const from = Number(spec[1]);
  const to = spec[2] === undefined ? from : Number(spec[2]);
  if (!(to >= from) || to - from > 2000) return false;
  for (let n = from; n <= to; n += 1) if (!lineQualifies(n, section)) return false;
  return true;
}

function docQualifies(ref, note, ctx) {
  const value = String(ref || '').trim();
  const file = toPosix(value.replace(LINE_SPEC_RE, ''));
  const productPath = toPosix(ctx.productPath || DEFAULT_PRODUCT_PATH);
  // Any ref to product.md is a product citation: a bare one, or one that fails the section check, never falls through to the doc-file rule.
  if (file === 'product.md' || file === productPath) return productCitationQualifies(LINE_SPEC_RE.exec(value), note, ctx.productSections);
  if (ISSUE_RE.test(value) || URL_RE.test(value)) return true;
  return DOC_FILE_RE.test(file) && typeof ctx.repoHas === 'function' && Boolean(ctx.repoHas(file));
}

// ctx: { productSections: Map | section object | null, productPath?: string, repoHas: (path) => boolean }
function qualifyingCitation(evidence, ctx = {}) {
  return (Array.isArray(evidence) ? evidence : []).some((e) => e && e.kind === 'doc' && docQualifies(e.ref, e.note, ctx));
}

const isProductRecord = (record) => Boolean(record) && PRODUCT_AGENTS.includes(record.agent);

function isCapped(record) {
  return isProductRecord(record) && Boolean(record.resolution) && typeof record.resolution.text === 'string' && record.resolution.text.startsWith(CAP_PREFIX);
}

function capProductRecord(record, ctx = {}) {
  if (!isProductRecord(record) || qualifyingCitation(record.evidence, ctx)) return record;
  const resolution = record.resolution || null;
  const keep = resolution && resolution.kind === 'question' && typeof resolution.text === 'string' ? resolution.text : record.claim;
  const text = String(keep).startsWith(CAP_PREFIX) ? keep : CAP_PREFIX + keep;
  return {
    ...record,
    confidence: Math.min(Number(record.confidence), CAP_CONFIDENCE),
    severity: STRONG.has(record.severity) ? 'MEDIUM' : record.severity,
    resolution: { kind: 'question', text },
  };
}

module.exports = { writeCapRecord, PRODUCT_AGENTS, CAP_PREFIX, DOC_FILE_RE, sectionMapOf, qualifyingCitation, capProductRecord, isCapped };
