'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHookText } = require('../safe-text');

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Field names follow cursor.com/docs hooks (spike T-1, docs-derived).
function normalizeCursorInput(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const roots = Array.isArray(src.workspace_roots) ? src.workspace_roots.filter((r) => typeof r === 'string' && r) : [];
  const toolInput = src.tool_input && typeof src.tool_input === 'object' ? src.tool_input : {};
  return {
    conversationId: str(src.conversation_id),
    eventName: str(src.hook_event_name),
    workspaceRoots: roots,
    cwd: roots[0] || null,
    transcriptPath: str(src.transcript_path) || str(src.agent_transcript_path),
    filePath: str(src.file_path) || str(toolInput.file_path) || str(toolInput.path),
    finalText: str(src.summary) || str(src.result),
    status: str(src.status),
    loopCount: Number.isInteger(src.loop_count) ? src.loop_count : null,
  };
}

function stopOutput(followup) {
  return followup ? JSON.stringify({ followup_message: sanitizeHookText(followup) }) : '{}';
}

// Cap-reached visibility is stderr + hooks.log + a record (spike T-1: user_message is not
// documented for stop), so the stdout JSON carries nothing.
function capOutput() {
  return '{}';
}

function contextOutput(text) {
  return text ? JSON.stringify({ additional_context: sanitizeHookText(text) }) : '';
}

function safeConversationId(id) {
  const clean = id ? String(id).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64) : '';
  return clean || '-';
}

function appendCursorLog(run, eventName, decision, conversationId) {
  try {
    if (!run || !run.dir) return;
    const line = `${new Date().toISOString()} ${eventName} ${decision} host=cursor conversation=${safeConversationId(conversationId)}\n`;
    fs.appendFileSync(path.join(run.dir, 'hooks.log'), line);
  } catch {
    // logging must never change hook behavior
  }
}

// Never echo err.message: Node JSON and fs errors can quote file contents.
function errorDetail(err) {
  if (err && typeof err.code === 'string') return err.code;
  if (err && typeof err.name === 'string') return err.name;
  return 'Error';
}

function reportError(hook, err, run, conversationId, eventName) {
  process.stderr.write(`spine: ${hook} error: ${errorDetail(err)}\n`);
  appendCursorLog(run, eventName, 'error', conversationId);
}

function reportBadStdin(hook, kind) {
  process.stderr.write(`spine: ${hook} error: ${kind} stdin ignored\n`);
}

module.exports = {
  normalizeCursorInput, stopOutput, capOutput, contextOutput, safeConversationId,
  appendCursorLog, reportError, reportBadStdin,
};
