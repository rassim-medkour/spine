'use strict';
const { TEST_FILE } = require('./graph');

const SIGNAL_KEYS = Object.freeze(['fan_in', 'entry_point', 'shared_state', 'public_interface', 'one_way_door', 'security_path', 'churn', 'tested', 'gated']);
// Same pattern as SECURITY_RE in scripts/classify.js (pinned by tests/tree-signals.test.js).
const SECURITY_RE = /(auth|login|password|token|secret|upload|payment|billing|crypto)/i;
const DOCS_RE = /(^|\/)docs\/|\.(md|markdown|rst|txt)$/i;
const ENTRY_ANYWHERE_RE = /(^|\/)(main|server|cli|manage|wsgi|asgi|__main__)\.(py|[cm]?[jt]sx?|go)$/;
const ENTRY_SHALLOW_RE = /^([^/]+\/)?(index|app)\.(py|[cm]?[jt]sx?)$/;
const SHARED_STATE_RE = /(^|\/)(config|configs|settings|constants|store|stores|state|context|schema|schemas|reducers?)(\/|\.[a-z]+$)|\.schema\.json$|(^|\/)\.env\.example$/i;
const PUBLIC_PATH_RE = /(^|\/)(api|public|sdk|routes|proto)\/|\.(proto|graphql|gql)$|(^|\/)openapi\.(ya?ml|json)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate)\/|\.sql$/i;
const CONTRACT_RE = /(^|\/)schema\.prisma$|\.(proto|graphql|gql)$|(^|\/)openapi\.(ya?ml|json)$/i;
const EMPTY_DOWN_RE = /def\s+downgrade\s*\([^)]*\)\s*(->\s*None\s*)?:\s*\n\s+pass\b/;
const EXEC_CALL = /\b(execute|exec|query|raw|run|sql)\s*\(|\bsql`/i;
const DATA_DELETE = Object.freeze([
  ['DROP TABLE/COLUMN', /\bDROP\s+(TABLE|COLUMN)\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['ALTER TABLE ... DROP', /\bALTER\s+TABLE\s+\S+\s+DROP\b/i],
  ['DELETE without WHERE', /\bDELETE\s+FROM\s+[\w."`]+\s*(;|$|["'`)])/i],
]);
const EXPORT_CHANGE = Object.freeze({
  typescript: /^\s*export\s/,
  javascript: /^\s*(export\s|module\.exports\b|exports\.\w+\s*=)/,
  python: /^(async\s+def|def|class)\s+[A-Za-z]\w*/,
  go: /^(func|type|var|const)\s+(\([^)]*\)\s*)?[A-Z]/,
});
const DEFAULT_FLAG_RE = /\b(isEnabled|featureFlag|flags\.[A-Za-z_]\w*|FEATURE_[A-Z0-9_]+)\b/;
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|--)/;
const CONDITIONAL = /\b(if|elif|unless|when|switch|case)\b|&&|\|\||\?(?!\.)[^:]*:/;

const sig = (value, rule) => ({ value, rule });
const addedTexts = (hunks) => hunks.flatMap((h) => h.added.map((l) => l.text));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripStrings = (t) => t.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
const stripTrailingComment = (t) => t.replace(/\s(\/\/|#).*$/, '');

function entryPoint(file, text, declared) {
  if (TEST_FILE.test(file)) return sig(false, 'test file');
  if (declared) return sig(true, 'declared entry (package.json main/bin/exports)');
  if (ENTRY_ANYWHERE_RE.test(file)) return sig(true, 'entry file name');
  if (ENTRY_SHALLOW_RE.test(file)) return sig(true, 'top-level index or app file');
  if (typeof text !== 'string') return sig(false, 'no entry pattern');
  if (file.endsWith('.go') && /^package\s+main\b/m.test(text)) return sig(true, 'go package main');
  if (file.endsWith('.py') && /__name__\s*==\s*['"]__main__['"]/.test(text)) return sig(true, '__main__ guard');
  if (/\brequire\.main\s*===\s*module\b/.test(text)) return sig(true, 'node CLI guard');
  if (text.startsWith('#!')) return sig(true, 'shebang');
  return sig(false, 'no entry pattern');
}

function oneWayDoor(file, text, hunks) {
  if (MIGRATION_RE.test(file)) {
    if (typeof text === 'string' && EMPTY_DOWN_RE.test(text)) return sig(true, 'migration with empty down step');
    return sig(true, 'migration path');
  }
  if (CONTRACT_RE.test(file)) return sig(true, 'external contract file');
  if (TEST_FILE.test(file)) return sig(false, 'test file');
  const executed = addedTexts(hunks).filter((t) => EXEC_CALL.test(t));
  const hit = DATA_DELETE.find(([, re]) => executed.some((t) => re.test(t)));
  return hit ? sig(true, `data deletion: ${hit[0]}`) : sig(false, 'no one-way-door pattern');
}

function publicInterface(file, parser, hunks) {
  if (PUBLIC_PATH_RE.test(file)) return sig(true, 'public interface path');
  if (TEST_FILE.test(file)) return sig(false, 'test file');
  if (parser === 'go' && /(^|\/)internal\//.test(file)) return sig(false, 'go internal package');
  if (!hunks.length) return sig(false, 'no diff: path rule only');
  const re = EXPORT_CHANGE[parser];
  const changed = hunks.flatMap((h) => [...h.added, ...h.removed]).map((l) => l.text);
  return re && changed.some((t) => re.test(t)) ? sig(true, 'changes an exported declaration') : sig(false, 'no exported declaration changed');
}

function lineGated(text, names) {
  if (COMMENT_LINE.test(text)) return false;
  const code = stripTrailingComment(text);
  const bare = stripStrings(code);
  if (!CONDITIONAL.test(bare)) return false;
  if (DEFAULT_FLAG_RE.test(bare)) return true;
  const callOrProperty = /\w\s*\(|\.\w/.test(bare);
  return callOrProperty && names.some((n) => new RegExp(`(['"\`])${escapeRe(n)}\\1|\\b${escapeRe(n)}\\b`).test(code));
}

function detectGating(hunks, flagNames = []) {
  if (!hunks.length) return sig(false, 'not detected: no diff');
  const every = hunks.every((h) => h.added.some((l) => lineGated(l.text, flagNames)));
  return every ? sig(true, 'flag conditional in every changed hunk') : sig(false, 'not detected');
}

function detectSignals({ path: file, parser, text, hunks = [], fanIn, tested, churn, declaredEntry = false, flagNames = [] }) {
  const docs = DOCS_RE.test(file);
  return {
    fan_in: { value: fanIn.value, resolved: fanIn.resolved, rule: fanIn.rule },
    entry_point: docs ? sig(false, 'docs file') : entryPoint(file, text, declaredEntry),
    shared_state: SHARED_STATE_RE.test(file) ? sig(true, 'shared state, config or schema path') : sig(false, 'no shared-state pattern'),
    public_interface: docs ? sig(false, 'docs file') : publicInterface(file, parser, hunks),
    one_way_door: docs ? sig(false, 'docs file') : oneWayDoor(file, text, hunks),
    security_path: SECURITY_RE.test(file) ? sig(true, 'security path pattern') : sig(false, 'no security pattern'),
    churn: { value: churn.value, rule: churn.rule },
    tested: { value: tested.value, rule: tested.rule },
    gated: docs ? sig(false, 'docs file') : detectGating(hunks, flagNames),
  };
}

module.exports = { SIGNAL_KEYS, SECURITY_RE, DOCS_RE, MIGRATION_RE, detectGating, detectSignals };
