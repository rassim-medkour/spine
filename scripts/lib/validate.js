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
  };
  return map[base] || null;
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
  if (name === 'record') {
    try {
      return validateRecord(JSON.parse(text));
    } catch {
      return [`${relPath} is not valid JSON`];
    }
  }
  const schema = loadSchema(name);
  if (schema.kind === 'markdown') return validateMarkdown(text, schema);
  try {
    return validateJson(JSON.parse(text), schema);
  } catch {
    return [`${relPath} is not valid JSON`];
  }
}

module.exports = { loadSchema, validateJson, validateMarkdown, validateRecord, validateArtifactFile, schemaFor, parseFrontmatter };
