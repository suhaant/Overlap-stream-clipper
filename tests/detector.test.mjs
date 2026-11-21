import { test } from 'node:test';
import assert from 'node:assert';
import { SpikeDetector } from '../src/detector.mjs';
import { shapeOf } from '../src/shape.mjs';

/**
 * Synthetic chat with REALISTIC uniqueness overlap.
 *
 * This is the crux of the v1 bug. Chat is not a stream of strangers: a pool of
 * regulars talks repeatedly. So a 4s window holds ~15 distinct people while a 240s
 * window holds only ~250 -- far fewer than 60x15. Uniqueness saturates. Any method
 * that divides a long-window unique COUNT by its duration understates the baseline
 * badly, and every ratio computed against it is inflated.
 */
function steadyChat({ startT, durationMs, poolSize = 250, perWindow = 15, windowMs = 4000 }) {
  const msgs = [];
  const pool = Array.from({ length: poolSize }, (_, i) => `u${i}`);
  for (let w = 0; w * windowMs < durationMs; w++) {
    const base = startT + w * windowMs;
    const picked = new Set();
    while (picked.size < perWindow) picked.add(pool[Math.floor(Math.random() * poolSize)]);
    for (const user of picked) {
      for (let k = 0; k < 4; k++) {
        msgs.push({ t: base + Math.floor(Math.random() * windowMs), user, login: user, text: 'talking about the game here', emoteCount: 0 });
      }
    }
  }
  return msgs.sort((a, b) => a.t - b.t);
}

function massReaction({ atT, users = 140, windowMs = 3000 }) {
  const msgs = [];
  for (let i = 0; i < users; i++) {
    const user = `r${i}`;
    msgs.push({ t: atT + Math.floor(Math.random() * windowMs), user, login: user, text: 'KEKW', emoteCount: 1 });
  }
  return msgs;
}

function run(msgs, cfg = {}) {
  const det = new SpikeDetector(cfg);
  const fired = [], rejected = [];
  det.on('spike', s => fired.push(s));
  det.on('spike:rejected', s => rejected.push(s));
  msgs.sort((a, b) => a.t - b.t);
  det.startedAt = msgs[0].t;
  let i = 0;
  for (let now = msgs[0].t; now <= msgs[msgs.length - 1].t; now += det.cfg.tickMs) {
    while (i < msgs.length && msgs[i].t <= now) det.ingest(msgs[i++]);
    det.tick(now);
  }
  return { fired, rejected, det };
}

/** The v1 calculation, reproduced so the bug is visible as a number. */
function v1Ratio(msgs, now, shortMs = 4000, longMs = 240000) {
  const uniq = (from, to) => new Set(msgs.filter(m => m.t >= from && m.t <= to).map(m => m.user)).size;
  const shortRate = uniq(now - shortMs, now) / (shortMs / 1000);
  const longRate = uniq(now - longMs, now - 12000) / (longMs / 1000);
  return shortRate / Math.max(longRate, 0.35);
}

test('v1 baseline math reports a large phantom spike on perfectly steady chat', () => {
  const start = 1_700_000_000_000;
  const msgs = steadyChat({ startT: start, durationMs: 300000 });
  const ratio = v1Ratio(msgs, start + 280000);
  console.log(`      v1 ratio on steady chat: ${ratio.toFixed(2)}x (fireRatio was 2.6)`);
  assert.ok(ratio > 2.0, `expected inflated ratio, got ${ratio}`);
});

test('v2 fires nothing on steady chat', () => {
  const start = 1_700_000_000_000;
  const { fired, det } = run(steadyChat({ startT: start, durationMs: 300000 }));
  console.log(`      v2 on steady chat: ${fired.length} spikes from ${det.stats.messages} messages`);
  assert.strictEqual(fired.length, 0);
});

test('v2 fires on a genuine mass reaction and locates the onset', () => {
  const start = 1_700_000_000_000;
  const eventAt = start + 200000;
  const msgs = [
    ...steadyChat({ startT: start, durationMs: 300000 }),
    ...massReaction({ atT: eventAt }),
  ];
  const { fired } = run(msgs);
  console.log(`      v2 on injected reaction: ${fired.length} spike(s), z=${fired[0]?.peakZ}, shape=${fired[0]?.shape.shape}`);
  assert.strictEqual(fired.length, 1);
  // Onset should sit near the event, having walked back the reaction lag.
  const errSec = Math.abs(fired[0].onsetAt - eventAt) / 1000;
  assert.ok(errSec < 12, `onset off by ${errSec.toFixed(1)}s`);
});

test('shape gate separates reaction from conversation', () => {
  const reaction = ['KEKW','KEKW','LMAO','KEKW KEKW','OMEGALUL','LOL','kekw','WHAT','?????','KEKW']
    .map((text, i) => ({ login: `u${i}`, text, emoteCount: 1 }));
  const conversation = [
    'how does he have 60 fps on console',
    '@streamer what settings are you using',
    'i think the next mission is in vice city beach',
    'is youtube down for anyone else right now',
    'wait did he already finish chapter 3?',
    'the driving feels way better than gta 5 honestly',
    '@someone no it came out on wednesday',
    'what time does the stream usually end',
  ].map((text, i) => ({ login: `u${i}`, text, emoteCount: 0 }));

  const r = shapeOf(reaction), c = shapeOf(conversation);
  console.log(`      reaction shape ${r.shape} · conversation shape ${c.shape}`);
  assert.ok(r.shape > 0.45, `reaction scored too low: ${r.shape}`);
  assert.ok(c.shape < 0.30, `conversation scored too high: ${c.shape}`);
  assert.ok(r.shape - c.shape > 0.3, 'gate does not separate the two');
});
