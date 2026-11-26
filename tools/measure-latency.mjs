#!/usr/bin/env node
/**
 * How long the detector takes to decide, on real chat.
 *
 * Two different latencies, and conflating them would flatter the system:
 *
 *   compute  -- message arrives, buffer updated, features built, model scored.
 *               This is what the machine costs, and it bounds how many
 *               channels one process can watch.
 *   decision -- the chosen moment, to the instant the detector commits to it.
 *               This is the settle window: the price paid to fire at the peak
 *               instead of at the leading edge. It is not dead time, because
 *               the clip is cut retroactively from the rolling buffer, but it
 *               is the delay before anything downstream can start.
 *
 * Replays recorded chat at full speed rather than in real time, so the compute
 * numbers are a true cost per tick and not a measure of how fast chat arrived.
 *
 * Usage: node tools/measure-latency.mjs [channel]
 */

import { readFileSync } from 'node:fs';
import { recordedChannels, recordedSpan, readRange } from '../src/chatlog.mjs';
import { loadModel, scorerFor } from '../src/score.mjs';
import { OnlineDetector } from '../src/online.mjs';

const CHAT_DIR = 'data/chat';
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

/** The detector's own tick interval; the harness drives it at the same rate. */
const TICK_MS = 1000;

let model;
try { model = loadModel(); } catch (e) { console.error(e.message); process.exit(1); }
const score = scorerFor(model);
const threshold = model.online?.threshold;

const channels = only ? [only] : recordedChannels(CHAT_DIR);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

const compute = [];
const decision = [];
let ticks = 0, fires = 0, hours = 0;

/**
 * Self-calibration is part of the shipped detector, so it is part of the cost.
 * `--no-calibrate` measures the old fixed-threshold path for comparison.
 */
const AUTO = process.argv.includes('--no-calibrate')
  ? null
  : (JSON.parse(readFileSync('data/model.json', 'utf8')).online?.autoCalibrate ?? null);
let calibrations = 0;
const solves = [];
/** Per-channel cost, because a dead channel and a 20k-message one are not the
 *  same tenant and a fleet average over both would size nothing correctly. */
const perChannel = [];

for (const ch of channels) {
  const span = recordedSpan(CHAT_DIR, ch);
  if (!span) continue;
  const { messages } = readRange(CHAT_DIR, ch, span.startMs, span.endMs);
  if (messages.length < 500) continue;

  // Measure the detector as it actually ships, in two respects.
  //
  // The once-a-minute threshold solve is real work on the same core, so it is
  // timed inside the tick that triggers it rather than excused as "amortised".
  //
  // And the clock drives the ticks, not message arrival. Replaying
  // message-driven made the max decision latency 27.2s against 18.8s here,
  // because a quiet stretch has no arrival to expire an armed settle window.
  // watch.mjs stopped working that way; a harness that still does is
  // measuring a detector that no longer exists.
  const det = new OnlineDetector(score, threshold, AUTO ? { autoCalibrate: AUTO } : {});
  let next = 0, computeThisChannel = 0;
  for (let now = messages[0].t; now <= span.endMs; now += TICK_MS) {
    const t0 = process.hrtime.bigint();
    while (next < messages.length && messages[next].t <= now) det.ingest(messages[next++]);
    const fired = det.tick(now);
    const t1 = process.hrtime.bigint();

    const ms = Number(t1 - t0) / 1e6;
    compute.push(ms);
    computeThisChannel += ms;
    ticks++;
    if (det.calibrations > calibrations) { calibrations = det.calibrations; solves.push(ms); }
    if (fired) { fires++; decision.push(fired.decidedAt - fired.t); }
  }
  const chHours = (span.endMs - span.startMs) / 3.6e6;
  hours += chHours;
  const chTicks = Math.max(1, Math.floor((span.endMs - messages[0].t) / TICK_MS));
  perChannel.push({
    ch, msgPerMin: messages.length / (chHours * 60),
    msPerTick: computeThisChannel / chTicks,
  });
}

if (!compute.length) { console.error('no recorded chat to replay'); process.exit(1); }
compute.sort((a, b) => a - b);
decision.sort((a, b) => a - b);

console.log(`replayed ${channels.length} channels, ${ticks.toLocaleString()} clock ticks over ` +
  `${hours.toFixed(1)}h, ${fires} fires\n`);
console.log('compute per tick (ms) -- every tick, quiet ones included, as a');
console.log('running process pays for those too');
console.log(`  p50 ${pct(compute, 0.50).toFixed(2)}   p90 ${pct(compute, 0.90).toFixed(2)}` +
  `   p99 ${pct(compute, 0.99).toFixed(2)}   max ${compute[compute.length - 1].toFixed(2)}`);

if (decision.length) {
  console.log('\nchosen moment to commitment (s)');
  console.log(`  p50 ${(pct(decision, 0.50) / 1000).toFixed(1)}   p90 ${(pct(decision, 0.90) / 1000).toFixed(1)}` +
    `   max ${(decision[decision.length - 1] / 1000).toFixed(1)}`);
}

// A single process ticks each watched channel once a second, so the ceiling is
// a second of budget divided by what a second of one channel costs. Mean, not
// p99: across many channels the expensive ticks do not line up, and sizing on
// p99 would assume they all solve their threshold in the same second.
const mean = compute.reduce((a, b) => a + b, 0) / compute.length;
const p99 = pct(compute, 0.99);
console.log(`\nmean ${mean.toFixed(3)}ms/tick across all ${channels.length} channels`);

// Capacity depends entirely on who the tenants are. A fleet average over a mix
// that includes dead channels sizes nothing, so quote the busy end.
perChannel.sort((a, b) => b.msPerTick - a.msPerTick);
console.log('\ncost per channel-second, busiest first');
for (const c of perChannel.slice(0, 5)) {
  console.log(`  ${c.ch.padEnd(16)} ${c.msgPerMin.toFixed(0).padStart(5)} msg/min  ` +
    `${c.msPerTick.toFixed(3)}ms/tick  -> ${Math.floor(1000 / c.msPerTick).toLocaleString()} of these per core`);
}
const busiest = perChannel[0];
console.log(`\nso: ~${Math.floor(1000 / busiest.msPerTick).toLocaleString()} channels per core at the busiest ` +
  `channel's load, ~${Math.floor(1000 / mean).toLocaleString()} at this sample's average.`);
console.log(`the honest headline is the first one. p99 across all ticks is ${p99.toFixed(2)}ms,`);
console.log(`but sizing on it assumes every channel has its worst second simultaneously.`);
if (solves.length) {
  const ss = [...solves].sort((a, b) => a - b);
  const q = (f) => ss[Math.min(ss.length - 1, Math.floor(ss.length * f))];
  const total = solves.reduce((a, b) => a + b, 0);
  console.log(`\n${solves.length} threshold solves, the tick carrying one costs ` +
    `p50 ${q(0.5).toFixed(2)}ms  p99 ${q(0.99).toFixed(2)}ms  max ${ss[ss.length - 1].toFixed(2)}ms`);
  console.log(`they are ${(100 * total / compute.reduce((a, b) => a + b, 0)).toFixed(1)}% of all compute, ` +
    `which is what the per-channel figure above already includes`);
}
