'use strict';
const { maxTier } = require('./tier-config');
const { planSection } = require('./proof');

const ALL = Object.freeze(['leaf', 'branch', 'trunk']);
const SECTIONS = Object.freeze([
  { key: 'reading_map', title: 'Risk and reading map', source: 'generated', tiers: ['trunk'], caps: { trunk: 20 } },
  { key: 'tldr', title: 'TL;DR', source: 'written', tiers: ALL, caps: { leaf: 3, branch: 5, trunk: 5 } },
  { key: 'problem', title: 'The problem, with an example', source: 'written', tiers: ['branch', 'trunk'], caps: { branch: 15, trunk: 20 } },
  { key: 'design', title: 'The design decision that shaped everything', source: 'written', tiers: ['trunk'], caps: { trunk: 15 } },
  { key: 'changed', title: 'What changed', source: 'generated', tiers: ALL, caps: { leaf: 12, branch: 20, trunk: 30 } },
  { key: 'rollout', title: 'Rollout / switch order', source: 'generated', tiers: ['trunk'], caps: { trunk: 10 } },
  { key: 'decisions', title: 'Decisions to check', source: 'generated', tiers: ['branch', 'trunk'], caps: { branch: 8, trunk: 12 } },
  { key: 'checked', title: 'How it was checked', source: 'generated', tiers: ALL, caps: { leaf: 6, branch: 8, trunk: 10 } },
  { key: 'not_verified', title: 'Not verified', source: 'generated', tiers: ['branch', 'trunk'], caps: { leaf: 8, branch: 10, trunk: 15 } },
  { key: 'how_to_test', title: 'How to test', source: 'generated', tiers: ALL, caps: { leaf: 5, branch: 8, trunk: 10 } },
].map((s) => Object.freeze(s)));
const EMPTY_TEXT = Object.freeze({ decisions: '- Nothing open.', not_verified: '- Nothing unverified.', how_to_test: '- No test command was recorded.' });
const ATTRIBUTION = /co-authored-by:|generated (with|by) (claude|cursor|an ai)/i;

const short = (s, n = 160) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};
const listFiles = (files) => (files.length ? `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}` : 'whole change');
const closedIds = (records) => new Set(records.filter((r) => typeof r.resolves === 'string').map((r) => r.resolves));

function areaOf(p) {
  const parts = p.split('/');
  if (parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.length === 2 ? parts[0] : '(root)';
}

function genChanged(data) {
  const byPath = new Map(((data.tree && data.tree.files) || []).map((f) => [f.path, f]));
  const areas = new Map();
  for (const f of data.diffFiles) {
    const area = areaOf(f.path);
    const prev = areas.get(area) || { files: 0, add: 0, del: 0, tier: 'leaf', reason: null };
    const tf = byPath.get(f.path);
    const tier = tf ? maxTier(prev.tier, tf.tier) : prev.tier;
    const raised = tf && (prev.reason === null || tier !== prev.tier);
    areas.set(area, {
      files: prev.files + 1,
      add: prev.add + f.hunks.reduce((n, h) => n + h.added.length, 0),
      del: prev.del + f.hunks.reduce((n, h) => n + h.removed.length, 0),
      tier,
      reason: raised ? tf.reasons[0] : prev.reason,
    });
  }
  return [...areas].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([area, v]) => `| \`${area}\` | ${v.files} | +${v.add} / -${v.del} | ${v.tier} | ${v.files} file(s), highest tier ${v.tier}${v.reason ? `: ${v.reason}` : ''} |`);
}

function genReadingMap(data) {
  const knobs = (data.tree && data.tree.knobs) || {};
  const ans = (k) => (knobs[k] ? knobs[k].answer : 'unknown');
  const head = [
    `- Is this trunk code? ${ans('is_trunk')}`,
    `- Wide downstream dependencies? ${ans('wide_downstream')}`,
    `- Gated behind a flag? ${ans('gated')}`,
    `- If it breaks: bad ${ans('severe_if_broken')}, instant rollback ${ans('instant_rollback')}`,
  ];
  const rm = data.readingMap;
  if (!rm) return [...head, '- Reading map: not generated.'];
  return [
    ...head,
    `- Read yourself: ${rm.totals.read_yourself.hunks} hunks, about ${rm.totals.read_yourself.minutes} min (whole diff ${rm.totals.whole.minutes} min). Full map: \`${data.runRel}/reading-map.md\``,
    ...rm.groups.read_yourself.map((e, i) => `${i + 1}. \`${e.ref}\` · ${e.reasons.join(', ')}`),
  ];
}

function genRollout(data) {
  const knob = data.tree && data.tree.knobs ? data.tree.knobs.instant_rollback.answer : 'unknown';
  const body = planSection(data.planText);
  return [`- Instant rollback: ${knob}`, ...(body ? body.split('\n').filter((l) => l.trim()) : ['- No rollback or flag plan was recorded.'])];
}

function genDecisions(data) {
  const closed = closedIds(data.records);
  const dissent = data.records.filter((r) => !closed.has(r.id) && (r.agent === 'spine:devils-advocate' || (typeof r.dissent === 'string' && r.dissent)));
  const waivers = data.records.filter((r) => r.agent === 'spine:orchestrator' && Array.isArray(r.waives));
  return [
    ...dissent.map((r) => `- ${r.id}: ${short(r.claim)} (dissent: ${short(r.dissent || "devil's advocate", 80)})`),
    ...waivers.map((r) => `- ${r.id}: UNPROVEN accepted at G3 for ${r.waives.join(', ')}`),
    ...data.specAssumptions.map((a) => `- Spec assumption: ${short(a)}`),
  ];
}

