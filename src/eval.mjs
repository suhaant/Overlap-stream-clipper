/**
 * EVALUATION
 *
 * The harness is written before any model, so there is no opportunity to tune
 * against the test set by accident.
 *
 * WHY NOT AUC. The product ships on the order of six clips an hour. Whether
 * second 1,847 of a four-hour stream is correctly scored 0.02 changes nothing.
 * Only the ranking at the very top matters, so the metric is precision@k.
 *
 * WHY MATCHING IS ASYMMETRIC. This is the decision the whole harness turns on.
 * Labels sit at the moment a human pressed clip, and tools/measure-lag.mjs
 * measured that press at a median of 16 seconds AFTER the chat peak, with a
 * p90 of 42 seconds. A detector that fires at the peak is therefore ~16
 * seconds early by construction. Under a symmetric +/-3s tolerance it would
 * score zero while doing exactly what it is supposed to do.
 *
 * Firing before the human is not an error, it is the entire product. So a
 * detection matches an event if it lands in
 *
 *     [event - maxLeadSec, event + graceSec]
 *
 * with maxLeadSec covering the press-lag distribution and graceSec small,
 * because a detector that only notices after the human already clipped has
 * added nothing.
 */

export const DEFAULT_MATCH = {
  // p90 of the measured chat-peak-to-press gap, rounded up.
  maxLeadSec: 45,
  // Slightly late still cuts the right clip once pre-roll is applied.
  graceSec: 5,
};

/**
 * Collapse a dense score series into discrete detections.
 *
 * Without this, one eruption produces a detection every step and a model can
 * claim six hits for finding one thing. Highest score first, then suppress
 * everything within refractorySec of it, which is the standard greedy
 * non-maximum suppression used in event detection.
 */
export function peakPick(scored, { refractorySec = 45 } = {}) {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const kept = [];
  const refractoryMs = refractorySec * 1000;

  for (const cand of sorted) {
    if (kept.some(k => Math.abs(k.t - cand.t) < refractoryMs)) continue;
    kept.push(cand);
  }
  return kept.sort((a, b) => b.score - a.score);
}

/**
 * Precision@k for one channel.
 *
 * Each event can be claimed once. Two detections bracketing the same moment
 * are one hit and one false positive, not two hits.
 */
export function precisionAtK(detections, events, { k, ...match } = {}) {
  const { maxLeadSec, graceSec } = { ...DEFAULT_MATCH, ...match };
  const top = detections.slice(0, k);
  const claimed = new Set();
  let hits = 0;

  for (const d of top) {
    let best = null, bestGap = Infinity;
    for (let i = 0; i < events.length; i++) {
      if (claimed.has(i)) continue;
      const lead = (events[i].atMs - d.t) / 1000;   // positive = fired early
      if (lead > maxLeadSec || lead < -graceSec) continue;
      if (Math.abs(lead) < bestGap) { bestGap = Math.abs(lead); best = i; }
    }
    if (best !== null) { claimed.add(best); hits++; }
  }

  return {
    k: top.length,
    hits,
    precision: top.length ? hits / top.length : 0,
    recall: events.length ? hits / events.length : 0,
  };
}

/** Events are worth finding in proportion to how many people clipped them. */
export function weightedRecall(detections, events, { k, ...match } = {}) {
  const { maxLeadSec, graceSec } = { ...DEFAULT_MATCH, ...match };
  const top = detections.slice(0, k);
  const claimed = new Set();
  let found = 0;
  const total = events.reduce((s, e) => s + (e.presses ?? 1), 0);

  for (const d of top) {
    for (let i = 0; i < events.length; i++) {
      if (claimed.has(i)) continue;
      const lead = (events[i].atMs - d.t) / 1000;
      if (lead > maxLeadSec || lead < -graceSec) continue;
      claimed.add(i); found += events[i].presses ?? 1; break;
    }
  }
  return total ? found / total : 0;
}

/**
 * Score one scorer across channels, held out by channel.
 *
 * Splitting by channel rather than by time or at random is the only honest
 * option here. Windows overlap, so a random split puts the same moment in
 * train and test and produces a beautiful meaningless number. Splitting by
 * channel also asks the question that matters commercially: does this work on
 * a streamer it has never seen?
 */
export function evaluate(byChannel, scoreFn, { perHour = 6, ...match } = {}) {
  const results = [];

  for (const [channel, { rows, events, hours }] of Object.entries(byChannel)) {
    if (!rows.length || !events.length) continue;
    const scored = rows.map(r => ({ t: r.t, score: scoreFn(r) }))
      .filter(s => Number.isFinite(s.score));
    if (!scored.length) continue;

    const detections = peakPick(scored, match);
    const k = Math.max(1, Math.round(perHour * (hours || 1)));
    const p = precisionAtK(detections, events, { k, ...match });

    results.push({
      channel, hours, events: events.length,
      ...p,
      weightedRecall: weightedRecall(detections, events, { k, ...match }),
    });
  }

  // Averaged over channels, not pooled over detections: pooling would let the
  // one busiest channel decide the number, and the claim is about streamers in
  // general.
  const mean = (key) => results.length
    ? results.reduce((s, r) => s + r[key], 0) / results.length : 0;

  return {
    perChannel: results.sort((a, b) => b.precision - a.precision),
    channels: results.length,
    precision: mean('precision'),
    recall: mean('recall'),
    weightedRecall: mean('weightedRecall'),
    totalHits: results.reduce((s, r) => s + r.hits, 0),
    totalK: results.reduce((s, r) => s + r.k, 0),
  };
}

/**
 * Bootstrap a confidence interval by resampling CHANNELS, not detections.
 *
 * With a handful of channels the interval comes out wide, and that is the
 * point: a precision figure from five streamers does not support a confident
 * claim, and an interval says so where a bare mean does not.
 */
export function bootstrapCI(perChannel, { samples = 2000, seed = 1, key = 'precision' } = {}) {
  if (perChannel.length < 2) return { lo: NaN, hi: NaN, n: perChannel.length };
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  const means = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let j = 0; j < perChannel.length; j++) {
      sum += perChannel[Math.floor(rnd() * perChannel.length)][key];
    }
    means.push(sum / perChannel.length);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(samples * 0.025)],
    hi: means[Math.floor(samples * 0.975)],
    n: perChannel.length,
  };
}
