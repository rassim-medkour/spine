'use strict';
const { hasStage } = require('./gate');

const MAX_HOOK_TEXT = 2000;
// C0 controls except tab and newline, DEL, C1 controls, bidi overrides and isolates.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const ARTIFACT_NAMES = new Set(['intent.md', 'spec.md', 'plan.md', 'tickets.json', 'review.json']);

function sanitizeHookText(text, max = MAX_HOOK_TEXT) {
  const clean = String(text == null ? '' : text).replace(UNSAFE_CHARS, '');
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

function safeStage(stage) {
  return hasStage(stage) ? stage : 'unknown';
}

function safeArtifact(name) {
  return ARTIFACT_NAMES.has(name) ? name : 'a stage artifact';
}

// Validation messages can quote artifact or subagent values after ", got ".
function stripQuotedValue(message) {
  return String(message).replace(/, got [\s\S]*$/, '');
}

function issueText(issue) {
  if (issue.kind === 'unknown-stage') return 'the run state names an unknown stage';
  if (issue.kind === 'missing') return `${safeArtifact(issue.artifact)} is missing`;
  if (issue.kind === 'invalid') return `${safeArtifact(issue.artifact)} has ${issue.problems.length} schema problem(s)`;
  if (issue.kind === 'no-boundary-pass') return 'no PASS record from spine:boundary-checker';
  return 'an unrecognized gate problem';
}

function buildStopFollowup(run, issues) {
  const items = issues.map(issueText).join('; ');
  return sanitizeHookText(`spine: run ${run.id} stage ${safeStage(run.state.stage)} is not gate-clean. Missing: ${items}. Finish the stage artifact and run the boundary checker.`);
}

function buildCapMessage(run, issues) {
  const items = issues.map(issueText).join('; ');
  return sanitizeHookText(`spine: Stop cap-reached for run ${run.id} stage ${safeStage(run.state.stage)}. The stage is not gate-clean: ${items}. Finish it, or use the escape hatch: set "strictness": "warn" in ~/.spine/config.json, or set the run's status to "paused".`);
}

function buildSubagentFollowup(verdict) {
  if (verdict.why === 'bad-json') {
    return sanitizeHookText('spine: the spine-record block is not valid JSON. Re-emit one fenced block tagged json spine-record that follows the record contract.');
  }
  const errors = verdict.errors.map(stripQuotedValue).join('; ');
  return sanitizeHookText(`spine: the spine-record block is invalid: ${errors}. Re-emit it following the record contract.`);
}

module.exports = {
  MAX_HOOK_TEXT, sanitizeHookText, safeStage, stripQuotedValue, issueText,
  buildStopFollowup, buildCapMessage, buildSubagentFollowup,
};