function genChecked(data) {
  const review = data.review || {};
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const counts = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const present = ((data.proof && data.proof.present) || []).map((p) => `${p.requirement}${p.record_ids.length ? ` (${p.record_ids.join(', ')})` : ''}`);
  return [
    `- Reviewers: ${(review.providers || []).join(', ') || 'none recorded'}`,
    `- Findings: ${counts.length ? counts.map(([s, n]) => `${n} ${s}`).join(', ') : 'none above INFO'}; fixed in the review loop: ${data.records.filter((r) => typeof r.resolves === 'string').length}`,
    `- Cross-author verification rounds: ${data.records.filter((r) => typeof r.verifies === 'string').length}`,
    `- Verdict: ${review.verdict || 'unknown'}${review.tier ? ` (change tier ${review.tier})` : ''}`,
    ...(present.length ? [`- Proof present: ${present.join(', ')}`] : []),
  ];
}

function genNotVerified(data) {
  const proof = data.proof || {};
  const unverifiedOnly = (r) => Array.isArray(r.evidence) && r.evidence.length > 0 && r.evidence.every((e) => e.kind === 'unverified') && r.severity !== 'INFO';
  return [
    ...(proof.missing || []).map((m) => `- ${m.requirement}: ${listFiles(m.files)} (${m.reason})`),
    ...data.records.filter(unverifiedOnly).map((r) => `- ${r.id}: ${short(r.claim)} (unverified evidence only)`),
    ...(proof.info || []).map((i) => `- ${i.requirement} skipped: ${i.reason}`),
    ...data.records.filter((r) => r.severity === 'INFO' && /\bskipped\b/i.test(String(r.claim))).map((r) => `- ${r.id}: ${short(r.claim)}`),
  ];
}

function genHowToTest(data) {
  const cmds = [...new Set(data.records.filter((r) => r.proof_kind && r.result && typeof r.result.command === 'string').map((r) => r.result.command))];
  return cmds.map((c) => `- \`${c.replace(/`/g, "'")}\``);
}

const GENERATORS = Object.freeze({ reading_map: genReadingMap, rollout: genRollout, decisions: genDecisions, checked: genChecked, not_verified: genNotVerified, how_to_test: genHowToTest });

function capLines(lines, cap, note) {
  if (lines.length <= cap) return lines;
  const keep = lines.slice(0, cap - 1);
  return [...keep, `- ...and ${lines.length - keep.length} more (${note})`];
}

function capRows(rows, cap, note) {
  if (rows.length <= cap) return rows;
  const keep = rows.slice(0, cap - 1);
  return [...keep, `| ...and ${rows.length - keep.length} more | | | | ${note} |`];
}

function generated(s, data, cap) {
  const note = `see ${data.runRel}`;
  if (s.key === 'changed') {
    const header = ['| Area | Files | Lines | Tier | What |', '|---|---|---|---|---|'];
    const rows = genChanged(data);
    return [...header, ...capRows(rows.length ? rows : ['| (none) | 0 | +0 / -0 | leaf | empty diff |'], cap - header.length, note)];
  }
  const lines = GENERATORS[s.key](data);
  return capLines(lines.length ? lines : [EMPTY_TEXT[s.key]], cap, note);
}

function parseWritten(text) {
  const out = new Map();
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = m[1];
      out.set(current, []);
    } else if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join('\n').trim()]));
}

function checkWritten(s, body, tier, cap) {
  if (!body) return [`missing written section "## ${s.title}"`];
  const errors = [];
  const n = body.split('\n').filter((l) => l.trim()).length;
  if (n > cap) errors.push(`"## ${s.title}" has ${n} lines; the cap for ${tier} is ${cap}`);
  if (s.key === 'problem' && (!/\bbefore\b/i.test(body) || !/\bafter\b/i.test(body))) errors.push(`"## ${s.title}" needs a before and an after example`);
  if (ATTRIBUTION.test(body)) errors.push(`"## ${s.title}" contains an attribution line`);
  return errors;
}

function sectionsFor(tier, notVerifiedCount) {
  return SECTIONS.filter((s) => s.tiers.includes(tier) || (s.key === 'not_verified' && notVerifiedCount > 0));
}

function buildPrBody(data, writtenText) {
  const written = parseWritten(writtenText);
  const chosen = sectionsFor(data.tier, genNotVerified(data).length);
  const errors = [];
  const parts = chosen.map((s) => {
    const cap = s.caps[data.tier];
    if (s.source === 'generated') return `## ${s.title}\n\n${generated(s, data, cap).join('\n')}\n`;
    const body = written.get(s.title) || '';
    errors.push(...checkWritten(s, body, data.tier, cap));
    return `## ${s.title}\n\n${body}\n`;
  });
  return { ok: errors.length === 0, tier: data.tier, sections: chosen.map((s) => s.key), errors, body: errors.length ? null : parts.join('\n') };
}

module.exports = { SECTIONS, sectionsFor, parseWritten, buildPrBody };
