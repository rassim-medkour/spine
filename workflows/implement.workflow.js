export const meta = {
  name: 'spine-implement',
  description: 'Per ticket: a fresh implementer follows TDD against the spec and plan, then a spec-compliance reviewer and a quality reviewer check the result in parallel.',
  phases: [
    { title: 'Implement', detail: 'one fresh implementer per ticket, test first' },
    { title: 'Review', detail: 'spec compliance and quality, different authors' }
  ]
};

// args: { tickets, specText, planText, runId, implementProviders, reviewProviders, providers, parallel }
if (!args || !Array.isArray(args.tickets) || !args.tickets.length) throw new Error('spine-implement: args.tickets is required');
if (typeof args.specText !== 'string' || !args.specText.trim()) throw new Error('spine-implement: args.specText is required');
if (typeof args.planText !== 'string' || !args.planText.trim()) throw new Error('spine-implement: args.planText is required');

const implementProviders = Array.isArray(args.implementProviders)
  ? args.implementProviders
  : (Array.isArray(args.providers) ? args.providers : []);
const reviewProviders = Array.isArray(args.reviewProviders) ? args.reviewProviders : [];

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

const RESULT = {
  type: 'object',
  properties: {
    implemented: { type: 'boolean' },
    summary: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    tests_run: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } }
  },
  required: ['implemented', 'summary', 'commits', 'tests_run', 'blockers']
};

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          evidence: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, ref: { type: 'string' } }, required: ['kind', 'ref'] } }
        },
        required: ['claim', 'severity', 'evidence']
      }
    }
  },
  required: ['pass', 'issues']
};

const implementProvider = implementProviders[0] || null;
const specReviewerProvider = reviewProviders[0] || null;
const qualityReviewerProvider = reviewProviders.find((p) => specReviewerProvider && p.author !== specReviewerProvider.author) || null;

function agentTypeFor(p) {
  return p && p.kind === 'agent' ? p.id : 'general-purpose';
}
const specReviewer = agentTypeFor(specReviewerProvider);
const qualityReviewer = agentTypeFor(qualityReviewerProvider);

function skillInstruction(p, howToUse) {
  return p && p.kind === 'skill' ? `Invoke the skill ${p.id} with the Skill tool${howToUse}. ` : '';
}

function implementPrompt(t) {
  return `${skillInstruction(implementProvider, ' and follow its method')}You are implementing ticket ${t.id}: ${t.title} (spec section ${t.spec_section}).
Work test-first: write the failing test named in the acceptance list, run it, implement the minimum, run again, refactor, commit with a conventional message that mentions ${t.id}.
Acceptance criteria: ${JSON.stringify(t.acceptance || [])}
Files expected to change: ${(t.files || []).join(', ')}
Do not touch files outside that list without saying why in blockers.
Return implemented=false with blockers if anything in the spec is ambiguous; do not guess.

SPEC:
${args.specText}

PLAN:
${args.planText}`;
}

function specReviewPrompt(t, r) {
  return `${skillInstruction(specReviewerProvider, '')}Spec compliance review for ticket ${t.id}. Compare the implementation described here against spec section ${t.spec_section} and the acceptance criteria. Report only deviations from the spec, each as a claim with path:line evidence. Pass only if every acceptance criterion is met by a named, passing test.
Implementer summary: ${r.summary}
Commits: ${r.commits.join(', ')}
Tests run: ${r.tests_run}
Acceptance: ${JSON.stringify(t.acceptance || [])}

SPEC:
${args.specText}`;
}

function qualityReviewPrompt(t, r) {
  return `${skillInstruction(qualityReviewerProvider, '')}Code quality review for ticket ${t.id}. Run git show on these commits: ${r.commits.join(', ')}. Report bugs, missing error handling, silent failures, and test gaps as claims with path:line evidence. Do not report style. Pass when no CRITICAL or HIGH issue exists.`;
}

function issuesToRecords(ticket, spec, quality) {
  const records = [];
  let n = 0;
  const sources = [['spec', spec, specReviewer, 'spine:spec-compliance'], ['quality', quality, qualityReviewer, 'spine:quality']];
  for (const [kind, verdict, agentName, providerName] of sources) {
    for (const issue of (verdict ? verdict.issues : [])) {
      n += 1;
      records.push({
        id: `R-${ticket.id}-${n}`,
        stage: 'implement',
        agent: agentName,
        provider: providerName,
        claim: issue.claim,
        evidence: issue.evidence,
        confidence: 0.8,
        severity: issue.severity,
        dissent: null,
        resolution: null,
        alternatives: [],
        ...(modelArgs ? { model: modelBlocks[`${kind}-review:${ticket.id}`] || null } : {})
      });
    }
  }
  return records;
}

function ticketDidNotRun(ticket, labels, agentFor) {
  return didNotRunRecords('implement', agentFor, 0)
    .filter((r) => labels.some((label) => r.claim === `agent did not run: ${label}`))
    .map((r) => ({ ...r, id: `R-${ticket.id}-dn-${r.claim.split(': ')[1].split(':')[0]}` }));
}

const failedTickets = [];

phase('Implement');
const results = await pipeline(
  args.tickets,
  (t) => routed('implementer', implementPrompt(t), {
    label: `implement:${t.id}`,
    phase: 'Implement',
    schema: RESULT,
    agentType: agentTypeFor(implementProvider),
    ...(args.parallel ? { isolation: 'worktree' } : {})
  })
    .catch((e) => {
      markNotRun(`implement:${t.id}`);
      failedTickets.push(t.id);
      log(`implement:${t.id} failed: ${e && e.message}`);
      return null;
    })
    .then((r) => ({ ticket: t, result: r })),
  ({ ticket, result }) => {
    if (!result || !result.implemented) {
      return {
        ticket_id: ticket.id,
        implemented: false,
        summary: result ? result.summary : 'implementer failed',
        commits: [],
        blockers: result ? result.blockers : ['no result'],
        spec_review: null,
        quality_review: null,
        records: ticketDidNotRun(ticket, [`implement:${ticket.id}`], () => 'spine:implementer')
      };
    }
    return parallel([
      () => routed('finder', specReviewPrompt(ticket, result), { label: `spec-review:${ticket.id}`, phase: 'Review', schema: VERDICT, agentType: specReviewer })
        .catch((e) => {
          markNotRun(`spec-review:${ticket.id}`);
          log(`spec-review:${ticket.id} failed: ${e && e.message}`);
          return null;
        }),
      () => routed('finder', qualityReviewPrompt(ticket, result), { label: `quality-review:${ticket.id}`, phase: 'Review', schema: VERDICT, agentType: qualityReviewer })
        .catch((e) => {
          markNotRun(`quality-review:${ticket.id}`);
          log(`quality-review:${ticket.id} failed: ${e && e.message}`);
          return null;
        })
    ]).then(([spec, quality]) => ({
      ticket_id: ticket.id,
      implemented: true,
      summary: result.summary,
      commits: result.commits,
      blockers: result.blockers,
      spec_review: spec,
      quality_review: quality,
      records: [
        ...issuesToRecords(ticket, spec, quality),
        ...ticketDidNotRun(ticket, [`spec-review:${ticket.id}`, `quality-review:${ticket.id}`], (label) => (label.startsWith('spec-review') ? 'spine:spec-compliance' : 'spine:quality'))
      ]
    }));
  }
);

const done = results.filter(Boolean);
log(`spine-implement: ${done.filter((r) => r.implemented).length}/${args.tickets.length} tickets implemented`);
return { results: done, failed_tickets: failedTickets };
