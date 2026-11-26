/**
 * Firing live, which is a different problem from scoring well.
 *
 * tools/evaluate.mjs peak-picks offline: sort every window of the hour by
 * score, take the best, suppress its neighbours, repeat. That is a legitimate
 * way to measure a scorer and an impossible way to run one, because it needs
 * the whole hour before it can rank the first second of it.
 *
 * Online the detector must commit at t knowing only what came before. The gap
 * between those two regimes is real and is not captured by the benchmark
 * number, so it gets its own code and its own measurement rather than being
 * quietly assumed away.
 *
 * The rule here is threshold, settle, fire:
 *
 *  - idle: score each second, wait for the threshold to be crossed.
 *  - armed: the crossing is the start of something, not its peak. Track the
 *    maximum for up to `settleMs`, and fire at that maximum once the score
 *    falls back below the threshold or the settle window expires.
 *  - refractory: ignore everything for `refractorySec`, the same suppression
 *    width the benchmark uses, so one eruption cannot produce six clips.
 *
 * Settling costs latency and buys the peak instead of the leading edge. It is
 * nearly free here because the clip is cut retroactively from a rolling video
 * buffer -- the detector is choosing a timestamp in the recent past, not
 * deciding whether to start recording.
 */

import { buildRow, SCALES } from './windowrow.mjs';

/** Longest window the features need, plus room for out-of-order arrivals. */
const BUFFER_MS = Math.max(...SCALES) + 10_000;

/**
 * Refuse to have an opinion until the buffer spans the longest feature window.
 *
 * Every feature the model uses is a ratio of a 4s window to that window's own
 * 30s baseline. Before 30s of chat exists the baseline is short, so the ratios
 * are inflated and anything at all scores high. Caught live, not in the
 * benchmark: 7 seconds after connecting to a channel the detector fired on
 * seven people typing "EZ". The benchmark never sees this because
 * tools/build-dataset.mjs builds rows across hours of recording, where the
 * cold start happens once and is swamped; live it happens every reconnect.
 *
 * This is the same reason SpikeDetector has warmupMs, arrived at the same way.
 */
const WARMUP_MS = Math.max(...SCALES);

export const DEFAULTS = {
  settleMs: 8000,
  refractorySec: 45,
  tickMs: 1000,
};

/**
 * Self-calibration: hold the FIRE RATE steady per channel, not the threshold.
 *
 * One global threshold produces between 1.2 and 19.9 fires/hour depending on
 * the channel, and the spread tracks chat volume (Spearman +0.568) rather than
 * how often that channel actually has a moment (+0.298, not significant). So
 * the budget gets spent where chat is loud.
 *
 * The obvious fix -- a fixed quantile of the channel's own scores -- does not
 * work, and it is worth recording why. Measured across 21 channels, the
 * quantile that yields 6 fires/hour is no more stable than the raw threshold
 * (cv 0.088 against 0.085, so very slightly worse). A quantile is a rank, and
 * ranks are taken over scored rows; channels differ enormously in how many
 * scored rows an hour contains, so the same rank buys a different rate.
 *
 * What is actually invariant is the thing we want to hold invariant. So the
 * detector keeps a rolling buffer of its own recent (time, score) pairs and
 * periodically solves for the threshold that WOULD have produced the target
 * rate over that buffer, by replaying this same state machine against it.
 *
 * This reads no labels. It uses only scores the detector has already computed
 * on chat it has already seen, which is information a live detector genuinely
 * has, so a channel calibrated this way is not leaking its own ground truth.
 */
export const CALIBRATION = {
  firesPerHour: 6,
  windowMs: 60 * 60_000,   // history the threshold is solved against
  minSpanMs: 20 * 60_000,  // below this, keep using the global fallback
  everyMs: 60_000,         // re-solve at most this often
  iterations: 22,
};

export class OnlineDetector {
  /**
   * @param score (row) => number, from src/score.mjs
   * @param threshold the operating point, calibrated to a fires-per-hour rate
   */
  constructor(score, threshold, opts = {}) {
    const { settleMs, refractorySec, tickMs } = { ...DEFAULTS, ...opts };
    this.score = score;
    this.threshold = threshold;
    this.settleMs = settleMs;
    this.refractoryMs = refractorySec * 1000;
    this.tickMs = tickMs;

    this.messages = [];
    this.firstT = null;      // first message ever seen, for the warmup
    /**
     * `autoCalibrate: true` takes CALIBRATION, an object overrides it, and the
     * default (undefined) keeps the fixed threshold. The internal solver below
     * always builds detectors with this off, or it would recurse.
     */
    this.auto = opts.autoCalibrate
      ? { ...CALIBRATION, ...(opts.autoCalibrate === true ? {} : opts.autoCalibrate) }
      : null;
    this.history = [];       // rolling (t, s), only when self-calibrating
    this.lastCalibratedAt = -Infinity;
    this.calibrations = 0;
    this.state = 'idle';
    this.best = null;        // { t, score } while armed
    this.armedAt = 0;
    this.firedAt = -Infinity;
    this.lastTick = -Infinity;
  }

