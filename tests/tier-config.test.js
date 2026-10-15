'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tierConfig, tierConfigHash, TIER_DEFAULTS, maxTier } = require('../scripts/lib/tier-config');

test('defaults: feature on, UNPROVEN in shadow mode, documented rates', () => {
  const tc = tierConfig({});
  assert.equal(tc.enabled, true);
  assert.equal(tc.unproven_blocks, false);
  assert.deepEqual(tc.reading_rates, { read_yourself: 20, skim: 80, whole: 40 });
  assert.ok(Number.isInteger(tc.fan_in_trunk) && Number.isInteger(tc.fan_in_branch));
  assert.ok(tc.fan_in_branch < tc.fan_in_trunk);
  assert.deepEqual(tc.trunk_signals, ['critical_paths', 'entry_point', 'one_way_door']);
  assert.equal(tc.evidence_cap_bytes, 1048576);
  assert.equal(tc.proof_timeout_seconds, 600);
  assert.equal(tc.low_confidence, 0.6);
});

test('"risk_tiers": false is the kill switch', () => {
  assert.equal(tierConfig({ risk_tiers: false }).enabled, false);
  assert.equal(tierConfig({ risk_tiers: 'no' }).enabled, true);
});

test('"unproven_blocks": true turns blocking on, anything else stays shadow', () => {
  assert.equal(tierConfig({ unproven_blocks: true }).unproven_blocks, true);
  assert.equal(tierConfig({ unproven_blocks: 'true' }).unproven_blocks, false);
});

test('invalid values fall back to defaults', () => {
  const tc = tierConfig({ tiers: { fan_in_trunk: -1, fan_in_branch: 'x', reading_rates: { skim: 0 }, trunk_signals: ['nonsense', 'security_path'], low_confidence: 7, flag_names: ['new_checkout', 3, ''] } });
  assert.equal(tc.fan_in_trunk, TIER_DEFAULTS.fan_in_trunk);
  assert.equal(tc.fan_in_branch, TIER_DEFAULTS.fan_in_branch);
  assert.equal(tc.reading_rates.skim, 80);
  assert.deepEqual(tc.trunk_signals, ['security_path']);
  assert.equal(tc.low_confidence, 0.6);
  assert.deepEqual(tc.flag_names, ['new_checkout']);
});

test('a branch threshold at or above the trunk threshold resets both', () => {
  const tc = tierConfig({ tiers: { fan_in_trunk: 4, fan_in_branch: 4 } });
  assert.equal(tc.fan_in_trunk, TIER_DEFAULTS.fan_in_trunk);
  assert.equal(tc.fan_in_branch, TIER_DEFAULTS.fan_in_branch);
});

test('the config hash covers tiering keys only', () => {
  const a = tierConfigHash(tierConfig({}));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, tierConfigHash(tierConfig({ tiers: { reading_rates: { skim: 10 } } })));
  assert.notEqual(a, tierConfigHash(tierConfig({ tiers: { fan_in_trunk: 99 } })));
  assert.notEqual(a, tierConfigHash(tierConfig({ critical_paths: ['src/**'] })));
  assert.notEqual(a, tierConfigHash(tierConfig({ tiers: { flag_names: ['x'] } })));
});

test('maxTier orders leaf < branch < trunk', () => {
  assert.equal(maxTier('leaf', 'branch'), 'branch');
  assert.equal(maxTier('trunk', 'branch'), 'trunk');
  assert.equal(maxTier('leaf', 'leaf'), 'leaf');
});
