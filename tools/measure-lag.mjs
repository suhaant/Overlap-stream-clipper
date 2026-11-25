#!/usr/bin/env node
/**
 * Measure the reaction lag from data instead of assuming it.
 *
 *   node tools/measure-lag.mjs
 *
 * Two numbers in this project contradict each other.
 *
 *   src/detector.mjs    reactionLagMs: 3500
 *   LIGHTOR (2019)      c = 23-27s, learned from labelled video
 *
 * docs/RESEARCH.md noted they may be measuring different distances, and that
 * the labelled data could settle it. This settles it.
 *
 * Three distances exist and only two are observable:
 *
 *   on-screen event  ->  chat peak      the thing reactionLagMs means. NOT
 *                                       observable: nothing records when the
 *                                       event happened.
 *   clip start       ->  chat peak      observable. The clip's start is a
 *                                       human's judgement of where the moment
 *                                       begins, which is the closest proxy for
 *                                       the event there is. This is the
 *                                       quantity LIGHTOR calls c.
 *   chat peak        ->  press          observable. How long after chat erupts
 *                                       someone reaches for the button.
 *
 * So the comparison with LIGHTOR is the middle one, and the third tells us how
 * late a live detector is allowed to be and still beat a human.
 */

import { loadEnv } from '../src/env.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRange, recordedChannels, recordedSpan } from '../src/chatlog.mjs';
import { locateClip, clusterPresses } from '../src/align.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CHAT_DIR = flag('chat', 'data/chat');
const CLIP_DIR = flag('clips', 'data/clips');
const BEFORE_SEC = Number(flag('before', 90));
const AFTER_SEC = Number(flag('after', 90));
const SMOOTH_SEC = Number(flag('smooth', 3));
const MIN_PEAK_CHATTERS = Number(flag('min-peak', 8));
/** How far above the window's own baseline a peak must rise to count. */
const SPIKE_Z = Number(flag('spike-z', 2.5));
/** A reaction cannot precede its moment by much, nor follow it by minutes. */
const SEARCH_BEFORE_SEC = Number(flag('search-before', 45));
const SEARCH_AFTER_SEC = Number(flag('search-after', 15));

const isCommand = (t) => /^\s*!/.test(t);

/**
 * Chat activity per second, as DISTINCT CHATTERS rather than messages.
 *
 * Message count is dominated by whoever is spamming hardest; the question here
 * is when the room reacted, which is a count of people. Commands are excluded
 * for the reason given in src/features.mjs: a !rested spree is not a reaction
 * and would otherwise place the peak wherever the bot happened to be busy.
 */
function activitySeries(messages, fromMs, toMs) {
  const n = Math.ceil((toMs - fromMs) / 1000);
  const sets = Array.from({ length: n }, () => new Set());
  for (const m of messages) {
    if (isCommand(m.text)) continue;
    const i = Math.floor((m.t - fromMs) / 1000);
    if (i >= 0 && i < n) sets[i].add(m.user);
  }
  const raw = sets.map(s => s.size);

  // Smooth, or a single noisy second wins the argmax.
  const half = Math.floor(SMOOTH_SEC / 2);
  return raw.map((_, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) {
      sum += raw[j]; count++;
    }
    return sum / count;
  });
}

function loadClips(channel) {
  const path = join(CLIP_DIR, `${channel}.jsonl`);
  if (!existsSync(path)) return [];
  const out = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line); if (c.vodOffset !== null) out.set(c.id, c); } catch {}
  }
  return [...out.values()];
}

function quantiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) };
}

const show = (label, q) =>
  console.log(`  ${label.padEnd(26)} n=${String(q.n).padStart(4)}  p10 ${q.p10.toFixed(1).padStart(6)}  p25 ${q.p25.toFixed(1).padStart(6)}  median ${q.median.toFixed(1).padStart(6)}  p75 ${q.p75.toFixed(1).padStart(6)}  p90 ${q.p90.toFixed(1).padStart(6)}`);

