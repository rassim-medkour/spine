'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateRecord } = require('./lib/validate');
const { nextRecordId } = require('./lib/records');
const { RUN_ID_RE } = require('./lib/state');
const { extractRecordBlocks } = require('./lib/gate');
const { readStdinCapped } = require('./lib/stdin');

const FLAG_RULES = {
  '--provider': /^[a-z0-9-]+:[a-z0-9-]+$/i,
  '--author': /^[a-z0-9-]{1,40}$/i,
  '--verifies': /^R-\d{4,}$/,
  '--verified': /^(true|false)$/,
  '--verifier-note': /^[^\n]{1,200}$/,
  '--host': /^(cursor|claude-code)$/,
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

function stamp(record, flags) {
  const out = { ...record };
  if (flags['--provider']) out.provider = flags['--provider'];
  if (flags['--author']) out.author = flags['--author'];
  if (flags['--verifies']) out.verifies = flags['--verifies'];
  if (flags['--verified']) out.verified = flags['--verified'] === 'true';
  if (flags['--verifier-note']) out.verifier_note = flags['--verifier-note'];
  if (flags['--host']) out.host = flags['--host'];
  return out;
}

function sourceRecords(flags) {
  if (flags['--from-text']) return extractRecordBlocks(fs.readFileSync(flags['--from-text'], 'utf8')).map((b) => JSON.parse(b));
  const text = flags['--file'] ? fs.readFileSync(flags['--file'], 'utf8') : readStdinCapped().text;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function writeRecords(runDir, records, flags) {
  if (!runDir || !RUN_ID_RE.test(path.basename(runDir)) || !fs.existsSync(path.join(runDir, 'state.json'))) {
    throw new Error('first argument must be an existing <artifacts_dir>/<run-id> directory with state.json');
  }
  const stamped = records.map((r) => stamp(r, flags));
  const problems = stamped.flatMap((r, i) => validateRecord({ ...r, id: 'R-0000' }).map((e) => `record ${i + 1}: ${e}`));
  if (problems.length) throw new Error(problems.join('; '));
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  return stamped.map((r) => {
    const id = nextRecordId(runDir);
    fs.writeFileSync(path.join(runDir, 'records', `${id}.json`), JSON.stringify({ ...r, id }, null, 2) + '\n', { flag: 'wx' });
    return id;
  });
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
