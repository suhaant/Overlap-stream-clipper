/**
 * BASELINES
 *
 * Ordered by how embarrassing it would be to lose to them. Every one of these
 * is a scorer: a function from a dataset row to a number, higher meaning more
 * clip-worthy. Nothing here is tuned against the test set.
 */

import { fitScaler, applyScaler, fit, predict } from './logreg.mjs';

const ratio = (a, b) => (b > 0.05 ? a / b : 0);

/**
 * 1. MESSAGE VELOCITY.
 *
 * Chat got faster than usual. This is what ClipSpeed's public description
 * amounts to -- "chat-velocity spikes" -- and what NeonClipping ships for
 * free. The short window against the long one is a spike ratio without
 * needing any state.
 *
 * If nothing here beats this, there is no project.
 */
export const velocity = (r) => ratio(r.w4_msgRate, r.w30_msgRate);

/**
 * 2. CHATTER VELOCITY.
 *
 * The same idea counted in people rather than messages. Separated out because
 * the whole thesis is that people are the unit, so the cheapest version of
 * that claim deserves its own line in the table.
 */
export const chatterVelocity = (r) => ratio(r.w4_chatterRate, r.w30_chatterRate);

/**
 * 3. THE CURRENT HEURISTIC.
 *
 * src/shape.mjs's weights, applied to the 4s window, gated on having enough
 * distinct chatters the way src/detector.mjs gates on minUniqueChatters. The
 * thing this project is replacing.
 *
 * It uses the CORRECTED convergence, not the message-level version it shipped
 * with. Scoring the old bug would be beating a strawman, and the question is
 * whether learned weights beat hand-chosen ones, not whether they beat a bug.
 */
export function currentHeuristic(r, { minChatters = 10 } = {}) {
  if ((r.w4_chatters ?? 0) < minChatters) return 0;
  const convergence = 0.5 * r.w4_crowdRepetition + 0.5 * r.w4_crowdDiversity;
  const positive =
      0.62 * convergence +
      0.12 * r.w4_brevity +
      0.12 * r.w4_reactionWords +
      0.08 * r.w4_emoteDensity +
      0.06 * r.w4_screaming;
  const shape = Math.max(0, Math.min(1, positive - 0.50 * r.w4_conversational));
  // The live detector fires on a spike AND the shape gate, so the score has to
  // combine both or it is not the same decision rule.
  return shape * ratio(r.w4_chatterRate, r.w30_chatterRate);
}

/**
 * 4. LIGHTOR, reimplemented.
 *
 * arXiv:1910.12201 combines three normalised chat features over 25-second
 * sliding windows with logistic regression:
 *
 *   Message Number     -> w30_messages
 *   Message Length     -> w30_meanLength
 *   Message Similarity -> w30_msgLowDiversity
 *
 * Two honest approximations. The windows here are 30s rather than 25s,
 * because that is the scale the dataset already carries. And the paper's
 * similarity is bag-of-words vectors against a one-cluster k-means centre,
 * where this uses the vocabulary-to-token ratio over the same window; both
 * measure how alike the messages are, by different arithmetic.
 *
 * Deliberately NOT given the crowd-level fix from src/features.mjs. The point
 * is to reproduce the published method, and the published method measures
 * repetition per message.
 */
export const LIGHTOR_FEATURES = ['w30_messages', 'w30_meanLength', 'w30_msgLowDiversity'];

export function makeLightor(trainRows) {
  const scaler = fitScaler(trainRows, LIGHTOR_FEATURES);
  const X = trainRows.map(r => applyScaler(scaler, r));
  const y = trainRows.map(r => r.label);
  const model = fit(X, y, { epochs: 500, lr: 0.5 });
  const scorer = (r) => predict(model, applyScaler(scaler, r));
  scorer.model = model;
  scorer.features = LIGHTOR_FEATURES;
  return scorer;
}

/**
 * 5. CONVERGENCE ALONE.
 *
 * Not a competitor's method and not the current heuristic: the thesis stated
 * as bluntly as possible, with no rate term at all. It exists to answer the
 * confound in docs/FINDINGS.md -- whether the signal is really agreement, or
 * just audience size wearing agreement's clothes. If this scores near zero
 * while velocity scores well, the honest conclusion is that rate was doing
 * the work the whole time.
 */
export const convergenceOnly = (r) =>
  0.5 * r.w4_crowdRepetition + 0.5 * r.w4_crowdDiversity;

/** Sanity floor: a fixed score, so peak-picking returns arbitrary windows. */
export const constant = () => 1;

export const BASELINES = {
  velocity,
  chatterVelocity,
  currentHeuristic,
  convergenceOnly,
  constant,
};