async function main() {
  const videos = existsSync('data/videos.json')
    ? JSON.parse(readFileSync('data/videos.json', 'utf8')) : {};

  const peakToPress = [];
  const clipStartToPeak = [];
  const histogram = new Map();
  let considered = 0, tooQuiet = 0;
  // Separated on purpose. "The channel is too small to measure" and "this
  // channel is busy and chat did not react" are completely different facts,
  // and the second one is an upper bound on what any chat-only method can
  // ever recall.
  let belowFloor = 0, noSpike = 0;

  for (const ch of recordedChannels(CHAT_DIR)) {
    const span = recordedSpan(CHAT_DIR, ch);
    if (!span) continue;
    const { messages } = readRange(CHAT_DIR, ch, span.startMs, span.endMs);
    if (messages.length < 200) continue;

    const events = clusterPresses(
      loadClips(ch).map(c => locateClip(c, videos[c.videoId])).filter(Boolean),
    );

    for (const e of events) {
      const from = e.atMs - BEFORE_SEC * 1000;
      const to = e.atMs + AFTER_SEC * 1000;
      // Only events fully inside the recorded span can be measured.
      if (from < span.startMs || to > Math.min(span.endMs, messages[messages.length - 1].t)) continue;
      considered++;

      const lo = messages.findIndex(m => m.t >= from);
      if (lo < 0) continue;
      const window = [];
      for (let i = lo; i < messages.length && messages[i].t < to; i++) window.push(messages[i]);

      const series = activitySeries(window, from, to);

      // The peak has to be a SPIKE, not just the busiest second in three
      // minutes. Taking the plain argmax measured whichever moment happened to
      // be liveliest nearby, related to this clip or not, and produced a
      // distribution 150 seconds wide from p10 to p90 -- noise wearing the
      // shape of an answer.
      //
      // So: a robust baseline from the whole window (median and MAD, as in
      // src/detector.mjs), and the peak must clear it by SPIKE_Z. Events with
      // no such spike are not evidence about reaction lag and are counted
      // separately rather than averaged in.
      const sorted = [...series].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const mad = [...series].map(v => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(series.length / 2)];
      const sigma = Math.max(1.4826 * mad, 1);

      // Search only where a reaction could plausibly be: chat cannot react
      // before the moment, and a press long after its own peak is someone
      // scrolling back, not reacting.
      const searchFrom = Math.max(0, Math.floor((BEFORE_SEC - SEARCH_BEFORE_SEC)));
      const searchTo = Math.min(series.length - 1, BEFORE_SEC + SEARCH_AFTER_SEC);

      let peakIdx = -1, peakVal = -Infinity;
      for (let i = searchFrom; i <= searchTo; i++) {
        if (series[i] > peakVal) { peakVal = series[i]; peakIdx = i; }
      }
      const z = (peakVal - med) / sigma;
      if (peakVal < MIN_PEAK_CHATTERS) { belowFloor++; tooQuiet++; continue; }
      if (z < SPIKE_Z) { noSpike++; tooQuiet++; continue; }

      const peakMs = from + peakIdx * 1000;

      const pressGap = (e.atMs - peakMs) / 1000;        // + means press after peak
      const startGap = (peakMs - e.momentMs) / 1000;    // LIGHTOR's c

      peakToPress.push(pressGap);
      clipStartToPeak.push(startGap);

      const bucket = Math.round(pressGap / 5) * 5;
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }
  }

  if (!peakToPress.length) {
    console.log(`no measurable events yet (${considered} in range, ${tooQuiet} too quiet).`);
    console.log('The recorder needs to cover a full stream before and after a clip.');
    return;
  }

  const measurable = peakToPress.length + noSpike;
  console.log(`${considered} clip events inside the recorded span`);
  console.log(`  ${belowFloor} on channels too quiet to measure (<${MIN_PEAK_CHATTERS} chatters at peak)`);
  console.log(`  ${noSpike} on busy channels with NO spike clearing z=${SPIKE_Z}`);
  console.log(`  ${peakToPress.length} with a measurable spike`);
  if (measurable) {
    console.log(`\n  of events on measurable channels, ${(peakToPress.length / measurable * 100).toFixed(0)}% had a chat spike.`);
    console.log('  that share is a ceiling on recall for any chat-only detector.');
  }
  console.log('');
  console.log('seconds:');
  show('chat peak -> press', quantiles(peakToPress));
  show('clip start -> chat peak', quantiles(clipStartToPeak));

  console.log('\npress relative to chat peak (negative = pressed before the peak):');
  for (const [bucket, count] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
    if (Math.abs(bucket) > 60) continue;
    console.log(`  ${String(bucket).padStart(4)}s ${'#'.repeat(Math.ceil(count / Math.max(1, peakToPress.length / 50)))} ${count}`);
  }

  const c = quantiles(clipStartToPeak).median;
  console.log(`\nmedian clip-start -> peak: ${c.toFixed(1)}s`);
  console.log(`  src/detector.mjs assumes  3.5s`);
  console.log(`  LIGHTOR measured          23-27s`);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
