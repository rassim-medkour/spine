'use strict';

const STRONG = new Set(['CRITICAL', 'HIGH']);
const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const NO_AUTHOR_NOTE = 'no independent author available';

// Same rule as workflows/review.workflow.js evidenceKey.
function evidenceKey(f) {
  const first = (Array.isArray(f.evidence) && f.evidence[0]) || { ref: f.claim };
  const m = /^([^:]+):(\d+)/.exec(first.ref);
  return m ? `${m[1]}:${m[2]}` : String(first.ref).toLowerCase();
}

function isFinding(r) {
  return r && r.stage === 'review' && !r.verifies && typeof r.agent === 'string' && !r.agent.startsWith('spine:');
}

function authorsOf(r, authorOf) {
  if (Array.isArray(r.authors) && r.authors.length) return r.authors;
  if (typeof r.author === 'string' && r.author) return [r.author];
  const a = authorOf(r.provider || r.agent);
  return a ? [a] : [];
}

function groupFindings(records, authorOf = () => null) {
  const groups = new Map();
  for (const r of records.filter(isFinding)) {
    const key = evidenceKey(r);
    const g = groups.get(key) || { key, records: [], authors: [], severity: 'INFO' };
    const authors = [...new Set([...g.authors, ...authorsOf(r, authorOf)])];
    const severity = SEVERITY_ORDER.indexOf(r.severity) > SEVERITY_ORDER.indexOf(g.severity) ? r.severity : g.severity;
    groups.set(key, { ...g, records: [...g.records, r], authors, severity });
  }
  return [...groups.values()];
}

// Same rule as workflows/review.workflow.js pickVerifier.
function pickVerifier(group, providers) {
  const others = providers.filter((p) => !group.authors.includes(p.author)).sort((a, b) => a.rank - b.rank);
  return others[0] || null;
}

function verifierPlan(records, providers, authorOf = () => null) {
  return groupFindings(records, authorOf).filter((g) => STRONG.has(g.severity)).map((g) => {
    const verifier = pickVerifier(g, providers);
    return { record_id: g.records[0].id, record_ids: g.records.map((r) => r.id), severity: g.severity, verifier, note: verifier ? null : NO_AUTHOR_NOTE };
  });
}

function latestVerification(records, ids) {
  const matches = records.filter((r) => r.verifies && ids.includes(r.verifies));
  return matches.length ? matches[matches.length - 1] : null;
}

function daGateOpen(records, devilsAdvocate) {
  if (!devilsAdvocate) return { open: false, reason: 'class.devils_advocate is false' };
  const groups = groupFindings(records);
  const refuted = groups.filter((g) => STRONG.has(g.severity)).filter((g) => {
    const v = latestVerification(records, g.records.map((r) => r.id));
    if (!v) return true;
    return v.verified !== true && v.verifier_note !== NO_AUTHOR_NOTE;
  });
  if (refuted.length) return { open: false, reason: `${refuted.length} strong finding(s) refuted or unverified` };
  const kinds = new Set(groups.flatMap((g) => g.records.flatMap((r) => r.evidence.map((e) => e.kind))).filter((k) => k !== 'unverified'));
  if (kinds.size < 2) return { open: false, reason: `only ${kinds.size} evidence kind(s)` };
  return { open: true, reason: 'gate passes' };
}

function checkCrossAuthor(records, authorOf = () => null) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const groups = groupFindings(records, authorOf);
  const violations = [];
  for (const v of records.filter((r) => r.verifies)) {
    const target = byId.get(v.verifies);
    if (!target) {
      violations.push(`${v.id} verifies unknown record ${v.verifies}`);
      continue;
    }
    if (v.verified === true && v.verifier_note === NO_AUTHOR_NOTE) {
      violations.push(`${v.id} counts ${target.id} as verified without an independent author`);
      continue;
    }
    if (v.verifier_note === NO_AUTHOR_NOTE) continue;
    const group = groups.find((g) => g.records.some((r) => r.id === target.id));
    const raisers = group ? group.authors : authorsOf(target, authorOf);
    const verifiers = authorsOf(v, authorOf);
    const shared = verifiers.find((a) => raisers.includes(a));
    if (!verifiers.length) violations.push(`${v.id} has no resolvable author`);
    else if (shared) violations.push(`${v.id} verifies ${target.id} with the same author ${shared}`);
  }
  return violations;
}

function authorIndex(registries) {
  const map = new Map();
  for (const reg of registries) for (const list of Object.values(reg)) for (const p of list) map.set(p.id, p.author);
  return (id) => {
    if (!id) return null;
    if (map.has(id)) return map.get(id);
    return String(id).startsWith('spine:') ? 'spine' : null;
  };
}

module.exports = { NO_AUTHOR_NOTE, evidenceKey, isFinding, groupFindings, pickVerifier, verifierPlan, daGateOpen, checkCrossAuthor, authorIndex };
