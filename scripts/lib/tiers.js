'use strict';
const path = require('node:path');
const { TEST_FILE } = require('./graph');

const SIGNAL_KEYS = Object.freeze(['fan_in', 'entry_point', 'shared_state', 'public_interface', 'one_way_door', 'security_path', 'churn', 'tested', 'gated']);
// Same pattern as SECURITY_RE in scripts/classify.js (pinned by tests/tree-signals.test.js).
const SECURITY_RE = /(auth(?!or)|login|password|token|secret|upload|payment|billing|crypto)/i;
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
const DEFAULT_FLAG_RE = /\b(isEnabled|featureFlag|FEATURE_[A-Z0-9_]+)\b/;
const FLAGS_PROPERTY_IN_CONDITION = /\b(?:if|elif|unless|when)\b.*\bflags\.[A-Za-z_]\w*/;
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
  // Spike T-9 dropped the node CLI guard and shebang rules: shebang marked 30% of one local repo, far over the 5% cap.
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

function publicInterface(file, parser, hunks, added = false, importers = []) {
  if (PUBLIC_PATH_RE.test(file)) return sig(true, 'public interface path');
  if (TEST_FILE.test(file)) return sig(false, 'test file');
  if (parser === 'go' && /(^|\/)internal\//.test(file)) return sig(false, 'go internal package');
  if (!hunks.length) return sig(false, 'no diff: path rule only');
  const re = EXPORT_CHANGE[parser];
  if (added && !importers.some((i) => path.posix.dirname(i) !== path.posix.dirname(file))) return sig(false, 'new file: no importer outside its directory');
  const changed = hunks.flatMap((h) => [...h.added, ...h.removed]).map((l) => l.text);
  return re && changed.some((t) => re.test(t)) ? sig(true, 'changes an exported declaration') : sig(false, 'no exported declaration changed');
}

function lineGated(text, names) {
  if (COMMENT_LINE.test(text)) return false;
  const code = stripTrailingComment(text);
  const bare = stripStrings(code);
  if (!CONDITIONAL.test(bare)) return false;
  if (DEFAULT_FLAG_RE.test(bare) || FLAGS_PROPERTY_IN_CONDITION.test(bare)) return true;
  const callOrProperty = /\w\s*\(|\.\w/.test(bare);
  return callOrProperty && names.some((n) => new RegExp(`(['"\`])${escapeRe(n)}\\1|\\b${escapeRe(n)}\\b`).test(code));
}

const isCodeLine = (l) => l.text.trim() !== '' && !COMMENT_LINE.test(l.text);

// The gate must lead the hunk's added code (precede or wrap the other added lines).
const hunkGated = (h, names) => {
  const lead = h.added.find(isCodeLine);
  return Boolean(lead) && lineGated(lead.text, names);
};

function detectGating(hunks, flagNames = [], status = 'modified') {
  if (status === 'added') return sig(false, 'new file: not gated by its own content');
  if (!hunks.length) return sig(false, 'not detected: no diff');
  const every = hunks.every((h) => hunkGated(h, flagNames));
  return every ? sig(true, 'flag conditional in every changed hunk') : sig(false, 'not detected');
}

function detectSignals({ path: file, parser, text, hunks = [], fanIn, tested, churn, declaredEntry = false, flagNames = [], status = 'modified', importers = [] }) {
  const docs = DOCS_RE.test(file);
  return {
    fan_in: { value: fanIn.value, resolved: fanIn.resolved, rule: fanIn.rule },
    entry_point: docs ? sig(false, 'docs file') : entryPoint(file, text, declaredEntry),
    shared_state: SHARED_STATE_RE.test(file) ? sig(true, 'shared state, config or schema path') : sig(false, 'no shared-state pattern'),
    public_interface: docs ? sig(false, 'docs file') : publicInterface(file, parser, hunks, status === 'added', importers),
    one_way_door: docs ? sig(false, 'docs file') : oneWayDoor(file, text, hunks),
    security_path: SECURITY_RE.test(file) ? sig(true, 'security path pattern') : sig(false, 'no security pattern'),
    churn: { value: churn.value, rule: churn.rule },
    tested: { value: tested.value, rule: tested.rule },
    gated: docs ? sig(false, 'docs file') : detectGating(hunks, flagNames, status),
  };
}

const { globToRegExp } = require('../classify');
const { maxTier } = require('./tier-config');

const KNOB_KEYS = Object.freeze(['is_trunk', 'wide_downstream', 'gated', 'severe_if_broken', 'instant_rollback']);
const FORCEABLE = Object.freeze([
  ['one_way_door', 'one-way door'],
  ['entry_point', 'entry point'],
  ['shared_state', 'shared state'],
  ['public_interface', 'public interface'],
  ['security_path', 'security path'],
]);

function tierFor(entry, tc) {
  const { path: file, signals } = entry;
  const cp = tc.critical_paths.find((g) => globToRegExp(g).test(file)) || null;
  if (!cp && DOCS_RE.test(file)) return { tier: 'leaf', reasons: ['docs only'] };
  const forced = new Set(tc.trunk_signals);
  let tier = 'leaf';
  const reasons = [];
  const raise = (t, why) => {
    tier = maxTier(tier, t);
    reasons.push(why);
  };
  if (cp) raise('trunk', `critical_paths override: ${cp}`);
  for (const [key, label] of FORCEABLE) {
    if (signals[key].value === true) raise(forced.has(key) ? 'trunk' : 'branch', `${label}: ${signals[key].rule}`);
  }
  const fi = signals.fan_in;
  if (!fi.resolved && !Number.isInteger(fi.value)) raise('branch', fi.rule);
  else if (fi.value >= tc.fan_in_trunk) raise('trunk', `fan-in ${fi.value} >= ${tc.fan_in_trunk}`);
  else if (fi.value >= tc.fan_in_branch) raise('branch', `fan-in ${fi.value} >= ${tc.fan_in_branch}`);
  else if (!fi.resolved) raise('branch', fi.rule);
  if (Number.isInteger(signals.churn.value) && signals.churn.value >= tc.churn_branch) raise('branch', `churn ${signals.churn.value} >= ${tc.churn_branch}`);
  const source = entry.parser !== 'none' && !TEST_FILE.test(file) && entry.status !== 'deleted';
  if (tc.untested_is_branch && source && signals.tested.value === false) raise('branch', 'untested: no test file imports it');
  const lowerable = tier === 'branch' && signals.gated.value === true && fi.resolved && !cp
    && signals.one_way_door.value !== true && signals.security_path.value !== true;
  if (lowerable) return { tier: 'leaf', reasons: [...reasons, 'gated: lowered branch to leaf'] };
  return { tier, reasons: reasons.length ? reasons : [`leaf: fan-in ${fi.value}, no trunk or branch signal`] };
}

const first3 = (files) => files.slice(0, 3).map((f) => f.path);
const cite = (signal, files) => [`signal:${signal}`, ...first3(files)];

function computeKnobs(files, tc) {
  const code = files.filter((f) => !DOCS_RE.test(f.path));
  const trunk = files.filter((f) => f.tier === 'trunk');
  const branch = files.filter((f) => f.tier === 'branch');
  const wide = code.filter((f) => Number.isInteger(f.downstream) && f.downstream >= tc.fan_in_trunk);
  const unknownDown = code.filter((f) => f.downstream === null);
  const ungated = code.filter((f) => f.signals.gated.value !== true);
  const allGated = code.length > 0 && ungated.length === 0;
  const doors = files.filter((f) => f.signals.one_way_door.value === true);
  const security = files.filter((f) => f.signals.security_path.value === true);
  const severe = [...new Set([...cite('security_path', security), ...first3(trunk), ...first3(doors)])];
  return {
    is_trunk: trunk.length ? { answer: 'yes', evidence: first3(trunk) } : { answer: 'no', evidence: cite('fan_in', files) },
    wide_downstream: wide.length ? { answer: 'yes', evidence: cite('fan_in', wide) }
      : unknownDown.length ? { answer: 'unknown', evidence: cite('fan_in', unknownDown) }
        : { answer: 'no', evidence: cite('fan_in', code) },
    gated: allGated ? { answer: 'yes', evidence: cite('gated', code) } : { answer: 'no', evidence: cite('gated', ungated) },
    severe_if_broken: trunk.length || security.length || doors.length ? { answer: 'yes', evidence: severe }
      : branch.length ? { answer: 'unknown', evidence: cite('fan_in', branch) }
        : { answer: 'no', evidence: cite('fan_in', files) },
    instant_rollback: doors.length ? { answer: 'no', evidence: cite('one_way_door', doors) }
      : allGated ? { answer: 'yes', evidence: cite('gated', code) }
        : { answer: 'unknown', evidence: ['signal:one_way_door', 'signal:gated'] },
  };
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const NO_CHURN = () => ({ value: null, rule: 'churn unknown: not computed' });

function classifyTree(files, graph, tc, churnFn = NO_CHURN, coverageFn = () => null) {
  const results = [...files].sort(byPath).map((f) => {
    const covered = coverageFn(f.path);
    const tested = covered === true || covered === false ? { value: covered, rule: 'coverage data' } : f.tested || graph.tested(f.path);
    const importers = f.importers || graph.importersOf(f.path);
    const signals = detectSignals({
      path: f.path, parser: f.parser, text: f.text, hunks: f.hunks || [],
      fanIn: f.fanIn || graph.fanIn(f.path), tested, churn: churnFn(f.path),
      declaredEntry: Boolean(f.declaredEntry), flagNames: tc.flag_names, status: f.status, importers,
    });
    const { tier, reasons } = tierFor({ path: f.path, status: f.status, parser: f.parser, signals }, tc);
    const downstream = f.downstream !== undefined ? f.downstream : graph.downstream(f.path, tc.downstream_depth);
    return { path: f.path, status: f.status, tier, reasons, parser: f.parser, signals, importers_top: importers.slice(0, 3), downstream };
  });
  return { tier: results.reduce((t, f) => maxTier(t, f.tier), 'leaf'), knobs: computeKnobs(results, tc), files: results };
}

module.exports = { SIGNAL_KEYS, KNOB_KEYS, SECURITY_RE, DOCS_RE, MIGRATION_RE, detectGating, detectSignals, classifyTree, computeKnobs };
