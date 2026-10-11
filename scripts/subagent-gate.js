'use strict';
const fs = require('node:fs');
const { readStdinSync, readHookInput, emitContext, block, allow, appendHookLog } = require('./lib/hook-io');
const { loadConfig, findActiveRun } = require('./lib/state');
const { evaluateSubagentText, subagentReason } = require('./lib/gate');

function lastAssistantText(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message && entry.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  return '';
}

function main() {
  const input = readHookInput(readStdinSync());
  if (input.stop_hook_active) allow();
  if (!input.agent_transcript_path) allow();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  if (!run) allow();
  const verdict = evaluateSubagentText(lastAssistantText(input.agent_transcript_path), config);
  if (verdict.decision === 'allow') {
    appendHookLog(run, 'SubagentStop', 'allow');
    allow();
  }
  const reason = subagentReason(verdict);
  if (verdict.decision === 'warn') {
    appendHookLog(run, 'SubagentStop', 'warn');
    process.stdout.write(emitContext('SubagentStop', reason));
    allow();
  }
  appendHookLog(run, 'SubagentStop', 'block');
  block(reason);
}

try {
  main();
} catch (e) {
  // Fail open: a bug in spine must never trap the user in a turn.
  process.stderr.write(`spine: subagent gate error: ${e && e.message}\n`);
  allow();
}
