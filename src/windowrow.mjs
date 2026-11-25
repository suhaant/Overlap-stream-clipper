/**
 * The one place a feature row is built.
 *
 * The benchmark and the live detector must produce byte-identical rows for the
 * same chat, or the number on the slide is not the number the product gets.
 * That failure is silent and it is the easiest one in this project to make:
 * change a window scale offline, forget it online, and the model is scoring
 * inputs it was never fit on while every test still passes.
 *
 * So the scales, the rounding and the "enough chat to bother" rule live here,
 * and both tools/build-dataset.mjs and src/score.mjs call this.
 */

import { windowFeatures } from './features.mjs';

/** Multi-scale: the model needs the shape over time, not one instant. */
export const SCALES = [4000, 10000, 30000];

/** The shortest window is the one that has to carry a reaction. */
export const MIN_MESSAGES = 5;

/** Rounded on write so the dataset is diffable and the live path matches it. */
const round = (v) => Number(v.toFixed(4));

/**
 * First index with t >= cutoff, over messages sorted by t.
 *
 * Binary search rather than filter: at one row per second over a 30s window
 * this runs a hundred thousand times per channel offline and once per second
 * per channel live.
 */
export function lowerBound(messages, cutoff) {
  let lo = 0, hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].t < cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Build the feature row for the instant `t` from messages at or before it.
 *
 * Returns null when the shortest window is too thin to mean anything, which
 * the caller should treat as "no opinion" rather than as a zero score: a
 * silent chat is not evidence against a moment, it is absence of evidence.
 *
 * Causal by construction -- the slice ends at `t` and nothing after it is
 * read -- which is the property the whole benchmark rests on.
 */
export function buildRow(messages, t, { ch = null, scales = SCALES, minMessages = MIN_MESSAGES } = {}) {
  const row = ch === null ? { t } : { ch, t };
  let enough = false;

  for (const scale of scales) {
    const lo = lowerBound(messages, t - scale);
    const hi = lowerBound(messages, t);
    const w = messages.slice(lo, hi);
    if (scale === scales[0] && w.length >= minMessages) enough = true;
    const f = windowFeatures(w, { windowMs: scale });
    const tag = `w${scale / 1000}`;
    for (const [k, v] of Object.entries(f)) row[`${tag}_${k}`] = round(v);
  }

  return enough ? row : null;
}