  /**
   * Buffer a message. Out-of-order arrivals are inserted in place rather than
   * appended: tmi timestamps are not monotonic across a reconnect, and an
   * unsorted buffer silently corrupts every window that spans the gap.
   */
  ingest(m) {
    const msg = { t: m.t, user: m.user ?? m.login ?? '?', text: m.text ?? '' };
    if (this.firstT === null) this.firstT = msg.t;
    const last = this.messages[this.messages.length - 1];
    if (!last || msg.t >= last.t) this.messages.push(msg);
    else {
      let i = this.messages.length - 1;
      while (i > 0 && this.messages[i - 1].t > msg.t) i--;
      this.messages.splice(i, 0, msg);
    }
    const cutoff = msg.t - BUFFER_MS;
    let drop = 0;
    while (drop < this.messages.length && this.messages[drop].t < cutoff) drop++;
    if (drop) this.messages.splice(0, drop);
  }

  /**
   * Advance to `now`. Returns a detection or null.
   *
   * Rate-limited to one evaluation per tickMs so a busy channel does not
   * rebuild the same window on every arriving message.
   */
  tick(now) {
    const warm = this.firstT !== null && now - this.firstT >= WARMUP_MS;
    const row = warm && this.messages.length ? buildRow(this.messages, now) : null;
    return advance(this, row, now);
  }
}

/**
 * One step of the state machine, for a row that is already built.
 *
 * Both entry points go through here. Keeping two copies of this -- one driving
 * live messages and one replaying prepared rows for calibration -- would mean
 * the operating point was measured on a detector that is not the one running,
 * which is the same class of mistake src/windowrow.mjs exists to prevent.
 *
 * `row` of null means too little chat to have an opinion. That is not a low
 * score: it leaves the state untouched, so a lull in the middle of an armed
 * window neither fires nor disarms it.
 */
export function advance(det, row, now = row?.t) {
  if (row === null) {
    if (now - det.lastTick >= det.tickMs) det.lastTick = now;
    // A chat that goes quiet while armed must still be able to commit.
    // Without this the detector sits armed until chat comes back, and fires
    // on a peak from however long ago that was: measured at up to 2,011
    // seconds on recorded data before this branch existed, which would have
    // cut a clip half an hour away from the moment it was about.
    return expireIfSettled(det, now);
  }
  const s = det.score(row);
  return Number.isFinite(s) ? advanceScored(det, now, s) : null;
}

/** Commit the best so far if the settle window has run out. */
function expireIfSettled(det, now) {
  if (det.state !== 'armed' || now - det.armedAt < det.settleMs) return null;
  const fired = { ...det.best, armedAt: det.armedAt, decidedAt: now, leadMs: now - det.best.t };
  det.state = 'idle';
  det.firedAt = now;
  det.best = null;
  return fired;
}

/**
 * The state machine proper, over a score that has already been computed.
 *
 * Split out so threshold calibration can sweep thresholds against cached
 * scores without re-deriving features, while still exercising this exact
 * code path rather than a copy of it.
 */
export function advanceScored(det, now, s) {
  if (now - det.lastTick < det.tickMs) return null;
  det.lastTick = now;
  if (det.auto) observe(det, now, s);
  if (now - det.firedAt < det.refractoryMs) return null;

  if (det.state === 'idle') {
    if (s < det.threshold) return null;
    det.state = 'armed';
    det.armedAt = now;
    det.best = { t: now, score: s };
    return null;
  }

  // Armed: the crossing was the start, so track the maximum and fire at it.
  if (s > det.best.score) det.best = { t: now, score: s };
  const settled = now - det.armedAt >= det.settleMs;
  if (s >= det.threshold && !settled) return null;

  const fired = { ...det.best, armedAt: det.armedAt, decidedAt: now, leadMs: now - det.best.t };
  det.state = 'idle';
  det.firedAt = now;
  det.best = null;
  return fired;
}

