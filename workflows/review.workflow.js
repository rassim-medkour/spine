export const meta = {
  name: 'spine-internal-review',
  description: 'Cross-provider review: each selected provider finds, findings are merged by evidence, CRITICAL and HIGH are verified by a different author, then the devils advocate runs if the gate allows.',
  phases: [
    { title: 'Find', detail: 'one reviewer per provider, in parallel' },
    { title: 'Verify', detail: 'a different author tries to refute each CRITICAL/HIGH' },
    { title: 'Dissent', detail: 'devils advocate, only when the gate passes' }
  ]
};

// args: { diff, changedFiles, language, providers, devilsAdvocate, runId, stage, tree? }
if (!args || typeof args.diff !== 'string' || !args.diff.trim()) throw new Error('spine-internal-review: args.diff is required. This is an internal step of the spine skill; run /spine:spine-review <pr|branch|--diff> instead.');
if (!Array.isArray(args.providers) || !args.providers.length) throw new Error('spine-internal-review: args.providers is required');
const changedFiles = Array.isArray(args.changedFiles) ? args.changedFiles : [];
const oneLine = (s) => String(s).replace(/[\r\n]+/g, '');
const tree = args.tree && typeof args.tree.tier === 'string' && Array.isArray(args.tree.files) ? args.tree : null;

// --- spine model routing (identical in all three workflows; pinned by tests/workflow-model-parity.test.js) ---
const MODEL_CLASS_RANK = { cheap: 0, mid: 1, top: 2 };
const WEAK_VERIFIER_NOTE = 'verifier below finder strength';
const modelArgs = args.models && typeof args.models === 'object' && !Array.isArray(args.models) && args.models.roles && typeof args.models.roles === 'object' && !Array.isArray(args.models.roles) ? args.models : null;
const modelBlocks = {};
const notRun = [];
function markNotRun(label) {
  const requested = modelBlocks[label] && modelBlocks[label].requested;
  if (modelArgs && requested && !notRun.includes(label)) notRun.push(label);
}
function plannedFor(role) {
  const r = modelArgs ? modelArgs.roles[role] : null;
  if (!r || typeof r !== 'object') return null;
  return { class: typeof r.class === 'string' ? r.class : null, model: typeof r.model === 'string' && r.model ? r.model : null };
}
function blockFor(role, planned, source, reason) {
  const b = { role, tier: modelArgs.tier || null, tier_source: modelArgs.tier_source || null, class: planned ? planned.class : null, requested: planned ? planned.model : null, source };
  return reason ? { ...b, reason } : b;
}
function effectiveClass(block) {
  return block && (block.source === 'requested' || block.source === 'floor-raised') ? block.class : 'session';
}
function floorClass(cls, raiserClasses) {
  if (!(cls in MODEL_CLASS_RANK)) return { class: cls, raised: false };
  let best = cls;
  for (const c of raiserClasses) if (c in MODEL_CLASS_RANK && MODEL_CLASS_RANK[c] > MODEL_CLASS_RANK[best]) best = c;
  return { class: best, raised: best !== cls };
}
function isWeakVerifier(verifierBlock, raiserBlocks) {
  if (!modelArgs || modelArgs.tier !== 'trunk' || modelArgs.kill_switch) return false;
  const v = effectiveClass(verifierBlock);
  if (v === 'pinned') return false;
  const raisers = raiserBlocks.map(effectiveClass).filter((c) => c in MODEL_CLASS_RANK);
  if (!(v in MODEL_CLASS_RANK)) return raisers.some((c) => MODEL_CLASS_RANK[c] > 0);
  return raisers.some((c) => MODEL_CLASS_RANK[c] > MODEL_CLASS_RANK[v]);
}
async function routed(role, prompt, opts, floorFrom) {
  if (!modelArgs) return agent(prompt, opts);
  let planned = plannedFor(role);
  let source = planned && planned.model ? 'requested' : 'inherit';
  let reason = null;
  if (planned && floorFrom && modelArgs.tier === 'trunk' && !modelArgs.kill_switch) {
    const f = floorClass(planned.class, floorFrom.map((label) => effectiveClass(modelBlocks[label])));
    const ids = modelArgs.class_ids && typeof modelArgs.class_ids === 'object' ? modelArgs.class_ids : {};
    if (f.raised && typeof ids[f.class] === 'string' && ids[f.class]) {
      reason = `policy_clamped: raised from ${planned.class} to ${f.class} (finder class)`;
      planned = { class: f.class, model: ids[f.class] };
      source = 'floor-raised';
    }
  }
  if (!planned || !planned.model) {
    modelBlocks[opts.label] = blockFor(role, planned, 'inherit');
    const direct = await agent(prompt, opts);
    if (!direct) markNotRun(opts.label);
    return direct;
  }
  let result = null;
  let failure = null;
  try {
    result = await agent(prompt, { ...opts, model: planned.model });
  } catch (e) {
    failure = e;
  }
  if (result) {
    modelBlocks[opts.label] = blockFor(role, planned, source, reason);
    return result;
  }
  const why = failure ? `model ${planned.model} failed: ${String(failure && failure.message).replace(/\s+/g, ' ').slice(0, 120)}` : `model ${planned.model} returned nothing`;
  log(`${opts.label}: ${why}; retrying once on the session model`);
  modelBlocks[opts.label] = blockFor(role, planned, 'session-fallback', why);
  const retry = await agent(prompt, opts);
  if (!retry) markNotRun(opts.label);
  return retry;
}
function didNotRunRecords(stage, agentFor, startIndex) {
  if (!modelArgs) return [];
  return notRun.map((label, i) => ({
    id: `R-${String(startIndex + i + 1).padStart(4, '0')}`,
    stage,
    agent: agentFor(label),
    provider: agentFor(label),
    claim: `agent did not run: ${label}`,
    evidence: [{ kind: 'unverified', ref: `workflow:${label}` }],
    confidence: 1,
    severity: 'INFO',
    dissent: null,
    resolution: null,
    alternatives: [],
    model: modelBlocks[label] || blockFor('implementer', null, 'fallback-error'),
  }));
}
// --- end spine model routing ---

