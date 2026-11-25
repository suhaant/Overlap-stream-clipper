#!/usr/bin/env node
/**
 * Score every baseline on the labelled dataset.
 *
 *   node tools/evaluate.mjs
 *   node tools/evaluate.mjs --per-hour 6
 *
 * Held out by channel. The trained baseline is fitted leave-one-channel-out,
 * so the channel it is scored on never appears in its training data. With a
 * roster this small that is both the most data-efficient split and the most
 * obviously honest one.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { evaluate, bootstrapCI } from '../src/eval.mjs';
import { BASELINES, makeLightor } from '../src/baselines.mjs';
import { loadVideos, eventsFor } from '../src/clipstore.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DATASET = flag('dataset', 'data/dataset.jsonl');
const CLIP_DIR = flag('clips', 'data/clips');
const PER_HOUR = Number(flag('per-hour', 6));
/**
 * How many people must independently clip a moment for it to count.
 *
 * 58% of clustered events are a single press with a median of 2 views: one
 * person saving a URL, not a moment. Scoring against those makes the task
 * both unmeasurable and wrong. Unmeasurable because event density drives the
 * chance rate -- at 25 events an hour against a 50s acceptance window, a third
 * of the timeline counts as correct and a constant scorer reaches 0.27. Wrong
 * because the product question is which moments are worth posting, and a clip
 * two people watched is not one.
 *
 * Three independent presses is the smallest number that means "the crowd
 * agreed", and it keeps 26% of events.
 */
const MIN_PRESSES = Number(flag('min-presses', 3));
const OUT = flag('out', 'data/results.json');

if (!existsSync(DATASET)) {
  console.error(`${DATASET} not found. Run: npm run build-dataset`);
  process.exit(1);
}

const rows = readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const videos = loadVideos();

// Group rows by channel, and attach that channel's events and recorded hours.
const byChannel = {};
for (const r of rows) {
  (byChannel[r.ch] ??= { rows: [], events: [], hours: 0 }).rows.push(r);
}
for (const [ch, g] of Object.entries(byChannel)) {
  const times = g.rows.map(r => r.t);
  g.hours = (Math.max(...times) - Math.min(...times)) / 3_600_000;
  const span = { from: Math.min(...times), to: Math.max(...times) };
  // Only events inside the window we actually have features for can be hit.
  g.allEvents = eventsFor(CLIP_DIR, ch, videos)
    .filter(e => e.atMs >= span.from && e.atMs <= span.to);
  g.events = g.allEvents.filter(e => e.presses >= MIN_PRESSES);
}

// A channel with no events in range cannot distinguish any scorer.
const usable = Object.fromEntries(
  Object.entries(byChannel).filter(([, g]) => g.events.length > 0 && g.rows.length > 30),
);
const channels = Object.keys(usable);

console.log(`${rows.length.toLocaleString()} windows, ${channels.length} channels with events in range`);
console.log(`events require >=${MIN_PRESSES} independent presses\n`);
for (const ch of channels) {
  const g = usable[ch];
  console.log(`  ${ch.padEnd(20)} ${String(g.rows.length).padStart(6)} windows  ${String(g.events.length).padStart(4)}/${String(g.allEvents.length).padStart(4)} events  ${g.hours.toFixed(1)}h`);
}

/**
 * The chance rate, stated so the table is readable.
 *
 * Any detection landing inside an event's acceptance window counts, so the
 * share of the timeline those windows cover is what a scorer with no
 * information achieves. A result near this number means nothing, however
 * respectable it looks on its own.
 */
const chance = (() => {
  let covered = 0, total = 0;
  for (const g of Object.values(usable)) {
    covered += g.events.length * 50;
    total += g.hours * 3600;
  }
  return total ? Math.min(covered / total, 1) : 0;
})();
console.log(`\nchance rate (share of timeline inside an acceptance window): ${(chance * 100).toFixed(1)}%`);
if (!channels.length) { console.error('\nnothing to evaluate yet.'); process.exit(1); }

/** Leave-one-channel-out: fit on every other channel, score on this one. */
function evaluateTrained(makeScorer) {
  const perChannel = [];
  for (const ch of channels) {
    const train = channels.filter(c => c !== ch).flatMap(c => usable[c].rows);
    if (train.length < 100 || !train.some(r => r.label === 1)) continue;
    const scorer = makeScorer(train);
    const one = evaluate({ [ch]: usable[ch] }, scorer, { perHour: PER_HOUR });
    perChannel.push(...one.perChannel);
  }
  const mean = (k) => perChannel.length ? perChannel.reduce((s, r) => s + r[k], 0) / perChannel.length : 0;
  return {
    perChannel, channels: perChannel.length,
    precision: mean('precision'), recall: mean('recall'), weightedRecall: mean('weightedRecall'),
  };
}

const results = {};
for (const [name, fn] of Object.entries(BASELINES)) {
  results[name] = evaluate(usable, fn, { perHour: PER_HOUR });
}
results.lightor = evaluateTrained(makeLightor);

const order = ['constant', 'velocity', 'chatterVelocity', 'convergenceOnly', 'lightor', 'currentHeuristic'];

console.log(`\nprecision@${PER_HOUR}/hour, held out by channel, mean over channels`);
console.log(`anything near ${(chance * 100).toFixed(0)}% is chance\n`);
console.log('scorer'.padEnd(20) + 'precision'.padStart(11) + '95% CI'.padStart(18) + 'recall'.padStart(9) + 'wRecall'.padStart(9));
for (const name of order) {
  const r = results[name];
  if (!r) continue;
  const ci = bootstrapCI(r.perChannel);
  const ciText = Number.isNaN(ci.lo) ? '  n/a' : `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`;
  console.log(
    name.padEnd(20) +
    r.precision.toFixed(3).padStart(11) +
    ciText.padStart(18) +
    r.recall.toFixed(3).padStart(9) +
    r.weightedRecall.toFixed(3).padStart(9),
  );
}

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  windows: rows.length, channels, perHour: PER_HOUR,
  results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    precision: v.precision, recall: v.recall, weightedRecall: v.weightedRecall,
    channels: v.channels, ci: bootstrapCI(v.perChannel),
  }])),
}, null, 2) + '\n');
console.log(`\n-> ${OUT}`);
