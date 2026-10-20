'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas');

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.json`), 'utf8'));
}

function checkEnums(obj, enums, prefix, errors) {
  for (const [key, allowed] of Object.entries(enums || {})) {
    if (key in obj && !allowed.includes(obj[key])) {
      errors.push(`${prefix}${key} must be one of ${allowed.join(', ')}, got ${obj[key]}`);
    }
  }
}

function checkRequired(obj, required, prefix, errors) {
  for (const key of required || []) {
    if (!(key in obj)) errors.push(`${prefix}missing required key ${key}`);
  }
}

function validateJson(obj, schema) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['artifact must be a JSON object'];
  checkRequired(obj, schema.required, '', errors);
  checkEnums(obj, schema.enums, '', errors);
  for (const [key, itemSchema] of Object.entries(schema.arrays || {})) {
    if (!(key in obj)) continue;
    if (!Array.isArray(obj[key])) {
      errors.push(`${key} must be an array`);
      continue;
    }
    obj[key].forEach((item, i) => {
      const prefix = `${key}[${i}].`;
      if (!item || typeof item !== 'object') {
        errors.push(`${key}[${i}] must be an object`);
        return;
      }
      checkRequired(item, itemSchema.required, prefix, errors);
      checkEnums(item, itemSchema.enums, prefix, errors);
    });
  }
  return errors;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return data;
}

function validateMarkdown(text, schema) {
  const errors = [];
  const fm = parseFrontmatter(text);
  if (!fm) errors.push('missing frontmatter block');
  for (const key of schema.frontmatter || []) {
    if (!fm || !(key in fm) || fm[key] === '') errors.push(`missing frontmatter key ${key}`);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const heading of schema.headings || []) {
    if (!lines.includes(heading)) errors.push(`missing heading "${heading}"`);
  }
  return errors;
}

const STRONG = new Set(['CRITICAL', 'HIGH']);

function validateRecord(obj) {
  const errors = validateJson(obj, loadSchema('record'));
  if (errors.length) return errors;
  if (!obj.evidence.length) {
    errors.push('evidence must have at least one entry');
    return errors;
  }
  const hasRealEvidence = obj.evidence.some((e) => e.kind !== 'unverified');
  if (STRONG.has(obj.severity) && !hasRealEvidence) {
    errors.push(`severity ${obj.severity} requires at least one evidence item that is not unverified`);
  }
  return errors;
}

const TREE_SCHEMA_VERSION = 1;
const TIER_ORDER = ['leaf', 'branch', 'trunk'];
const stripValue = (e) => e.replace(/, got [\s\S]*$/, '');

function isRepoRelative(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.split('/').includes('..');
}

function checkTreeFile(f, i, schema, errors) {
  const at = `files[${i}]`;
  if (!isRepoRelative(f.path)) errors.push(`${at}.path must be repo-relative with forward slashes`);
  if (!Array.isArray(f.reasons) || !f.reasons.length || !f.reasons.every((r) => typeof r === 'string' && r)) {
    errors.push(`${at}.reasons must be a non-empty array of strings`);
  }
  const signals = f.signals && typeof f.signals === 'object' ? f.signals : null;
  for (const key of schema.signals) {
    const s = signals && signals[key];
    if (!s || typeof s !== 'object' || !('value' in s) || typeof s.rule !== 'string' || !s.rule) errors.push(`${at}.signals missing ${key}`);
  }
  if (signals && signals.fan_in && typeof signals.fan_in === 'object' && typeof signals.fan_in.resolved !== 'boolean') {
    errors.push(`${at}.signals.fan_in.resolved must be a boolean`);
  }
}

function checkKnobs(knobs, schema, errors) {
  for (const key of schema.knobs) {
    const k = knobs && knobs[key];
    if (!k || typeof k !== 'object') {
      errors.push(`knobs missing ${key}`);
      continue;
    }
    if (!schema.knob_answers.includes(k.answer)) errors.push(`knobs.${key}.answer must be yes, no or unknown`);
    if (!Array.isArray(k.evidence) || !k.evidence.length) errors.push(`knobs.${key}.evidence must be a non-empty array`);
  }
}

function validateTree(obj) {
  const schema = loadSchema('tree');
  const base = validateJson(obj, schema).map(stripValue);
  if (base.length) return base;
  const errors = [];
  if (obj.schema_version !== TREE_SCHEMA_VERSION) errors.push(`schema_version must be ${TREE_SCHEMA_VERSION}`);
  const inputs = obj.inputs && typeof obj.inputs === 'object' ? obj.inputs : {};
  for (const key of schema.inputs) if (typeof inputs[key] !== 'string') errors.push(`inputs missing ${key}`);
  checkKnobs(obj.knobs, schema, errors);
  obj.files.forEach((f, i) => checkTreeFile(f, i, schema, errors));
  const paths = obj.files.map((f) => f.path);
  if (paths.some((p, i) => i > 0 && !(paths[i - 1] < p))) errors.push('files must be sorted by path without duplicates');
  const top = obj.files.reduce((t, f) => (TIER_ORDER.indexOf(f.tier) > TIER_ORDER.indexOf(t) ? f.tier : t), 'leaf');
  if (obj.tier !== top) errors.push('tier must equal the highest file tier');
  return errors;
}

function schemaFor(relPath) {
  const base = path.basename(relPath);
  const parent = path.basename(path.dirname(relPath));
  if (parent === 'records' && /^R-\d+\.json$/.test(base)) return 'record';
  const map = {
    'intent.md': 'intent',
    'spec.md': 'spec',
    'plan.md': 'plan',
    'tickets.json': 'tickets',
    'review.json': 'review',
    'class.json': 'class',
    'tree.json': 'tree',
  };
  return map[base] || null;
}

function validateReview(obj) {
  const errors = validateJson(obj, loadSchema('review'));
  if (errors.length) return errors;
  const missing = obj.missing_proof;
  if (obj.verdict === 'UNPROVEN' && (!Array.isArray(missing) || !missing.length)) errors.push('missing_proof must be a non-empty array when verdict is UNPROVEN');
  (Array.isArray(missing) ? missing : []).forEach((m, i) => {
    if (!Array.isArray(m.kinds) || !m.kinds.length) errors.push(`missing_proof[${i}].kinds must be a non-empty array`);
    if (!Array.isArray(m.files)) errors.push(`missing_proof[${i}].files must be an array`);
  });
  return errors;
}

function validateArtifactFile(absPath, relPath = absPath) {
  const name = schemaFor(relPath);
  if (!name) return [];
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [`cannot read ${relPath}`];
  }
  if (name === 'record' || name === 'tree' || name === 'review') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [`${relPath} is not valid JSON`];
    }
    if (name === 'record') return validateRecord(parsed);
    return name === 'tree' ? validateTree(parsed) : validateReview(parsed);
  }
  const schema = loadSchema(name);
  if (schema.kind === 'markdown') return validateMarkdown(text, schema);
  try {
    return validateJson(JSON.parse(text), schema);
  } catch {
    return [`${relPath} is not valid JSON`];
  }
}

module.exports = { loadSchema, validateJson, validateMarkdown, validateRecord, validateTree, validateReview, validateArtifactFile, schemaFor, parseFrontmatter };
