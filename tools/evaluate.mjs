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
import { evaluate, bootstrapCI, DEFAULT_MATCH } from '../src/eval.mjs';
import { BASELINES, makeLightor, makeRandom } from '../src/baselines.mjs';
import { makeLogreg, weightReport, FEATURE_SETS } from '../src/model.mjs';
import { loadVideos } from '../src/clipstore.mjs';
import { labelChannels } from '../src/labelled.mjs';

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
const MIN_PRESSES = Number(flag('min-presses', 0));
/**
 * Default: the top 6 moments of each channel-hour, which is the same question
 * precision@6/hour asks. See qualifyEvents in src/clipstore.mjs for why an
 * absolute press bar was biased toward the busiest hours, and what that was
 * worth to a scorer that only knew the clock.
 *
 * Pass --top-per-hour 0 --min-presses 3 to get the old, biased definition back
 * for comparison.
 */
const TOP_PER_HOUR = Number(flag('top-per-hour', 6));
const OUT = flag('out', 'data/results.json');
/** Matches the dataset builder's own tolerance, so a window means the same thing. */
const LABEL_TOLERANCE = Number(flag('tolerance', 3));

if (!existsSync(DATASET)) {
  console.error(`${DATASET} not found. Run: npm run build-dataset`);
  process.exit(1);
}

const rows = readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const videos = loadVideos();

const { usable, channels } = labelChannels(rows, {
  clipDir: CLIP_DIR,
  videos,
  topPerHour: TOP_PER_HOUR,
  minPresses: MIN_PRESSES,
  toleranceSec: LABEL_TOLERANCE,
});

console.log(`${rows.length.toLocaleString()} windows, ${channels.length} channels with events in range`);
console.log(TOP_PER_HOUR > 0
  ? `events are the top ${TOP_PER_HOUR} moments of each channel-hour by press count\n`
  : `events require >=${MIN_PRESSES} independent presses\n`);
for (const ch of channels) {
  const g = usable[ch];
  console.log(`  ${ch.padEnd(20)} ${String(g.rows.length).padStart(6)} windows  ${String(g.events.length).padStart(4)}/${String(g.allEvents.length).padStart(4)} events  ${g.hours.toFixed(1)}h`);
}

/**
 * The chance rate, stated so the table is readable.
 *
 * A scorer can only pick a window that exists, and windows exist only where
 * there was chat. Measuring event coverage against wall-clock hours therefore
 * understates chance badly on any channel that goes quiet: the first version of
 * this printed 2.5% while a constant scorer reached 7.3%, which made every
 * baseline look three times better than nothing when none of them were.
 *
 * So: the share of pickable windows falling inside some event's acceptance
 * window, averaged over channels like every other number in the table. That is
 * what one uninformed pick is worth.
 */
const chance = (() => {
  const { maxLeadSec, graceSec } = DEFAULT_MATCH;
  const per = [];
  for (const g of Object.values(usable)) {
    if (!g.rows.length || !g.events.length) continue;
    let inside = 0;
    for (const r of g.rows) {
      const hit = g.events.some(e => {
        const lead = (e.atMs - r.t) / 1000;
        return lead <= maxLeadSec && lead >= -graceSec;
      });
      if (hit) inside++;
    }
    per.push(inside / g.rows.length);
  }
  return per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0;
})();
console.log(`\nchance rate (share of pickable windows inside an acceptance window): ${(chance * 100).toFixed(1)}%`);
if (!channels.length) { console.error('\nnothing to evaluate yet.'); process.exit(1); }

/** Leave-one-channel-out: fit on every other channel, score on this one. */
function evaluateTrained(makeScorer) {
  const perChannel = [];
  for (const ch of channels) {
    const train = channels.filter(c => c !== ch).flatMap(c => usable[c].rows);
    if (train.length < 100 || !train.some(r => r.y === 1)) continue;
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
results.logreg = evaluateTrained(makeLogreg);

// The ablation: the same model, the same folds, different inputs.
results.logregRate = evaluateTrained(
  rows => makeLogreg(rows, { features: FEATURE_SETS.rate() }));
results.logregShares = evaluateTrained(
  rows => makeLogreg(rows, { features: FEATURE_SETS.shares() }));
results.logregRateConv = evaluateTrained(
  rows => makeLogreg(rows, { features: FEATURE_SETS.rateAndConvergence() }));

/**
 * The measured floor: the same harness, run on noise, averaged over seeds.
 *
 * Averaged per channel first, so the bootstrap CI below is still over channels
 * -- the thing that varies in the claim -- and not over seeds, which is a
 * number we chose.
 */
const RANDOM_SEEDS = 20;
results.random = (() => {
  const acc = new Map();
  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
    const run = evaluate(usable, makeRandom(seed), { perHour: PER_HOUR });
    for (const r of run.perChannel) {
      const a = acc.get(r.channel)
        ?? { channel: r.channel, precision: 0, recall: 0, weightedRecall: 0, n: 0 };
      a.precision += r.precision;
      a.recall += r.recall;
      a.weightedRecall += r.weightedRecall;
      a.n++;
      acc.set(r.channel, a);
    }
  }
  const perChannel = [...acc.values()].map(a => ({
    channel: a.channel,
    precision: a.precision / a.n,
    recall: a.recall / a.n,
    weightedRecall: a.weightedRecall / a.n,
  }));
  const mean = (k) => perChannel.length
    ? perChannel.reduce((s, r) => s + r[k], 0) / perChannel.length : 0;
  return {
    perChannel, channels: perChannel.length,
    precision: mean('precision'), recall: mean('recall'), weightedRecall: mean('weightedRecall'),
  };
})();

const order = ['random', 'constant', 'velocity', 'chatterVelocity', 'convergenceOnly', 'lightor', 'currentHeuristic', 'logregRate', 'logregShares', 'logregRateConv', 'logreg'];

console.log(`\nprecision@${PER_HOUR}/hour, held out by channel, mean over channels`);
console.log(`anything near ${(chance * 100).toFixed(0)}% is chance\n`);
console.log(`"random" is the floor; "constant" picks the earliest windows, so it`);
console.log(`is the position baseline. Beating both is the bar.\n`);
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
    // Kept so the spread behind the mean is inspectable: 14 channels is few
    // enough that one of them can carry a headline number on its own.
    perChannel: v.perChannel.map(c => ({
      channel: c.channel, precision: c.precision, recall: c.recall, events: c.events,
    })),
  }])),
}, null, 2) + '\n');
console.log(`\n-> ${OUT}`);
