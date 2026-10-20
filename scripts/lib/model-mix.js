'use strict';
// Model mix over records: how many dispatched agents were requested on which class and model.
// Counts what was requested, never what ran. Ids are printed only when they pass MODEL_ID_RE.
const { MODEL_ID_RE } = require('./model-policy');

const REQUESTED_SOURCES = ['requested', 'floor-raised'];
const BLOCK_KEYS = ['model', 'verifier_model'];
const DID_NOT_RUN = /^agent did not run:/;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function emptyMix() {
  return { agents: 0, by_class: { cheap: 0, mid: 0, top: 0, pinned: 0 }, by_model: {}, session: 0, fallback_error: 0, unsupported: 0, did_not_run: 0, invalid_ids: 0 };
}

function countBlock(mix, block) {
  const next = { ...mix, by_class: { ...mix.by_class }, by_model: { ...mix.by_model }, agents: mix.agents + 1 };
  if (REQUESTED_SOURCES.includes(block.source)) {
    if (block.class in next.by_class) next.by_class[block.class] += 1;
    if (typeof block.requested === 'string' && MODEL_ID_RE.test(block.requested)) next.by_model[block.requested] = (next.by_model[block.requested] || 0) + 1;
    else next.invalid_ids += 1;
  }
  if (block.source === 'inherit' || block.source === 'session-fallback') next.session += 1;
  if (block.source === 'fallback-error') next.fallback_error += 1;
  if (block.source === 'unsupported-dispatch') next.unsupported += 1;
  return next;
}

function computeMix(records) {
  let mix = emptyMix();
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObj(r)) continue;
    const blocks = BLOCK_KEYS.map((k) => r[k]).filter(isObj);
    for (const b of blocks) mix = countBlock(mix, b);
    if (blocks.length && typeof r.claim === 'string' && DID_NOT_RUN.test(r.claim)) mix = { ...mix, did_not_run: mix.did_not_run + 1 };
  }
  return mix.agents ? mix : null;
}

function mixLine(mix) {
  if (!mix) return null;
  const classes = ['top', 'mid', 'cheap', 'pinned'].filter((c) => mix.by_class[c]).map((c) => `${mix.by_class[c]} ${c}`);
  const models = Object.entries(mix.by_model).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, n]) => `\`${id}\` ${n}`);
  const parts = [
    classes.length ? classes.join(', ') : 'none requested',
    ...(models.length ? [models.join(', ')] : []),
    `session ${mix.session}`,
    `fallback-error ${mix.fallback_error}`,
    `unsupported ${mix.unsupported}`,
    `did not run ${mix.did_not_run}`,
  ];
  return `Models (requested): ${parts.join(' · ')}`;
}

module.exports = { computeMix, mixLine };
