'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateArtifactFile, validateRecord } = require('./validate');
const { latestBoundaryPass } = require('./records');

const STAGE_ARTIFACTS = Object.freeze({
  intent: ['intent.md'],
  spec: ['spec.md'],
  plan: ['plan.md', 'tickets.json'],
  implement: ['tickets.json'],
  review: ['review.json'],
  done: [],
});
const HUMAN_WAIT = Object.freeze(['G1', 'G2', 'G3', 'human']);
const RECORD_FENCE = /```json spine-record\s*\n([\s\S]*?)\n```/g;

function hasStage(stage) {
  return Object.prototype.hasOwnProperty.call(STAGE_ARTIFACTS, stage);
}

function collectIssues(run) {
  const stage = run.state.stage;
  if (!hasStage(stage)) return [{ kind: 'unknown-stage' }];
  const issues = [];
  for (const rel of STAGE_ARTIFACTS[stage]) {
    const abs = path.join(run.dir, rel);
    if (!fs.existsSync(abs)) {
      issues.push({ kind: 'missing', artifact: rel });
      continue;
    }
    const problems = validateArtifactFile(abs, rel);
    if (problems.length) issues.push({ kind: 'invalid', artifact: rel, problems });
  }
  if (!latestBoundaryPass(run.dir, stage)) issues.push({ kind: 'no-boundary-pass' });
  return issues;
}

// Exact strings the Claude Stop hook has always printed (pinned by claude-golden).
function formatIssues(issues, stage) {
  const errors = [];
  for (const issue of issues) {
    if (issue.kind === 'unknown-stage') errors.push(`unknown stage ${stage}`);
    else if (issue.kind === 'missing') errors.push(`${issue.artifact} is missing for stage ${stage}`);
    else if (issue.kind === 'invalid') for (const e of issue.problems) errors.push(`${issue.artifact}: ${e}`);
    else if (issue.kind === 'no-boundary-pass') errors.push(`no PASS record from spine:boundary-checker for stage ${stage}`);
  }
  return errors;
}

function collectErrors(run) {
  return formatIssues(collectIssues(run), run.state.stage);
}

function allowVerdict(why) {
  return { decision: 'allow', why, issues: [], errors: [] };
}

function evaluateStop(run, config) {
  if (!run) return allowVerdict('no-run');
  if (run.state.status !== 'active') return allowVerdict('not-active');
  if (HUMAN_WAIT.includes(run.state.awaiting)) return allowVerdict('awaiting');
  if (run.state.stage === 'done') return allowVerdict('done');
  const issues = collectIssues(run);
  const errors = formatIssues(issues, run.state.stage);
  if (!errors.length) return { decision: 'allow', why: 'clean', issues, errors };
  return { decision: config.strictness === 'warn' ? 'warn' : 'block', why: 'unclean', issues, errors };
}

function stopReason(run, errors) {
  return `run ${run.id} stage ${run.state.stage} is not gate-clean: ${errors.join('; ')}. Finish the stage artifact and run the boundary checker.`;
}

function extractRecordBlocks(text) {
  return [...String(text || '').matchAll(RECORD_FENCE)].map((m) => m[1]);
}

function extractRecordBlock(text) {
  const blocks = extractRecordBlocks(text);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

function evaluateSubagentText(text, config) {
  const blockText = extractRecordBlock(text);
  if (!blockText) return { decision: 'allow', why: 'no-record', errors: [] };
  const failing = config.strictness === 'warn' ? 'warn' : 'block';
  let record;
  try {
    record = JSON.parse(blockText);
  } catch {
    return { decision: failing, why: 'bad-json', errors: [] };
  }
  const errors = validateRecord(record);
  if (!errors.length) return { decision: 'allow', why: 'valid', errors: [] };
  return { decision: failing, why: 'invalid', errors };
}

function subagentReason(verdict) {
  if (verdict.why === 'bad-json') return 'spine-record block is not valid JSON';
  return `spine-record invalid: ${verdict.errors.join('; ')}`;
}

module.exports = {
  STAGE_ARTIFACTS, HUMAN_WAIT, hasStage, collectIssues, formatIssues, collectErrors,
  evaluateStop, stopReason, extractRecordBlocks, extractRecordBlock, evaluateSubagentText, subagentReason,
};
