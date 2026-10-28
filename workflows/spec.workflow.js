export const meta = {
  name: 'spine-internal-spec',
  description: 'Spec drafting fan-out: each lens reads the intent through its own concern and proposes requirements, risks, and questions; a synthesis pass merges them and surfaces where lenses disagree.',
  phases: [
    { title: 'Lenses', detail: 'domain, architecture, data, security, ops, testability' },
    { title: 'Synthesis', detail: 'merge sections, list disagreements' }
  ]
};

// args: { intentText, lenses, providers, runId }
if (!args || typeof args.intentText !== 'string' || !args.intentText.trim()) throw new Error('spine-internal-spec: args.intentText is required. This is an internal step of the spine skill; run /spine:spine-spec "<request>" instead.');
const lenses = Array.isArray(args.lenses) && args.lenses.length ? args.lenses : ['domain', 'architecture', 'data', 'security', 'ops', 'testability'];
const providers = Array.isArray(args.providers) ? args.providers : [];

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

const SECTION = {
  type: 'object',
  properties: {
    requirements: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } }
  },
  required: ['requirements', 'risks', 'questions', 'assumptions']
};

const MERGE = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } },
    error_paths: { type: 'array', items: { type: 'string' } },
    data_and_migrations: { type: 'array', items: { type: 'string' } },
    test_anchors: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    dissent: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lens_a: { type: 'string' },
          lens_b: { type: 'string' },
          topic: { type: 'string' },
          positions: { type: 'array', items: { type: 'string' } },
          resolution: { type: 'string' }
        },
        required: ['lens_a', 'lens_b', 'topic', 'positions', 'resolution']
      }
    }
  },
  required: ['summary', 'requirements', 'error_paths', 'data_and_migrations', 'test_anchors', 'assumptions', 'out_of_scope', 'dissent']
};

const LENS_FOCUS = {
  domain: 'the business rules, the ubiquitous language, and what the user actually needs',
  architecture: 'module boundaries, interfaces, and how this fits existing components',
  data: 'stored shapes, migrations, rollback, and data integrity',
  security: 'authentication, authorization, PII, input validation, and abuse cases',
  ops: 'deployment, observability, failure modes, and rollback in production',
  testability: 'how each requirement becomes a named test, and what is hard to test'
};

function providerFor(index) {
  return providers.length ? providers[index % providers.length] : null;
}

function lensPrompt(lens, index) {
  const p = providerFor(index);
  const skillLine = p && p.kind === 'skill' ? `First invoke the skill ${p.id} with the Skill tool and apply its method.` : '';
  return `You are the ${lens} lens for a spec. Focus only on ${LENS_FOCUS[lens] || lens}. ${skillLine}
Read the intent below. Propose requirements (each one sentence, testable), risks, questions for the human, and assumptions you would write down if no answer comes. Do not cover other lenses' concerns.

INTENT:
${args.intentText}`;
}

const failedLenses = [];

phase('Lenses');
const sections = await parallel(lenses.map((lens, i) => () =>
  routed('spec_lens', lensPrompt(lens, i), { label: `lens:${lens}`, phase: 'Lenses', schema: SECTION })
    .catch((e) => {
      markNotRun(`lens:${lens}`);
      failedLenses.push(lens);
      log(`lens:${lens} failed: ${e && e.message}`);
      return null;
    })
    .then((s) => {
      if (!s) return null;
      const p = providerFor(i);
      return { lens, provider: p ? p.id : 'inline', ...s };
    })
));
const good = sections.filter(Boolean);
log(`spine-internal-spec: ${good.length}/${lenses.length} lenses returned`);

phase('Synthesis');
const merged = await routed(
  'synthesis',
  `Merge these lens sections into one spec draft. Keep every requirement, dedupe exact duplicates, and where two lenses disagree record it under dissent with both positions and the evidence that would settle it (a test, a spike, or a question). Do not invent requirements that no lens proposed.

SECTIONS:
${JSON.stringify(good, null, 2)}

INTENT:
${args.intentText}`,
  { label: 'synthesis', phase: 'Synthesis', schema: MERGE }
).catch((e) => {
  markNotRun('synthesis');
  log(`synthesis failed: ${e && e.message}`);
  return null;
});

const records = good.map((s, i) => ({
  id: `R-${String(i + 1).padStart(4, '0')}`,
  stage: 'spec',
  agent: 'spine:lens',
  provider: s.provider,
  claim: `${s.lens} lens proposed ${s.requirements.length} requirement(s), ${s.risks.length} risk(s)`,
  evidence: [{ kind: 'doc', ref: 'intent.md:1' }],
  confidence: 0.8,
  severity: 'INFO',
  dissent: null,
  resolution: null,
  alternatives: [],
  ...(modelArgs ? { model: modelBlocks[`lens:${s.lens}`] || null } : {})
}));

const synthesisRecords = modelArgs && merged ? [{
  id: `R-${String(records.length + 1).padStart(4, '0')}`,
  stage: 'spec',
  agent: 'spine:synthesis',
  provider: 'spine:synthesis',
  claim: `synthesis merged ${good.length} lens section(s)`,
  evidence: [{ kind: 'doc', ref: 'intent.md:1' }],
  confidence: 0.8,
  severity: 'INFO',
  dissent: null,
  resolution: null,
  alternatives: [],
  model: modelBlocks.synthesis
}] : [];
const allRecords = [
  ...records,
  ...synthesisRecords,
  ...didNotRunRecords('spec', (label) => (label === 'synthesis' ? 'spine:synthesis' : 'spine:lens'), records.length + synthesisRecords.length)
];

return { sections: good, merged: merged || null, dissent: merged ? merged.dissent : [], records: allRecords, failed_lenses: failedLenses };