/**
 * Find the score threshold that fires at the intended rate.
 *
 * The benchmark hands each channel six picks per recorded hour, so the live
 * detector should fire about that often or the two are not comparable. A raw
 * probability cutoff cannot be read off the model: training upweights the
 * positive class to stop it predicting zero everywhere, which shifts every
 * score upward by an amount that depends on the class ratio. So the operating
 * point is measured by running the real detector, not derived.
 *
 * Binary search on the threshold, because fire rate is monotone in it.
 */
export function calibrateThreshold(byChannel, score, { firesPerHour = 6, iterations = 28, ...opts } = {}) {
  // Score every row once. The binary search below only varies the threshold,
  // and the state machine needs nothing from a row but its time and score, so
  // re-deriving features on each of ~28 passes would make calibration cost
  // more than training the model it is calibrating.
  const scored = [];
  let hours = 0;
  for (const g of Object.values(byChannel)) {
    if (!g.rows.length) continue;
    scored.push(g.rows.map(r => ({ t: r.t, s: score(r) })).filter(x => Number.isFinite(x.s)));
    hours += g.hours || 0;
  }
  if (!hours) return { threshold: 1, firesPerHour: 0 };

  const rate = (threshold) => {
    let fires = 0;
    for (const series of scored) {
      const det = new OnlineDetector(null, threshold, opts);
      for (const { t, s } of series) if (advanceScored(det, t, s)) fires++;
    }
    return fires / hours;
  };

  let lo = 0, hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (rate(mid) > firesPerHour) lo = mid; else hi = mid;
  }
  const threshold = (lo + hi) / 2;
  return { threshold, firesPerHour: rate(threshold) };
}

/** Drive the detector from an already-built row instead of raw messages. */
export const replayRow = (det, row) => advance(det, row, row.t);

/**
 * Turn a model firing into the same clip-window shape the heuristic emits, so
 * watch.mjs can hand either to the renderer without branching.
 *
 * `reactionLagMs` walks back from the chat peak to the thing people are
 * reacting to. 3500ms is the measured clip-start-to-chat-peak distance, not a
 * guess -- see docs/FINDINGS.md. The roll values match src/detector.mjs; if
 * they diverge the two paths produce differently-framed clips and the
 * comparison stops being about detection.
 */
export function toCandidate(fired, { reactionLagMs = 3500, preRollMs = 14000, postRollMs = 16000 } = {}) {
  const onsetAt = fired.t - reactionLagMs;
  return {
    id: `mdl_${fired.t}`,
    source: 'model',
    peakAt: fired.t,
    onsetAt,
    clipStartAt: onsetAt - preRollMs,
    clipEndAt: onsetAt + postRollMs,
    durationMs: preRollMs + postRollMs,
    modelScore: Number(fired.score.toFixed(4)),
    // How long after the chosen moment the detector committed. This is the
    // latency the settle window buys the peak with.
    decisionLagMs: fired.decidedAt - fired.t,
  };
}

/**
 * Buffer this score and, when due, re-solve the threshold against the buffer.
 *
 * Called after the tickMs rate limit, so the history holds exactly the scores
 * the state machine actually saw. Solving against every arriving message
 * instead would describe a detector that does not exist.
 */
function observe(det, now, s) {
  if (!Number.isFinite(s)) return;
  det.history.push({ t: now, s });
  const cutoff = now - det.auto.windowMs;
  let drop = 0;
  while (drop < det.history.length && det.history[drop].t < cutoff) drop++;
  if (drop) det.history.splice(0, drop);

  if (now - det.lastCalibratedAt < det.auto.everyMs) return;
  const span = now - det.history[0].t;
  if (span < det.auto.minSpanMs || det.history.length < 50) return;

  det.lastCalibratedAt = now;
  det.calibrations++;
  det.threshold = solveThreshold(det.history, det.auto);
}

/**
 * The threshold that would have produced `firesPerHour` over this history.
 *
 * Replays the real state machine rather than reasoning about the score
 * distribution, because settle and refractory collapse runs of high scores
 * into single fires and no closed form survives that. Binary search over
 * [0, 1] because the scores are probabilities.
 *
 * Cost is iterations x |history|: about 22 x 3,400 cheap steps once a minute
 * on a busy channel, against 0.14ms per scored tick sixty times a minute. It
 * does not show up.
 */
export function solveThreshold(history, { firesPerHour, iterations } = CALIBRATION) {
  const span = (history[history.length - 1].t - history[0].t) / 3_600_000;
  if (!(span > 0)) return 1;

  const rate = (threshold) => {
    const probe = new OnlineDetector(null, threshold);
    let fires = 0;
    for (const { t, s } of history) if (advanceScored(probe, t, s)) fires++;
    return fires / span;
  };

  let lo = 0, hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (rate(mid) > firesPerHour) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