function tierContext() {
  if (!tree) return '';
  const trunk = tree.files.filter((f) => f && f.tier === 'trunk' && typeof f.path === 'string').map((f) => oneLine(f.path)).slice(0, 20);
  return `\nChange tier: ${oneLine(tree.tier)}. Trunk files (read these hardest): ${trunk.length ? trunk.join(', ') : 'none'}.`;
}

const EVIDENCE = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['file', 'test', 'command', 'doc', 'unverified'] },
    ref: { type: 'string' },
    note: { type: 'string' }
  },
  required: ['kind', 'ref']
};

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          confidence: { type: 'number' },
          evidence: { type: 'array', items: EVIDENCE },
          alternatives: { type: 'array', items: { type: 'string' } }
        },
        required: ['claim', 'severity', 'confidence', 'evidence']
      }
    }
  },
  required: ['findings']
};

const DA_FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          confidence: { type: 'number' },
          evidence: { type: 'array', items: EVIDENCE },
          alternatives: { type: 'array', items: { type: 'string' } },
          dissent: { type: 'string' },
          resolution: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['test', 'spike', 'question'] },
              text: { type: 'string' }
            },
            required: ['kind', 'text']
          }
        },
        required: ['claim', 'severity', 'confidence', 'evidence', 'dissent', 'resolution']
      }
    }
  },
  required: ['findings']
};

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: EVIDENCE }
  },
  required: ['refuted', 'reason', 'evidence']
};

const CONTRACT = 'Follow the Spine record contract: one falsifiable claim per finding, evidence as path:line or exact command, confidence 0-1, severity CRITICAL/HIGH/MEDIUM/LOW/INFO. A finding whose evidence is only "unverified" may not be HIGH or CRITICAL.';

