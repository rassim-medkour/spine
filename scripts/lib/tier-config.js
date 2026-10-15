'use strict';
const crypto = require('node:crypto');

const TIERS = Object.freeze(['leaf', 'branch', 'trunk']);
const TIER_RANK = Object.freeze({ leaf: 0, branch: 1, trunk: 2 });
const TRUNK_SIGNAL_CHOICES = Object.freeze(['critical_paths', 'entry_point', 'one_way_door', 'public_interface', 'security_path', 'shared_state']);

// fan_in_* measured by spike T-7 on spine and five local repos (Python, TypeScript, JavaScript, Go), 2026-10. tree_* set by spike T-11 (10k-file synthetic repo, Windows, 2026-10).
const TIER_DEFAULTS = Object.freeze({
  fan_in_trunk: 8,
  fan_in_branch: 2,
  churn_branch: 20,
  downstream_depth: 3,
  trunk_signals: Object.freeze(['critical_paths', 'entry_point', 'one_way_door']),
  untested_is_branch: true,
  flag_names: Object.freeze([]),
  reading_rates: Object.freeze({ read_yourself: 20, skim: 80, whole: 40 }),
  evidence_cap_bytes: 1048576,
  proof_timeout_seconds: 600,
  tree_budget_ms: 20000,
  tree_max_files: 20000,
  low_confidence: 0.6,
});

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const posNum = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

function strList(v, fallback, allowed) {
  if (!Array.isArray(v)) return fallback;
  const kept = v.filter((s) => typeof s === 'string' && s.length > 0 && (!allowed || allowed.includes(s)));
  return Object.freeze([...new Set(kept)].sort());
}

function maxTier(a, b) {
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

function thresholds(t) {
  const trunk = posInt(t.fan_in_trunk, TIER_DEFAULTS.fan_in_trunk);
  const branch = posInt(t.fan_in_branch, TIER_DEFAULTS.fan_in_branch);
  if (branch >= trunk) return { trunk: TIER_DEFAULTS.fan_in_trunk, branch: TIER_DEFAULTS.fan_in_branch };
  return { trunk, branch };
}

function tierConfig(config = {}) {
  const t = isObj(config.tiers) ? config.tiers : {};
  const rates = isObj(t.reading_rates) ? t.reading_rates : {};
  const fan = thresholds(t);
  const confidence = posNum(t.low_confidence, TIER_DEFAULTS.low_confidence);
  return Object.freeze({
    enabled: config.risk_tiers !== false,
    unproven_blocks: config.unproven_blocks === true,
    critical_paths: strList(config.critical_paths, Object.freeze([])),
    fan_in_trunk: fan.trunk,
    fan_in_branch: fan.branch,
    churn_branch: posInt(t.churn_branch, TIER_DEFAULTS.churn_branch),
    downstream_depth: posInt(t.downstream_depth, TIER_DEFAULTS.downstream_depth),
    trunk_signals: strList(t.trunk_signals, TIER_DEFAULTS.trunk_signals, TRUNK_SIGNAL_CHOICES),
    untested_is_branch: t.untested_is_branch !== false,
    flag_names: strList(t.flag_names, TIER_DEFAULTS.flag_names),
    reading_rates: Object.freeze({
      read_yourself: posNum(rates.read_yourself, TIER_DEFAULTS.reading_rates.read_yourself),
      skim: posNum(rates.skim, TIER_DEFAULTS.reading_rates.skim),
      whole: posNum(rates.whole, TIER_DEFAULTS.reading_rates.whole),
    }),
    evidence_cap_bytes: posInt(t.evidence_cap_bytes, TIER_DEFAULTS.evidence_cap_bytes),
    proof_timeout_seconds: posInt(t.proof_timeout_seconds, TIER_DEFAULTS.proof_timeout_seconds),
    tree_budget_ms: posInt(t.tree_budget_ms, TIER_DEFAULTS.tree_budget_ms),
    tree_max_files: posInt(t.tree_max_files, TIER_DEFAULTS.tree_max_files),
    low_confidence: confidence < 1 ? confidence : TIER_DEFAULTS.low_confidence,
  });
}

const HASHED_KEYS = Object.freeze(['critical_paths', 'fan_in_trunk', 'fan_in_branch', 'churn_branch', 'downstream_depth', 'trunk_signals', 'untested_is_branch', 'flag_names']);

function tierConfigHash(tc) {
  return crypto.createHash('sha256').update(JSON.stringify(HASHED_KEYS.map((k) => [k, tc[k]]))).digest('hex');
}

module.exports = { TIERS, TIER_RANK, TIER_DEFAULTS, TRUNK_SIGNAL_CHOICES, tierConfig, tierConfigHash, maxTier };
