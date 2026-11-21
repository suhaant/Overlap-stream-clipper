import { EventEmitter } from 'node:events';
import { shapeOf } from './shape.mjs';

/**
 * Chat-spike detector.
 *
 * Three decisions carry this:
 *
 * 1. COMPARE LIKE WITH LIKE.
 *    v1 compared unique chatters in a 4s window against unique-chatters-per-second
 *    over 180s. That is invalid: uniqueness SATURATES over long windows because the
 *    same regulars talk repeatedly. 200 distinct people over 3 min reads as 1.1/s,
 *    while 15 distinct people in 4s reads as 3.75/s -- a 3.4x "spike" when nothing
 *    happened. Now we slice the baseline into same-sized 4s buckets and compare a
 *    bucket against the DISTRIBUTION of buckets, via median and MAD. Median because
 *    chat has fat tails and one earlier spike must not move the baseline.
 *
 * 2. COUNT UNIQUE CHATTERS, NOT MESSAGES.
 *    One person firing 40 messages is not a moment; 400 people typing once is.
 *    Message rate is trivially gamed by spam and copypasta. Unique-sender rate is not.
 *
 * 3. CHAT REACTS *AFTER* THE EVENT.
 *    Encode + network + human reaction means chat peaks ~3-5s after the thing
 *    happened on screen. Clip from the chat peak and you land on the laughter and
 *    miss the joke. Estimated onset = peak - REACTION_LAG, and the clip window is
 *    built backwards from there.
 *
 * A spike that passes the statistics must then pass the reaction-shape gate in
 * shape.mjs, which is what keeps conversation and platform outages out.
 */

const DEFAULTS = {
  tickMs: 250,
  shortWindowMs: 4000,
  baselineWindowMs: 240000,
  baselineExcludeMs: 12000,
  minBuckets: 10,
  warmupMs: 60000,

  fireZ: 3.2,            // robust z-score against the bucket distribution
  sustainZ: 1.5,         // hysteresis -- follow the spike to its peak
  fireRatio: 1.7,        // sanity check vs median
  minUniqueChatters: 10,
  shapeGate: 0.30,       // below this it is conversation, not reaction

  maxSpikeMs: 45000,
  refractoryMs: 25000,
  reactionLagMs: 3500,
  preRollMs: 14000,
  postRollMs: 16000,
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class SpikeDetector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...opts };
    this.events = [];
    this.open = null;
    this.lastFiredAt = 0;
    this.startedAt = null;
    this.clock = () => Date.now();
    this.stats = { messages: 0, considered: 0, accepted: 0, rejected: 0 };
  }

  start() {
    this.startedAt = this.clock();
    this.timer = setInterval(() => this.tick(this.clock()), this.cfg.tickMs);
    return this;
  }

  stop() { clearInterval(this.timer); }

  ingest(msg) {
    if (this.startedAt === null) this.startedAt = msg.t;
    this.events.push(msg);
    this.stats.messages++;
    const cutoff = msg.t - this.cfg.baselineWindowMs - 30000;
    if (this.events.length > 500 && this.events[0].t < cutoff) {
      let i = 0;
      while (i < this.events.length && this.events[i].t < cutoff) i++;
      this.events.splice(0, i);
    }
  }

  #window(fromT, toT) {
    const out = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t < fromT) break;
      if (e.t <= toT) out.push(e);
    }
    return out.reverse();
  }

  #uniques(fromT, toT) {
    const s = new Set();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t < fromT) break;
      if (e.t <= toT) s.add(e.user);
    }
    return s.size;
  }

  /** Distribution of unique-chatter counts across same-sized historical buckets. */
  #baseline(now) {
    const c = this.cfg;
    const to = now - c.baselineExcludeMs;
    const from = now - c.baselineWindowMs;
    const nb = Math.floor((to - from) / c.shortWindowMs);
    if (nb < c.minBuckets) return null;

    const sets = Array.from({ length: nb }, () => new Set());
    for (const e of this.events) {
      if (e.t < from || e.t >= to) continue;
      const i = Math.floor((e.t - from) / c.shortWindowMs);
      if (i >= 0 && i < nb) sets[i].add(e.user);
    }
    const counts = sets.map(s => s.size);
    const med = median(counts);
    const mad = median(counts.map(x => Math.abs(x - med)));
    // 1.4826 scales MAD into a consistent estimator of sigma for normal data.
    const sigma = Math.max(1.4826 * mad, 1.0, med * 0.15);
    return { median: med, mad, sigma, buckets: nb, counts };
  }

  tick(now) {
    const c = this.cfg;
    if (this.startedAt === null || now - this.startedAt < c.warmupMs) return;

    const base = this.#baseline(now);
    if (!base) return;

    const cur = this.#uniques(now - c.shortWindowMs, now);
    const z = (cur - base.median) / base.sigma;
    const ratio = cur / Math.max(base.median, 1);

    this.emit('tick', {
      t: now, z: Number(z.toFixed(2)), ratio: Number(ratio.toFixed(2)),
      uniques: cur, median: base.median, sigma: Number(base.sigma.toFixed(2)),
      spiking: Boolean(this.open),
    });

    if (!this.open) {
      const cool = now - this.lastFiredAt > c.refractoryMs;
      if (cool && z >= c.fireZ && ratio >= c.fireRatio && cur >= c.minUniqueChatters) {
        this.open = { startedAt: now, peakAt: now, peakZ: z, peakRatio: ratio, peakUniques: cur, base };
        this.emit('spike:open', { t: now, z, ratio, uniques: cur });
      }
      return;
    }

    if (z > this.open.peakZ) {
      Object.assign(this.open, { peakZ: z, peakAt: now, peakRatio: ratio, peakUniques: cur });
    }

    const expired = now - this.open.startedAt > c.maxSpikeMs;
    if (z >= c.sustainZ && !expired) return;

    const s = this.open;
    this.open = null;
    this.lastFiredAt = now;
    this.stats.considered++;

    const onsetAt = s.peakAt - c.reactionLagMs;
    const window = this.#window(onsetAt - 2000, s.peakAt + 5000);
    const shape = shapeOf(window);

    const candidate = {
      id: `spk_${s.peakAt}`,
      peakAt: s.peakAt,
      onsetAt,
      clipStartAt: onsetAt - c.preRollMs,
      clipEndAt: onsetAt + c.postRollMs,
      durationMs: c.preRollMs + c.postRollMs,
      peakZ: Number(s.peakZ.toFixed(2)),
      peakRatio: Number(s.peakRatio.toFixed(2)),
      peakUniqueChatters: s.peakUniques,
      baselineMedian: s.base.median,
      baselineSigma: Number(s.base.sigma.toFixed(2)),
      spikeDurationMs: now - s.startedAt,
      truncated: expired,
      shape,
      window: window.map(m => ({ t: m.t, login: m.login, text: m.text, emoteCount: m.emoteCount })),
    };

    if (shape.shape < c.shapeGate) {
      this.stats.rejected++;
      this.emit('spike:rejected', candidate);
    } else {
      this.stats.accepted++;
      this.emit('spike', candidate);
    }
  }
}
