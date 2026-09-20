'use strict';

const FORBIDDEN = [/Date\.now/, /Math\.random/, /new Date\(/, /\brequire\(/, /^import /m, /\bprocess\./];

function lintWorkflow(text) {
  const errors = [];
  if (!text.startsWith('export const meta = {')) return ['file must start with export const meta = {'];
  const match = /export const meta = (\{[\s\S]*?\n\});/.exec(text);
  if (!match) {
    errors.push('meta literal must end with a line containing only };');
  } else {
    try {
      const meta = new Function(`"use strict"; return ${match[1]}`)();
      if (!meta.name || !meta.description) errors.push('meta needs name and description');
    } catch (e) {
      errors.push(`meta must be a pure literal: ${e.message}`);
    }
  }
  for (const re of FORBIDDEN) {
    if (re.test(text)) errors.push(`forbidden in workflow script: ${re.source}`);
  }
  return errors;
}

module.exports = { lintWorkflow };
