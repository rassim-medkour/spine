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
const PRODUCT_REF_RE = /^(?:.*\/)?product\.md:(\d+)$/;
const SECTION_NOTE_RE = /§\s*(.+?)\s*$/;
const STRONG = new Set(['CRITICAL', 'HIGH']);

const toPosix = (p) => String(p).replaceAll('\\', '/').replace(/^\.\//, '');

// A product.md:<line> ref qualifies when the line is a non-blank, non-heading line inside the section named by § in the note.
function productLineQualifies(line, note, sections) {
  const m = SECTION_NOTE_RE.exec(String(note || ''));
  if (!m || !(sections instanceof Map)) return false;
  const name = m[1].replace(/^#+\s*/, '');
  const section = sections.get('## ' + name);
  if (!section || !(line > section.start && line <= section.end)) return false;
  const text = section.lines[line - section.start - 1];
  return typeof text === 'string' && text.trim() !== '' && !/^\s*#/.test(text);
}

function docQualifies(ref, note, ctx) {
  const value = String(ref || '').trim();
  const product = PRODUCT_REF_RE.exec(value);
  if (product) return productLineQualifies(Number(product[1]), note, ctx.productSections);
  if (ISSUE_RE.test(value) || URL_RE.test(value)) return true;
  const file = toPosix(value.replace(/:\d+(-\d+)?$/, ''));
  return DOC_FILE_RE.test(file) && typeof ctx.repoHas === 'function' && Boolean(ctx.repoHas(file));
}

// ctx: { productSections: Map | null, repoHas: (path) => boolean }
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

module.exports = { writeCapRecord, PRODUCT_AGENTS, CAP_PREFIX, qualifyingCitation, capProductRecord, isCapped };
