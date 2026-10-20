'use strict';
const fs = require('node:fs');
const { writeRecords } = require('./lib/record-writer');
const { extractRecordBlocks } = require('./lib/gate');
const { readStdinCapped } = require('./lib/stdin');

const FLAG_RULES = {
  '--provider': /^[a-z0-9-]+:[a-z0-9-]+$/i,
  '--author': /^[a-z0-9-]{1,40}$/i,
  '--verifies': /^R-\d{4,}$/,
  '--verified': /^(true|false)$/,
  '--verifier-note': /^[^\n]{1,200}$/,
  '--host': /^(cursor|claude-code)$/,
  '--model-role': /^(implementer|finder|verifier|devils_advocate|spec_lens|synthesis|boundary_checker)$/,
  '--model-source': /^(requested|inherit|session-fallback|unsupported-dispatch|floor-raised|fallback-error)$/,
  '--from-text': /./,
  '--file': /./,
};

function parseArgs(argv) {
  const [runDir, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const rule = FLAG_RULES[rest[i]];
    if (!rule || rest[i + 1] === undefined || !rule.test(rest[i + 1])) throw new Error(`bad flag ${rest[i]}`);
    flags[rest[i]] = rest[i + 1];
  }
  return { runDir, flags };
}

function sourceRecords(flags) {
  if (flags['--from-text']) return extractRecordBlocks(fs.readFileSync(flags['--from-text'], 'utf8')).map((b) => JSON.parse(b));
  const text = flags['--file'] ? fs.readFileSync(flags['--file'], 'utf8') : readStdinCapped().text;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

try {
  const { runDir, flags } = parseArgs(process.argv.slice(2));
  const ids = writeRecords(runDir, sourceRecords(flags), flags);
  if (!ids.length) throw new Error('no spine-record block found');
  process.stdout.write(JSON.stringify({ ids }) + '\n');
} catch (err) {
  process.stderr.write(`spine: write-record: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
