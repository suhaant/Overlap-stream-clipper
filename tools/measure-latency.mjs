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

import { recordedChannels, recordedSpan, readRange } from '../src/chatlog.mjs';
import { loadModel, scorerFor } from '../src/score.mjs';
import { OnlineDetector } from '../src/online.mjs';

const CHAT_DIR = 'data/chat';
const only = process.argv[2];

let model;
try { model = loadModel(); } catch (e) { console.error(e.message); process.exit(1); }
const score = scorerFor(model);
const threshold = model.online?.threshold;

const channels = only ? [only] : recordedChannels(CHAT_DIR);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

const compute = [];
const decision = [];
let ticks = 0, fires = 0, hours = 0;

for (const ch of channels) {
  const span = recordedSpan(CHAT_DIR, ch);
  if (!span) continue;
  const { messages } = readRange(CHAT_DIR, ch, span.startMs, span.endMs);
  if (messages.length < 500) continue;

  const det = new OnlineDetector(score, threshold);
  for (const m of messages) {
    const t0 = process.hrtime.bigint();
    det.ingest(m);
    const fired = det.tick(m.t);
    const t1 = process.hrtime.bigint();

    // Only ticks that actually did the work are a cost; the rate limiter
    // skips most arrivals and averaging those in would understate it badly.
    if (det.lastTick === m.t) { compute.push(Number(t1 - t0) / 1e6); ticks++; }
    if (fired) { fires++; decision.push(fired.decidedAt - fired.t); }
  }
  hours += (span.endMs - span.startMs) / 3.6e6;
}

if (!compute.length) { console.error('no recorded chat to replay'); process.exit(1); }
compute.sort((a, b) => a - b);
decision.sort((a, b) => a - b);

console.log(`replayed ${channels.length} channels, ${ticks.toLocaleString()} scored ticks, ${fires} fires\n`);
console.log('compute per scored tick (ms)');
console.log(`  p50 ${pct(compute, 0.50).toFixed(2)}   p90 ${pct(compute, 0.90).toFixed(2)}` +
  `   p99 ${pct(compute, 0.99).toFixed(2)}   max ${compute[compute.length - 1].toFixed(2)}`);

if (decision.length) {
  console.log('\nchosen moment to commitment (s)');
  console.log(`  p50 ${(pct(decision, 0.50) / 1000).toFixed(1)}   p90 ${(pct(decision, 0.90) / 1000).toFixed(1)}` +
    `   max ${(decision[decision.length - 1] / 1000).toFixed(1)}`);
}

// A single process ticks each watched channel about once a second, so the
// channel ceiling is a second of budget divided by what one tick costs.
const p99 = pct(compute, 0.99);
console.log(`\nat p99 that is ~${Math.floor(1000 / p99)} channels per core before ticks start queueing`);
