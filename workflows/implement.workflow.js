export const meta = {
  name: 'spine-implement',
  description: 'Per ticket: a fresh implementer follows TDD against the spec and plan, then a spec-compliance reviewer and a quality reviewer check the result in parallel.',
  phases: [
    { title: 'Implement', detail: 'one fresh implementer per ticket, test first' },
    { title: 'Review', detail: 'spec compliance and quality, different authors' }
  ]
};

// args: { tickets, specText, planText, runId, providers, parallel }
if (!args || !Array.isArray(args.tickets) || !args.tickets.length) throw new Error('spine-implement: args.tickets is required');
if (typeof args.specText !== 'string' || !args.specText.trim()) throw new Error('spine-implement: args.specText is required');
if (typeof args.planText !== 'string' || !args.planText.trim()) throw new Error('spine-implement: args.planText is required');

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

const reviewers = (args.providers || []).filter((p) => p.kind === 'agent');
const specReviewer = reviewers[0] ? reviewers[0].id : 'general-purpose';
const qualityProvider = reviewers.find((p) => reviewers[0] && p.author !== reviewers[0].author);
const qualityReviewer = qualityProvider ? qualityProvider.id : 'general-purpose';

function implementPrompt(t) {
  return `You are implementing ticket ${t.id}: ${t.title} (spec section ${t.spec_section}).
Work test-first: write the failing test named in the acceptance list, run it, implement the minimum, run again, refactor, commit with a conventional message that mentions ${t.id}.
Acceptance criteria: ${JSON.stringify(t.acceptance)}
Files expected to change: ${t.files.join(', ')}
Do not touch files outside that list without saying why in blockers.
Return implemented=false with blockers if anything in the spec is ambiguous; do not guess.

SPEC:
${args.specText}

PLAN:
${args.planText}`;
}

function specReviewPrompt(t, r) {
  return `Spec compliance review for ticket ${t.id}. Compare the implementation described here against spec section ${t.spec_section} and the acceptance criteria. Report only deviations from the spec, each as a claim with path:line evidence. Pass only if every acceptance criterion is met by a named, passing test.
Implementer summary: ${r.summary}
Commits: ${r.commits.join(', ')}
Tests run: ${r.tests_run}
Acceptance: ${JSON.stringify(t.acceptance)}

SPEC:
${args.specText}`;
}

function qualityReviewPrompt(t, r) {
  return `Code quality review for ticket ${t.id}. Run git show on these commits: ${r.commits.join(', ')}. Report bugs, missing error handling, silent failures, and test gaps as claims with path:line evidence. Do not report style. Pass when no CRITICAL or HIGH issue exists.`;
}

function issuesToRecords(ticket, spec, quality) {
  const records = [];
  let n = 0;
  const sources = [['spec', spec, specReviewer, 'spine:spec-compliance'], ['quality', quality, qualityReviewer, 'spine:quality']];
  for (const [, verdict, agentName, providerName] of sources) {
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
        alternatives: []
      });
    }
  }
  return records;
}

phase('Implement');
const results = await pipeline(
  args.tickets,
  (t) => agent(implementPrompt(t), {
    label: `implement:${t.id}`,
    phase: 'Implement',
    schema: RESULT,
    agentType: 'general-purpose',
    ...(args.parallel ? { isolation: 'worktree' } : {})
  }).then((r) => ({ ticket: t, result: r })),
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
        records: []
      };
    }
    return parallel([
      () => agent(specReviewPrompt(ticket, result), { label: `spec-review:${ticket.id}`, phase: 'Review', schema: VERDICT, agentType: specReviewer }),
      () => agent(qualityReviewPrompt(ticket, result), { label: `quality-review:${ticket.id}`, phase: 'Review', schema: VERDICT, agentType: qualityReviewer })
    ]).then(([spec, quality]) => ({
      ticket_id: ticket.id,
      implemented: true,
      summary: result.summary,
      commits: result.commits,
      blockers: result.blockers,
      spec_review: spec,
      quality_review: quality,
      records: issuesToRecords(ticket, spec, quality)
    }));
  }
);

const done = results.filter(Boolean);
log(`spine-implement: ${done.filter((r) => r.implemented).length}/${args.tickets.length} tickets implemented`);
return { results: done };