function finderPrompt(p) {
  let how;
  if (p.kind === 'skill') how = `Invoke the skill ${p.id} with the Skill tool and apply it to the diff below.`;
  else if (p.kind === 'tool') how = `Use the ${p.id} tool on the diff below and normalize its output.`;
  else how = `Review the diff below as ${p.id} would.`;
  return `${how}\nYour strengths: ${p.strengths.join(', ')}.\n${CONTRACT}\nChanged files: ${changedFiles.join(', ')}\nLanguage: ${args.language || 'unknown'}${tierContext()}\n\nDIFF:\n${args.diff}`;
}

function agentTypeFor(p) {
  return p.kind === 'agent' ? p.id : 'general-purpose';
}

function evidenceKey(f) {
  const first = f.evidence[0] || { ref: f.claim };
  const m = /^([^:]+):(\d+)/.exec(first.ref);
  return m ? `${m[1]}:${m[2]}` : first.ref.toLowerCase();
}

const SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

phase('Find');
const failedProviders = [];
const raw = await parallel(args.providers.map((p) => () =>
  routed('finder', finderPrompt(p), { label: `find:${p.id}`, phase: 'Find', schema: FINDINGS, agentType: agentTypeFor(p) })
    .catch((e) => {
      markNotRun(`find:${p.id}`);
      failedProviders.push(p.id);
      log(`find:${p.id} failed: ${e && e.message}`);
      return null;
    })
    .then((r) => (r ? r.findings.map((f) => ({ ...f, provider: p.id, author: p.author })) : []))
));

const merged = new Map();
for (const f of raw.filter(Boolean).flat()) {
  const key = evidenceKey(f);
  const seen = merged.get(key);
  if (!seen) {
    merged.set(key, { ...f, providers: [f.provider], authors: [f.author], corroboration: 1 });
  } else {
    seen.corroboration += 1;
    seen.providers.push(f.provider);
    seen.authors.push(f.author);
    if (SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(seen.severity)) seen.severity = f.severity;
  }
}
// Exact file:line keys miss reviewers who cite the same problem at different
// lines, so one cheap agent groups same-claim findings. Any doubt about its
// reply keeps the findings as they were.
const MERGE = {
  type: 'object',
  properties: { groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } },
  required: ['groups']
};

function validGroups(groups, size) {
  if (!Array.isArray(groups)) return false;
  const seen = new Set();
  for (const g of groups) {
    if (!Array.isArray(g) || g.length < 2) return false;
    for (const i of g) {
      if (!Number.isInteger(i) || i < 0 || i >= size || seen.has(i)) return false;
      seen.add(i);
    }
  }
  return true;
}

function mergeGroup(members) {
  const top = members.reduce((a, b) => (SEVERITY_ORDER.indexOf(b.severity) > SEVERITY_ORDER.indexOf(a.severity) ? b : a));
  const refs = new Set();
  const evidence = members.flatMap((m) => m.evidence).filter((e) => (refs.has(e.ref) ? false : refs.add(e.ref)));
  // Every member's claim stays on the record, so a grouping never hides one.
  const others = members.filter((m) => m !== top).map((m) => `${m.severity} (${m.providers.join(', ')}): ${oneLine(m.claim)}`);
  return {
    ...top,
    evidence,
    alternatives: [...(top.alternatives || []), ...others],
    providers: [...new Set(members.flatMap((m) => m.providers))],
    authors: [...new Set(members.flatMap((m) => m.authors))],
    corroboration: members.reduce((n, m) => n + m.corroboration, 0)
  };
}

