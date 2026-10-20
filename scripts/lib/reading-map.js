'use strict';
const { isFinding } = require('./cross-author');
const { hunkLineCount } = require('./diff');
const { DOCS_RE } = require('./tiers');
const { TEST_FILE } = require('./graph');

const REASON_ORDER = Object.freeze(['one-way door', 'open dissent', 'no proof', 'trunk', 'low-confidence finding', 'hollow test']);
const TOUCHES = Object.freeze([['shared_state', 'state/config/schema'], ['one_way_door', 'one-way door'], ['public_interface', 'public interface'], ['security_path', 'security path']]);
const KNOB_LABELS = Object.freeze({
  is_trunk: 'Is this trunk code?',
  wide_downstream: 'Does it have wide downstream dependencies?',
  gated: 'Is it gated behind a flag?',
  severe_if_broken: 'Is it bad if it breaks?',
  instant_rollback: 'Can it be rolled back instantly?',
});
const EMPTY_HUNK = Object.freeze({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, added: [], removed: [] });

function refRange(ref) {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(String(ref || ''));
  return m ? { path: m[1].replace(/\\/g, '/'), start: Number(m[2]), end: Number(m[3] || m[2]) } : null;
}

function hunksOf(diffFiles) {
  return diffFiles.flatMap((f) => (f.hunks.length ? f.hunks : [EMPTY_HUNK]).map((h) => {
    const deleted = f.status === 'deleted';
    const start = deleted ? h.oldStart : h.newStart;
    const len = deleted ? h.oldLines : h.newLines;
    return { path: f.path, deleted, start, end: Math.max(start, start + len - 1), lines: hunkLineCount(h) };
  }));
}

function citeReason(r, tc) {
  if (r.agent === 'spine:devils-advocate' || (typeof r.dissent === 'string' && r.dissent)) return 'open dissent';
  if (isFinding(r) && typeof r.confidence === 'number' && r.confidence < tc.low_confidence) return 'low-confidence finding';
  if (r.agent === 'spine:test-quality' && r.severity === 'MEDIUM') return 'hollow test';
  return null;
}

function citations(records, tc) {
  const closed = new Set(records.filter((r) => typeof r.resolves === 'string').map((r) => r.resolves));
  return records.filter((r) => !closed.has(r.id)).flatMap((r) => {
    const reason = citeReason(r, tc);
    if (!reason) return [];
    return (Array.isArray(r.evidence) ? r.evidence : []).map((e) => refRange(e.ref)).filter(Boolean).map((at) => ({ ...at, reason, id: r.id }));
  });
}

function reasonsFor(h, file, cites, gapFiles) {
  const reasons = new Set();
  const ids = new Set();
  if (file && file.signals.one_way_door.value === true) reasons.add('one-way door');
  if (file && file.tier === 'trunk') reasons.add('trunk');
  if (gapFiles.has(h.path)) reasons.add('no proof');
  for (const c of cites) {
    if (c.path !== h.path || c.start > h.end || c.end < h.start) continue;
    reasons.add(c.reason);
    ids.add(c.id);
  }
  return { reasons: REASON_ORDER.filter((r) => reasons.has(r)), cited: [...ids].sort() };
}

function skimReason(file) {
  if (!file) return null;
  const fi = file.signals.fan_in;
  if (file.tier === 'leaf') {
    const extras = [file.signals.tested.value === true ? 'tested' : null, file.signals.gated.value === true ? 'gated' : null].filter(Boolean);
    return [`leaf: fan-in ${fi.resolved ? fi.value : 'unknown'}`, ...extras].join(', ');
  }
  if (file.tier === 'branch') return `branch: ${file.reasons[0]}`;
  return null;
}

function readEntry(h, ref, file, reasons, cited, proofIds) {
  const importers = file ? file.importers_top : [];
  const fi = file ? file.signals.fan_in : null;
  const total = fi && Number.isInteger(fi.value) ? fi.value : importers.length;
  return {
    ref, path: h.path, start: h.start, lines: h.lines, reasons,
    importers, more: Math.max(0, total - importers.length),
    touches: file ? TOUCHES.filter(([k]) => file.signals[k].value === true).map(([, label]) => label) : [],
    evidence: proofIds.length ? proofIds : ['none'],
    records: cited,
    fan_in: fi && fi.resolved ? fi.value : null,
  };
}

const fanKey = (e) => (e.fan_in === null ? Number.MAX_SAFE_INTEGER : e.fan_in);
const rankOf = (e) => Math.min(...e.reasons.map((r) => REASON_ORDER.indexOf(r)));
const byPathStart = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start);
const byRank = (a, b) => rankOf(a) - rankOf(b) || fanKey(b) - fanKey(a) || byPathStart(a, b);
const minutes = (lines, rate) => (lines ? Math.ceil(lines / rate) : 0);
const sumLines = (list) => list.reduce((n, e) => n + e.lines, 0);

function totals(groups, tc) {
  const r = tc.reading_rates;
  const read = { hunks: groups.read_yourself.length, lines: sumLines(groups.read_yourself), minutes: minutes(sumLines(groups.read_yourself), r.read_yourself) };
  const skim = { hunks: groups.skim.length, lines: sumLines(groups.skim), minutes: minutes(sumLines(groups.skim), r.skim) };
  const skip = { hunks: groups.skip.length, lines: sumLines(groups.skip), minutes: 0 };
  const lines = read.lines + skim.lines + skip.lines;
  const raw = minutes(lines, r.whole);
  const floor = read.minutes + skim.minutes;
  return { read_yourself: read, skim, skip, whole: { hunks: read.hunks + skim.hunks + skip.hunks, lines, minutes: Math.max(raw, floor), clamped: raw < floor } };
}

