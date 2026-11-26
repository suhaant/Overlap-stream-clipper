#!/usr/bin/env node
/**
 * The benchmark as a checkable artifact, with no chat text in it.
 *
 *   npm run export-benchmark
 *
 * A result nobody can check is a claim, not a result. But the thing that
 * would let someone check this one -- the chat -- is other people's messages,
 * and republishing those is not mine to do. docs/DATA.md sets the rule: the
 * recorder keeps a salted hash and never a login, and the salt never travels
 * with the hashes.
 *
 * So this exports what a reviewer needs and nothing more: for every scored
 * window, its time, its features and its label. Someone can refit any model
 * they like, reproduce the leave-one-channel-out splits, and check the table
 * in docs/RESULTS.md. They cannot reconstruct a single chat message from it,
 * and they cannot tell who said anything, because no identifier -- not even a
 * hashed one -- is written here.
 *
 * Channels are named, because which channels they were is part of the claim.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { labelChannels } from '../src/labelled.mjs';
import { loadVideos } from '../src/clipstore.mjs';
import { MODEL_FEATURES, modelFeatures } from '../src/model.mjs';
import { SCALES, MIN_MESSAGES } from '../src/windowrow.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DATASET = flag('dataset', 'data/dataset.jsonl');
const TOP_PER_HOUR = Number(flag('top-per-hour', 6));
const OUT = flag('out', `exports/benchmark-${new Date().toISOString().slice(0, 10)}.json`);

const rows = readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const { byChannel } = labelChannels(rows, {
  clipDir: 'data/clips', videos: loadVideos(), topPerHour: TOP_PER_HOUR,
});

const channels = [];
let windows = 0, positives = 0;
for (const [ch, g] of Object.entries(byChannel)) {
  if (!g.rows.length) continue;
  // Times are relative to the channel's first window. Absolute timestamps
  // would let someone line a window up against a VOD and pull the chat back
  // out of Twitch, which is the thing this export exists to avoid.
  const t0 = g.rows[0].t;
  const out = g.rows.map((r) => {
    const f = modelFeatures(r);
    return { dt: Math.round((r.t - t0) / 1000), y: r.y ?? 0, x: MODEL_FEATURES.map(k => Number(f[k].toFixed(4))) };
  });
  windows += out.length;
  positives += out.filter(r => r.y === 1).length;
  channels.push({
    channel: ch,
    hours: Number(g.hours.toFixed(2)),
    events: g.events.length,
    windows: out.length,
    rows: out,
  });
}

mkdirSync('exports', { recursive: true });
writeFileSync(OUT, JSON.stringify({
  about: 'Chat-only clip-moment benchmark. Features and labels only; no chat text, no user identifiers, no absolute timestamps.',
  generatedAt: new Date().toISOString(),
  labelling: TOP_PER_HOUR > 0
    ? `a moment is one of the top ${TOP_PER_HOUR} clip-press events per block of equal pickable time`
    : 'a moment is any clustered clip-press event',
  tolerance: 'a window counts as a hit within 3s of the press-derived moment',
  validation: 'leave-one-channel-out; never score a channel with a model fitted on it',
  rowSpec: { scales: SCALES, minMessages: MIN_MESSAGES, features: MODEL_FEATURES },
  featureNames: MODEL_FEATURES,
  schema: { dt: 'seconds since this channel\'s first window', y: 'label', x: 'features, in featureNames order' },
  totals: { channels: channels.length, windows, positives },
  channels,
}) + '\n');

console.log(`${channels.length} channels, ${windows.toLocaleString()} windows, ${positives} positive`);
console.log(`features: ${MODEL_FEATURES.length}, no chat text, no identifiers, no absolute times`);
console.log(`-> ${OUT}`);
