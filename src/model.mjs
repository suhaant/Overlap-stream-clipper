/**
 * The trained detector.
 *
 * Two decisions do most of the work here, and both come from the fact that the
 * benchmark holds out whole channels.
 *
 * **Features are channel-relative, not absolute.** ohnepixel sent 121k
 * messages in the recorded span and voodoosh sent 5k. A model handed raw
 * `w4_messages` learns audience size, which is the one thing guaranteed not to
 * transfer to a streamer it has never seen -- and worse, it would score well on
 * a pooled split and collapse on this one, which is exactly the trap the
 * channel split exists to catch. So every unbounded feature enters as a ratio
 * against the same feature over the 30s window: the channel's own baseline,
 * measured causally from chat before t and nothing after it.
 *
 * **Bounded features enter raw, plus a delta.** crowdRepetition is already a
 * share in [0,1] and comparable across channels, so it needs no normalising.
 * But the level matters less than the change -- a chat that is always repetitive
 * tells you nothing, a chat that just became repetitive tells you something --
 * so each one also enters as short-window minus long-window.
 */

import { fitScaler, applyScaler, fit, predict } from './logreg.mjs';

/**
 * Unbounded, scales with audience: enters only as a ratio to its own baseline.
 *
 * msgRate and chatterRate are deliberately absent. They are messages and
 * chatters divided by the window length, so dividing a 4s window by a 30s one
 * cancels the lengths and the ratio is *identical* to the count ratio -- the
 * first fit gave messages_r10 0.659 and msgRate_r10 0.658, which is the same
 * feature twice. Keeping both silently doubled rate's weight against every
 * other signal, which is the exact confound this benchmark is supposed to
 * expose rather than smuggle in.
 */
export const RATE_FEATURES = ['messages', 'chatters', 'meanLength'];

/** Already a share or density in [0,1]: comparable across channels as-is. */
export const SHARE_FEATURES = [
  'crowdRepetition', 'crowdDiversity', 'topTokenShare',
  'msgRepetition', 'msgLowDiversity', 'selfRepetition',
  'brevity', 'reactionWords', 'emoteDensity', 'screaming',
  'conversational', 'clipRequest', 'commandShare',
];

/**
 * A guarded ratio.
 *
 * The baseline is zero whenever the 30s window was silent, and a window with
 * no chat behind it carries no information about a spike. Returning 1 -- "the
 * same as baseline" -- is the honest answer, not Infinity and not 0.
 */
const ratio = (now, base) => (base > 0 ? now / base : 1);

/** The named feature vector the model actually sees. */
export function modelFeatures(r) {
  const f = {};

  for (const name of RATE_FEATURES) {
    f[`${name}_r4`] = ratio(r[`w4_${name}`] ?? 0, r[`w30_${name}`] ?? 0);
    f[`${name}_r10`] = ratio(r[`w10_${name}`] ?? 0, r[`w30_${name}`] ?? 0);
  }

  for (const name of SHARE_FEATURES) {
    const short = r[`w4_${name}`] ?? 0;
    const long = r[`w30_${name}`] ?? 0;
    f[`${name}_w4`] = short;
    f[`${name}_w30`] = long;
    f[`${name}_d`] = short - long;
  }

  return f;
}

export const MODEL_FEATURES = Object.keys(modelFeatures({}));

/**
 * Cap the training set, keeping every positive.
 *
 * Positives are ~3% of windows, so a fold is ~95k negatives and ~3k positives
 * and the gradient is dominated by near-duplicate negatives from adjacent
 * seconds. Subsampling negatives costs nothing real and makes a 14-fold
 * leave-one-channel-out run finish in a minute rather than twenty.
 *
 * Deterministic in the row index rather than random, so a rerun gives the same
 * model and a change in the number is a change in the code.
 */
export function subsample(rows, { maxNegatives = 40_000 } = {}) {
  const pos = rows.filter(r => (r.y ?? r.label) === 1);
  const neg = rows.filter(r => (r.y ?? r.label) !== 1);
  if (neg.length <= maxNegatives) return [...pos, ...neg];
  const stride = neg.length / maxNegatives;
  const kept = [];
  for (let i = 0; i < maxNegatives; i++) kept.push(neg[Math.floor(i * stride)]);
  return [...pos, ...kept];
}

/**
 * Feature subsets, for the ablation that settles whether convergence earns its
 * place or whether message rate was doing the work the whole time.
 *
 * This is the open worry from Day 2, and comparing hand-written scorers could
 * not settle it: they differ in their weights as well as their inputs. Fitting
 * the same model on different inputs holds everything else still.
 */
export const FEATURE_SETS = {
  all: () => MODEL_FEATURES,
  // What a good message counter can see, and nothing more.
  rate: () => MODEL_FEATURES.filter(n => RATE_FEATURES.some(r => n.startsWith(`${r}_`))),
  // Everything except how much chat there is.
  shares: () => MODEL_FEATURES.filter(n => !RATE_FEATURES.some(r => n.startsWith(`${r}_`))),
  // Rate, plus only the crowd-agreement features.
  rateAndConvergence: () => MODEL_FEATURES.filter(n =>
    RATE_FEATURES.some(r => n.startsWith(`${r}_`)) ||
    /^(crowdRepetition|crowdDiversity|topTokenShare)_/.test(n)),
};

/** Fit on these rows; returns a scorer usable by the evaluation harness. */
export function makeLogreg(trainRows, opts = {}) {
  const keys = opts.features ?? MODEL_FEATURES;
  const rows = subsample(trainRows, opts);
  const vectors = rows.map(modelFeatures);
  const scaler = fitScaler(vectors, keys);
  const X = vectors.map(v => applyScaler(scaler, v));
  const y = rows.map(r => ((r.y ?? r.label) === 1 ? 1 : 0));
  const model = fit(X, y, opts);

  const scorer = (r) => predict(model, applyScaler(scaler, modelFeatures(r)));
  // Exposed so tools can print what it learned instead of trusting the number.
  scorer.model = model;
  scorer.scaler = scaler;
  scorer.keys = keys;
  return scorer;
}

/** Weights by magnitude, for reading what the fit leaned on. */
export function weightReport(scorer, top = 12) {
  return (scorer.keys ?? MODEL_FEATURES)
    .map((name, i) => ({ name, weight: scorer.model.w[i] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, top);
}