function place(h, file, ctx, groups) {
  const ref = `${h.path}${h.deleted ? ' (deleted)' : ''}:${h.start}-${h.end}`;
  const proofIds = ctx.covering[h.path] || [];
  const { reasons, cited } = reasonsFor(h, file, ctx.cites, ctx.gapFiles);
  if (reasons.length) return groups.read_yourself.push(readEntry(h, ref, file, reasons, cited, proofIds));
  if (DOCS_RE.test(h.path)) return groups.skim.push({ ref, path: h.path, start: h.start, lines: h.lines, reason: 'docs only' });
  if (TEST_FILE.test(h.path)) return groups.skim.push({ ref, path: h.path, start: h.start, lines: h.lines, reason: 'test file: tests changed are never skipped' });
  if (file && file.tier === 'leaf' && file.signals.tested.value === true && proofIds.length) return groups.skip.push({ ref, path: h.path, start: h.start, lines: h.lines, evidence: proofIds });
  const why = skimReason(file);
  if (why) return groups.skim.push({ ref, path: h.path, start: h.start, lines: h.lines, reason: why });
  return groups.read_yourself.push(readEntry(h, ref, file, ['no proof'], cited, proofIds));
}

function buildReadingMap({ diffFiles, tree, records, proof, tc }) {
  const files = new Map(((tree && tree.files) || []).map((f) => [f.path, f]));
  const ctx = {
    gapFiles: new Set(((proof && proof.missing) || []).flatMap((m) => m.files)),
    covering: (proof && proof.covering) || {},
    cites: citations(records, tc),
  };
  const groups = { read_yourself: [], skim: [], skip: [] };
  for (const h of hunksOf(diffFiles)) place(h, files.get(h.path) || null, ctx, groups);
  const sorted = { read_yourself: [...groups.read_yourself].sort(byRank), skim: [...groups.skim].sort(byPathStart), skip: [...groups.skip].sort(byPathStart) };
  return { groups: sorted, totals: totals(sorted, tc) };
}

const clean = (s) => String(s).replace(/[`\r\n]/g, '');

function readLine(e, i) {
  const importers = e.importers.length ? `${e.importers.map(clean).join(', ')}${e.more ? ` +${e.more} more` : ''}` : 'none';
  const records = e.records.length ? ` · records: ${e.records.join(', ')}` : '';
  return `${i + 1}. \`${clean(e.ref)}\` · ${e.reasons.join(', ')} · importers: ${importers} · touches: ${e.touches.join(', ') || 'nothing shared'} · evidence: ${e.evidence.join(', ')}${records}`;
}

function renderReadingMap(map, meta) {
  const t = map.totals;
  const head = ['---', `id: ${meta.runId}-reading-map`, `diff_sha256: ${meta.diffSha}`, `tree_sha256: ${meta.treeSha}`, `stale: ${meta.stale ? 'true' : 'false'}`, '---', '', '# Reading map', ''];
  const stale = meta.stale ? ['> STALE: the diff changed after tree.json was written. Re-run tree.js, then this map.', ''] : [];
  const sums = [
    `Change tier: ${meta.tier || 'unknown'} · verdict: ${meta.verdict || 'pending'}`, '',
    `Read yourself: ${t.read_yourself.hunks} hunks, ${t.read_yourself.minutes} min · Skim: ${t.skim.hunks} hunks, ${t.skim.minutes} min · Skip: ${t.skip.hunks} hunks · Whole diff: ${t.whole.minutes} min${t.whole.clamped ? ' (raised to cover read + skim)' : ''}`, '',
  ];
  const knobs = Object.entries(meta.knobs || {}).map(([k, v]) => `- ${KNOB_LABELS[k] || k} ${v.answer}`);
  const confirm = ['## Confirm at G3', '', ...knobs, `- Rollback or flag plan: ${meta.rollback || 'not required'}`, ''];
  const read = ['## Read yourself', '', ...map.groups.read_yourself.map(readLine), ''];
  const skim = ['## Skim', '', ...map.groups.skim.map((e) => `- \`${clean(e.ref)}\` · ${e.reason}`), ''];
  const skip = ['## Skip', '', ...map.groups.skip.map((e) => `- \`${clean(e.ref)}\` · covered by ${e.evidence.join(', ')}`)];
  return `${[...head, ...stale, ...sums, ...confirm, ...read, ...skim, ...skip].join('\n')}\n`;
}

function summarize(map, meta) {
  const t = map.totals;
  return {
    ok: true,
    stale: Boolean(meta.stale),
    path: meta.relPath,
    counts: { read_yourself: t.read_yourself.hunks, skim: t.skim.hunks, skip: t.skip.hunks, total: t.whole.hunks },
    minutes: { read_yourself: t.read_yourself.minutes, skim: t.skim.minutes, whole: t.whole.minutes },
    g3: `tier ${meta.tier || 'unknown'} · verdict ${meta.verdict || 'pending'} · read yourself ${t.read_yourself.hunks} hunks, ${t.read_yourself.minutes} min (whole diff ${t.whole.minutes} min) · ${meta.relPath}`,
  };
}

module.exports = { REASON_ORDER, KNOB_LABELS, buildReadingMap, renderReadingMap, summarize };
