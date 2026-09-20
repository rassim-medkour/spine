'use strict';
const fs = require('node:fs');
const { readStdinSync, readHookInput, emitContext, block, allow, appendHookLog } = require('./lib/hook-io');
const { loadConfig, findActiveRun } = require('./lib/state');
const { validateRecord } = require('./lib/validate');

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

function extractRecordBlock(text) {
  const re = /```json spine-record\s*\n([\s\S]*?)\n```/g;
  let match;
  let last = null;
  while ((match = re.exec(text))) last = match[1];
  return last;
}

function finish(reason, config, run) {
  if (config.strictness === 'warn') {
    appendHookLog(run, 'SubagentStop', 'warn');
    process.stdout.write(emitContext('SubagentStop', reason));
    allow();
  }
  appendHookLog(run, 'SubagentStop', 'block');
  block(reason);
}

function main() {
  const input = readHookInput(readStdinSync());
  if (input.stop_hook_active) allow();
  if (!input.agent_transcript_path) allow();
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const run = findActiveRun(cwd, config);
  if (!run) allow();
  const blockText = extractRecordBlock(lastAssistantText(input.agent_transcript_path));
  if (!blockText) {
    appendHookLog(run, 'SubagentStop', 'allow');
    allow();
  }
  let record;
  try {
    record = JSON.parse(blockText);
  } catch {
    finish('spine-record block is not valid JSON', config, run);
  }
  const errors = validateRecord(record);
  if (!errors.length) {
    appendHookLog(run, 'SubagentStop', 'allow');
    allow();
  }
  finish(`spine-record invalid: ${errors.join('; ')}`, config, run);
}

main();
