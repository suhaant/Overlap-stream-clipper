/**
 * Scoring a live chat window with the trained model.
 *
 * The contract this file exists to keep: a score produced here, from messages
 * arriving over the socket, must equal the score tools/evaluate.mjs would have
 * produced from the same messages read off disk. If it does not, the benchmark
 * is measuring one system and the product is another, and nothing in the test
 * suite would say so.
 *
 * Three things protect that. The row is built by src/windowrow.mjs, the same
 * function the dataset builder calls. The scales and minimum-chat rule travel
 * inside the model artifact and are checked against the running code on load.
 * And a test scores the same messages through both paths and asserts equality.
 */

import { readFileSync, existsSync } from 'node:fs';
import { applyScaler, predict } from './logreg.mjs';
import { modelFeatures } from './model.mjs';
import { buildRow, SCALES, MIN_MESSAGES } from './windowrow.mjs';

export const DEFAULT_MODEL = 'data/model.json';

/**
 * Load a trained model, refusing one whose row shape no longer matches.
 *
 * A mismatch means the feature code changed after training. Scoring anyway
 * would produce plausible numbers from a model fit on different inputs, which
 * is the worst available outcome -- far worse than refusing to start.
 */
export function loadModel(path = DEFAULT_MODEL) {
  if (!existsSync(path)) {
    throw new Error(`no model at ${path}. Run: npm run train`);
  }
  const m = JSON.parse(readFileSync(path, 'utf8'));

  const spec = m.rowSpec ?? {};
  const sameScales = Array.isArray(spec.scales) &&
    spec.scales.length === SCALES.length &&
    spec.scales.every((v, i) => v === SCALES[i]);
  if (!sameScales) {
    throw new Error(
      `model was trained on scales [${spec.scales}] but the code builds [${SCALES}]. Retrain: npm run train`);
  }
  if (spec.minMessages !== MIN_MESSAGES) {
    throw new Error(
      `model was trained with minMessages ${spec.minMessages}, code uses ${MIN_MESSAGES}. Retrain: npm run train`);
  }
  return m;
}

/** A scorer over already-built feature rows. */
export function scorerFor(model) {
  const scaler = { keys: model.scaler.keys, min: model.scaler.min, max: model.scaler.max };
  const fitted = { w: model.weights, b: model.bias };
  return (row) => predict(fitted, applyScaler(scaler, modelFeatures(row)));
}

/**
 * A scorer over raw messages.
 *
 * `messages` must be sorted by `t` and contain only messages at or before the
 * instant being scored -- the caller's buffer, not a snapshot that happens to
 * include a later arrival. Returns null when there is too little chat to have
 * an opinion, which is not the same as a score of zero: a quiet chat is
 * absence of evidence, and a caller that treats it as evidence of absence will
 * rank silence above conversation.
 */
export function liveScorer(model) {
  const score = scorerFor(model);
  return (messages, atMs) => {
    const row = buildRow(messages, atMs);
    return row === null ? null : score(row);
  };
}

/** Load and wire in one call, for callers that just want to score. */
export function loadScorer(path = DEFAULT_MODEL) {
  const model = loadModel(path);
  const live = liveScorer(model);
  live.model = model;
  return live;
}
