export const meta = {
  name: 'spine-review',
  description: 'Cross-provider review: each selected provider finds, findings are merged by evidence, CRITICAL and HIGH are verified by a different author, then the devils advocate runs if the gate allows.',
  phases: [
    { title: 'Find', detail: 'one reviewer per provider, in parallel' },
    { title: 'Verify', detail: 'a different author tries to refute each CRITICAL/HIGH' },
    { title: 'Dissent', detail: 'devils advocate, only when the gate passes' }
  ]
};

// args: { diff, changedFiles, language, providers, devilsAdvocate, runId, stage }
if (!args || typeof args.diff !== 'string' || !args.diff.trim()) throw new Error('spine-review: args.diff is required');
if (!Array.isArray(args.providers) || !args.providers.length) throw new Error('spine-review: args.providers is required');
const changedFiles = Array.isArray(args.changedFiles) ? args.changedFiles : [];

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
  return `${how}\nYour strengths: ${p.strengths.join(', ')}.\n${CONTRACT}\nChanged files: ${changedFiles.join(', ')}\nLanguage: ${args.language || 'unknown'}\n\nDIFF:\n${args.diff}`;
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
  agent(finderPrompt(p), { label: `find:${p.id}`, phase: 'Find', schema: FINDINGS, agentType: agentTypeFor(p) })
    .catch((e) => {
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
const findings = [...merged.values()];
log(`spine-review: ${raw.filter(Boolean).flat().length} raw findings, ${findings.length} unique`);

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
  return agent(
    verifierPromptFor(verifier, f),
    { label: `verify:${i}`, phase: 'Verify', schema: VERDICT, agentType: verifierAgentTypeFor(verifier) }
  )
    .catch((e) => {
      log(`verify:${i} failed: ${e && e.message}`);
      return null;
    })
    .then((v) => ({ ...f, verified: v ? !v.refuted : false, verdict: v, verifier_note: verifierNote }));
});

const checked = verified.filter(Boolean);
const survivors = checked.filter((f) => f.verified);
const refuted = checked.filter((f) => !f.verified);
const kinds = new Set(findings.flatMap((f) => f.evidence.map((e) => e.kind)).filter((k) => k !== 'unverified'));
const gateOpen = Boolean(args.devilsAdvocate) && refuted.length === 0 && kinds.size >= 2;
log(`spine-review: ${survivors.length} verified, ${refuted.length} refuted, devils advocate ${gateOpen ? 'ON' : 'off'}`);

let dissent = [];
if (gateOpen) {
  phase('Dissent');
  const da = await agent(
    `Consensus findings (all verified by a second author): ${JSON.stringify(survivors.map((f) => ({ claim: f.claim, severity: f.severity, evidence: f.evidence })))}. Build the strongest case against them. ${CONTRACT}\n\nDIFF:\n${args.diff}`,
    { label: 'devils-advocate', phase: 'Dissent', schema: DA_FINDINGS, agentType: 'spine:devils-advocate' }
  ).catch((e) => {
    log(`devils-advocate failed: ${e && e.message}`);
    return null;
  });
  dissent = da ? da.findings.map((f) => ({ ...f, provider: 'spine:devils-advocate', author: 'spine' })) : [];
}

function toRecord(f, index, agentName) {
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
    verified: Boolean(f.verified),
    verifier_note: f.verifier_note || null
  };
}

const records = [
  ...checked.map((f, i) => toRecord(f, i, f.providers[0])),
  ...advisory.map((f, i) => toRecord(f, checked.length + i, f.providers[0])),
  ...dissent.map((f, i) => toRecord({ ...f, verified: false }, checked.length + advisory.length + i, 'spine:devils-advocate'))
];

return {
  records,
  findings: checked.concat(advisory),
  dissent,
  failed_providers: failedProviders,
  ...(failedProviders.length ? { verdict_note: `${failedProviders.length} of ${args.providers.length} providers failed` } : {})
};
