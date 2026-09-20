export const meta = {
  name: 'spine-spec',
  description: 'Spec drafting fan-out: each lens reads the intent through its own concern and proposes requirements, risks, and questions; a synthesis pass merges them and surfaces where lenses disagree.',
  phases: [
    { title: 'Lenses', detail: 'domain, architecture, data, security, ops, testability' },
    { title: 'Synthesis', detail: 'merge sections, list disagreements' }
  ]
};

// args: { intentText, lenses, providers, runId }
if (!args || typeof args.intentText !== 'string' || !args.intentText.trim()) throw new Error('spine-spec: args.intentText is required');
const lenses = Array.isArray(args.lenses) && args.lenses.length ? args.lenses : ['domain', 'architecture', 'data', 'security', 'ops', 'testability'];
const providers = Array.isArray(args.providers) ? args.providers : [];

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
  agent(lensPrompt(lens, i), { label: `lens:${lens}`, phase: 'Lenses', schema: SECTION })
    .catch((e) => {
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
log(`spine-spec: ${good.length}/${lenses.length} lenses returned`);

phase('Synthesis');
const merged = await agent(
  `Merge these lens sections into one spec draft. Keep every requirement, dedupe exact duplicates, and where two lenses disagree record it under dissent with both positions and the evidence that would settle it (a test, a spike, or a question). Do not invent requirements that no lens proposed.

SECTIONS:
${JSON.stringify(good, null, 2)}

INTENT:
${args.intentText}`,
  { label: 'synthesis', phase: 'Synthesis', schema: MERGE }
).catch((e) => {
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
  alternatives: []
}));

return { sections: good, merged: merged || null, dissent: merged ? merged.dissent : [], records, failed_lenses: failedLenses };