async function mergeSameClaims(list) {
  if (list.length < 2) return list;
  const numbered = list.map((f, i) => ({ i, claim: oneLine(f.claim).slice(0, 300), at: f.evidence.map((e) => e.ref).slice(0, 3), severity: f.severity }));
  const reply = await routed(
    'synthesis',
    `These review findings come from different reviewers. Group the ones that describe the same underlying problem, even when they cite different lines or files. Group only findings you are sure are the same problem; leave the rest out. Return { "groups": [[i, j, ...]] } using the i values below; each i in at most one group, every group with two or more.\n\n${JSON.stringify(numbered)}`,
    { label: 'merge', phase: 'Find', schema: MERGE }
  ).catch((e) => {
    markNotRun('merge');
    log(`merge failed: ${e && e.message}`);
    return null;
  });
  if (!reply || !validGroups(reply.groups, list.length)) return list;
  // Two CRITICAL/HIGH claims are never folded together: each must reach its own verifier.
  const strongCount = (g) => g.filter((i) => list[i].severity === 'CRITICAL' || list[i].severity === 'HIGH').length;
  const groups = reply.groups.filter((g) => strongCount(g) <= 1);
  const grouped = new Set(groups.flat());
  return [...list.filter((_, i) => !grouped.has(i)), ...groups.map((g) => mergeGroup(g.map((i) => list[i])))];
}

const findings = await mergeSameClaims([...merged.values()]);
log(`spine-internal-review: ${raw.filter(Boolean).flat().length} raw findings, ${findings.length} unique`);

const strong = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
const advisory = findings.filter((f) => !strong.includes(f));

function pickVerifier(f) {
  const others = args.providers.filter((p) => !f.authors.includes(p.author)).sort((a, b) => a.rank - b.rank);
  return others[0] || null;
}

function verifierPromptFor(p, f) {
  let how;
  if (p && p.kind === 'skill') how = `Invoke the skill ${p.id} with the Skill tool and use its method to try to REFUTE this finding.`;
  else if (p && p.kind === 'tool') how = `Use the ${p.id} tool to try to REFUTE this finding.`;
  else how = 'Try to REFUTE this review finding.';
  return `${how} Default to refuted=true if you cannot confirm it from the code. Finding: ${f.claim}. Evidence: ${JSON.stringify(f.evidence)}. Read the cited lines and neighbours; run a test if one is cited. ${CONTRACT}\n\nDIFF:\n${args.diff}`;
}

function verifierAgentTypeFor(p) {
  return p && p.kind === 'agent' ? p.id : 'general-purpose';
}

phase('Verify');
const verified = await pipeline(strong, (f, _item, i) => {
  const verifier = pickVerifier(f);
  const verifierNote = verifier ? null : 'no independent author available';
  return routed(
    'verifier',
    verifierPromptFor(verifier, f),
    { label: `verify:${i}`, phase: 'Verify', schema: VERDICT, agentType: verifierAgentTypeFor(verifier) },
    f.providers.map((id) => `find:${id}`)
  )
    .catch((e) => {
      markNotRun(`verify:${i}`);
      log(`verify:${i} failed: ${e && e.message}`);
      return null;
    })
    .then((v) => {
      const base = { ...f, verified: v ? !v.refuted : false, verdict: v, verifier_note: verifierNote };
      if (!modelArgs) return base;
      const weak = isWeakVerifier(modelBlocks[`verify:${i}`], f.providers.map((id) => modelBlocks[`find:${id}`]));
      return { ...base, verify_label: `verify:${i}`, ...(weak ? { model_note: WEAK_VERIFIER_NOTE } : {}) };
    });
});

const checked = verified.filter(Boolean);
const survivors = checked.filter((f) => f.verified && !f.model_note);
const refuted = checked.filter((f) => !f.verified || f.model_note);
const kinds = new Set(findings.flatMap((f) => f.evidence.map((e) => e.kind)).filter((k) => k !== 'unverified'));
const gateOpen = Boolean(args.devilsAdvocate) && refuted.length === 0 && kinds.size >= 2;
log(`spine-internal-review: ${survivors.length} verified, ${refuted.length} refuted, devils advocate ${gateOpen ? 'ON' : 'off'}`);

