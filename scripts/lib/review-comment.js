'use strict';
// The review comment for someone else's PR: verdict and tier, what to read
// yourself, findings by severity, proof, and what is not verified. Built from
// the run files only; posting it is the human's call.

const MAX_CHARS = 60000; // GitHub caps a comment at 65536.
const MAX_LINES = 200; // per section
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// Reviewer text is untrusted: one line, no code-span breakout, no HTML, no @-mentions.
function clean(s, n = 300) {
  const t = String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=[\w-])/g, '@​')
    .trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

function loc(ref, ctx) {
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(String(ref || ''));
  const label = `\`${clean(ref, 200)}\``;
  if (!m || !ctx.link) return label;
  const file = m[1].replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return `[${label}](https://github.com/${ctx.repo}/blob/${ctx.sha}/${file}#L${m[2]})`;
}

const firstRef = (r) => (Array.isArray(r.evidence) && r.evidence[0] ? r.evidence[0].ref : '');
const line = (r, ctx, prefix = '') => `- ${prefix}${loc(firstRef(r), ctx)} · ${clean(r.claim)} · ${r.id}`;

function capped(lines) {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- ... ${lines.length - MAX_LINES} more (truncated; see the run's records)`] : lines;
}

function readingLines(rm) {
  if (!rm || !rm.totals || !rm.groups) return [];
  const read = (rm.groups.read_yourself || []).slice(0, 8)
    .map((e, i) => `${i + 1}. \`${clean(e.ref, 200)}\`${e.records && e.records.length ? ` (${e.records.join(', ')})` : ''}`);
  const out = [`**Read yourself (${rm.totals.read_yourself.minutes} min):** ${read.join(' · ') || 'nothing'}`];
  const later = rm.totals.read_if_time;
  if (later && later.hunks) out.push('', `**Then, if you have time (${later.minutes} min):** ${later.hunks} more hunks in the reading map.`);
  return out;
}

function proofLines(records, proof) {
  const ran = records.filter((r) => r.agent === 'spine:proof' && r.result).map((r) => {
    const res = r.result;
    if (typeof res.plan === 'string') return `- ran: ${r.proof_kind} ✓ plan recorded`;
    const ok = res.exit_code === 0 && (!res.status || res.status === 'ok');
    const counts = res.counts ? `${res.counts.pass} pass${res.counts.fail ? `, ${res.counts.fail} fail` : ''}` : `exit ${res.exit_code}`;
    return `- ran: ${r.proof_kind} ${ok ? '✓' : '✗'} ${counts}${res.command ? ` (\`${clean(res.command, 120)}\`)` : ''}`;
  });
  const missing = ((proof && proof.missing) || []).map((m) => `- missing: ${m.requirement} · ${(m.files || []).map((f) => clean(f, 120)).join(', ') || 'whole change'}`);
  return [...ran, ...missing];
}

function buildReviewComment({ review, records, readingMap, proof, repo, sha }) {
  const ctx = { link: REPO_RE.test(String(repo || '')) && SHA_RE.test(String(sha || '')), repo, sha };
  const byId = new Map(records.map((r) => [r.id, r]));
  const ids = [...new Set([...(review.findings || []).map((f) => f.record_id), ...(review.dissent || [])])];
  const listed = ids.map((id) => byId.get(id)).filter(Boolean);
  const strong = (r) => r.severity === 'CRITICAL' || r.severity === 'HIGH';

  const blocking = listed.filter((r) => strong(r) && r.verified === true).map((r) => line(r, ctx));
  const shouldFix = listed.filter((r) => r.severity === 'MEDIUM').map((r) => line(r, ctx));
  const nits = listed.filter((r) => r.severity === 'LOW').map((r) => line(r, ctx));
  const notVerified = [
    ...listed.filter((r) => strong(r) && r.verified !== true).map((r) => line(r, ctx, `${r.severity} not verified: `)),
    ...listed.filter((r) => typeof r.verifier_note === 'string' && r.verifier_note).map((r) => `- ${clean(r.verifier_note)} · ${r.id}`),
  ];
  const proofs = proofLines(records, proof);

  const out = [`## Spine review · verdict ${clean(review.verdict || 'pending', 40)} · tier ${clean(review.tier || 'unknown', 20)}`, ''];
  const reading = readingLines(readingMap);
  if (reading.length) out.push(...reading, '');
  if (!listed.length) out.push('No findings.', '');
  if (blocking.length) out.push('### Blocking', '', ...capped(blocking), '');
  if (shouldFix.length) out.push('### Should fix', '', ...capped(shouldFix), '');
  if (nits.length) out.push('### Nits', '', `<details><summary>${nits.length} LOW</summary>`, '', ...capped(nits), '', '</details>', '');
  if (proofs.length) out.push('### Proof', '', ...capped(proofs), '');
  if (notVerified.length) out.push('### Not verified', '', ...capped(notVerified), '');

  const body = `${out.join('\n').trimEnd()}\n`;
  if (body.length <= MAX_CHARS) return body;
  const note = '\n\n_... truncated; the full list is in the run records._\n';
  const cut = body.slice(0, MAX_CHARS - note.length - 20);
  const open = (cut.match(/<details>/g) || []).length > (cut.match(/<\/details>/g) || []).length;
  return `${cut.slice(0, cut.lastIndexOf('\n'))}${open ? '\n\n</details>' : ''}${note}`;
}

module.exports = { buildReviewComment, MAX_CHARS };