let dissent = [];
if (gateOpen) {
  phase('Dissent');
  const da = await routed(
    'devils_advocate',
    `Consensus findings (all verified by a second author): ${JSON.stringify(survivors.map((f) => ({ claim: f.claim, severity: f.severity, evidence: f.evidence })))}. Build the strongest case against them. ${CONTRACT}\n\nDIFF:\n${args.diff}`,
    { label: 'devils-advocate', phase: 'Dissent', schema: DA_FINDINGS, agentType: 'spine:devils-advocate' },
    survivors.flatMap((f) => f.providers.map((id) => `find:${id}`))
  ).catch((e) => {
    markNotRun('devils-advocate');
    log(`devils-advocate failed: ${e && e.message}`);
    return null;
  });
  dissent = da ? da.findings.map((f) => ({ ...f, provider: 'spine:devils-advocate', author: 'spine' })) : [];
  // The devils advocate's own CRITICAL and HIGH claims get a verifier too; one
  // the verifier does not confirm drops to MEDIUM, so it never stands as HIGH unchecked.
  const daVerifier = [...args.providers].sort((a, b) => a.rank - b.rank)[0] || null;
  dissent = await pipeline(dissent, (f, _item, i) => {
    if (f.severity !== 'CRITICAL' && f.severity !== 'HIGH') return f;
    const label = `verify-da:${i}`;
    return routed('verifier', verifierPromptFor(daVerifier, f), { label, phase: 'Dissent', schema: VERDICT, agentType: verifierAgentTypeFor(daVerifier) }, ['devils-advocate'])
      .catch((e) => {
        markNotRun(label);
        log(`${label} failed: ${e && e.message}`);
        return null;
      })
      .then((v) => (v && !v.refuted
        ? { ...f, verified: true, verify_label: label }
        : { ...f, severity: 'MEDIUM', verified: false, verifier_note: `devils advocate ${f.severity} not confirmed by a verifier${v && v.reason ? `: ${oneLine(v.reason)}` : ''}` }));
  });
}

function modelFields(f, role) {
  if (!modelArgs) return {};
  const own = modelBlocks[role === 'devils_advocate' ? 'devils-advocate' : `find:${f.provider}`];
  return {
    ...(own ? { model: own } : {}),
    ...(f.verify_label && modelBlocks[f.verify_label] ? { verifier_model: modelBlocks[f.verify_label] } : {}),
    ...(f.model_note ? { model_note: f.model_note } : {})
  };
}

function toRecord(f, index, agentName, role) {
  return {
    id: `R-${String(index + 1).padStart(4, '0')}`,
    stage: args.stage || 'review',
    agent: agentName,
    provider: f.provider,
    claim: f.claim,
    evidence: f.evidence,
    confidence: f.confidence,
    severity: f.severity,
    dissent: f.dissent != null ? f.dissent : (f.verdict && f.verdict.refuted ? f.verdict.reason : null),
    resolution: f.resolution || null,
    alternatives: f.alternatives || [],
    corroboration: f.corroboration || 1,
    verified: Boolean(f.verified) && !f.model_note,
    verifier_note: f.verifier_note || null,
    ...modelFields(f, role)
  };
}

const findingRecords = [
  ...checked.map((f, i) => toRecord(f, i, f.providers[0], 'finder')),
  ...advisory.map((f, i) => toRecord(f, checked.length + i, f.providers[0], 'finder')),
  ...dissent.map((f, i) => toRecord({ ...f, verified: Boolean(f.verified) }, checked.length + advisory.length + i, 'spine:devils-advocate', 'devils_advocate'))
];
const records = [
  ...findingRecords,
  ...didNotRunRecords(args.stage || 'review', (label) => (label === 'devils-advocate' ? 'spine:devils-advocate' : label === 'merge' ? 'spine:synthesis' : label.startsWith('verify') ? 'spine:verifier' : label.replace(/^find:/, '')), findingRecords.length)
];

return {
  records,
  findings: checked.concat(advisory),
  dissent,
  failed_providers: failedProviders,
  ...(failedProviders.length ? { verdict_note: `${failedProviders.length} of ${args.providers.length} providers failed` } : {})
};
