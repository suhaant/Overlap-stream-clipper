#!/usr/bin/env node
/**
 * Score a live run against the clip button.
 *
 *   npm run check-fires exports/live-compare-<channel>-<stamp>.json
 *
 * tools/compare-live.mjs records what each detector fired on. This says
 * whether anyone agreed. It is the only honest way to talk about a live run:
 * a clip looks good or bad depending on who is watching it, and at 0.165
 * precision a single sampled fire is far more likely to be a dud than not.
 *
 * Written after showing Suhaan the first clip the model cut live. He said it
 * was not a clip-worthy moment; the clip button showed zero presses in that
 * whole half hour, so he was right and the sample was uninformative anyway.
 *
 * Labels lag. vod_offset is null for minutes after a clip is made and the
 * press itself trails the moment, so a run checked immediately will undercount
 * hits. Re-run it the next day before believing a low number.
 */
import { loadEnv } from '../src/env.mjs';
loadEnv();
import { readFileSync } from 'node:fs';
import { resolveChannels, getClips, getVideos } from '../src/twitch-endpoints.mjs';
import { locateClip, clusterPresses } from '../src/align.mjs';

/** A fire counts as a hit if a press event lands within this of its peak. */
const TOLERANCE_MS = 15_000;
/** Padding around the run, so a press that trails the window still matches. */
const PAD_BEFORE_MS = 10 * 60_000;
const PAD_AFTER_MS = 60 * 60_000;

const path = process.argv[2];
if (!path) { console.error('usage: node tools/check-fires.mjs <live-compare-*.json>'); process.exit(1); }
const run = JSON.parse(readFileSync(path, 'utf8'));

const userId = (await resolveChannels([run.channel])).get(run.channel);
if (!userId) { console.error(`cannot resolve ${run.channel}`); process.exit(1); }

const clips = await getClips({
  broadcasterId: userId,
  startedAt: new Date(run.startedAt - PAD_BEFORE_MS).toISOString(),
  endedAt: new Date(run.endedAt + PAD_AFTER_MS).toISOString(),
});
const videos = await getVideos({ userId, first: 10, maxPages: 1 });
const byVideo = new Map(videos.map(v => [v.id, v]));

const located = [];
let unplaced = 0;
for (const c of clips) {
  const v = byVideo.get(c.videoId);
  const L = v && locateClip(c, { createdAt: v.createdAt ?? v.created_at });
  if (L) located.push(L); else unplaced++;
}
const events = clusterPresses(located)
  .filter(e => e.atMs >= run.startedAt && e.atMs <= run.endedAt);

const rel = (t) => {
  const s = Math.max(0, Math.round((t - run.startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

console.log(`${run.channel}, ${(run.hours * 60).toFixed(0)} minutes, ${run.messages} messages`);
console.log(`${clips.length} clips in the padded window, ${unplaced} not placeable on a VOD yet`);
console.log(`${events.length} press events inside the run itself` +
  (events.length ? ` (${(events.length / run.hours).toFixed(2)}/hour)` : '') + '\n');

if (unplaced) {
  console.log(`!! ${unplaced} clips have no vod_offset yet. Re-run tomorrow before`);
  console.log(`   trusting a low hit count.\n`);
}

const bySource = new Map();
for (const f of run.fires) {
  if (!bySource.has(f.source)) bySource.set(f.source, []);
  bySource.get(f.source).push(f);
}

const claimed = new Set();
for (const [source, fires] of bySource) {
  let hits = 0;
  const lines = [];
  for (const f of fires.sort((a, b) => a.peakAt - b.peakAt)) {
    let best = null;
    for (const e of events) {
      const gap = Math.abs(e.atMs - f.peakAt);
      if (gap <= TOLERANCE_MS && (!best || gap < best.gap)) best = { gap, e };
    }
    if (best) { hits++; claimed.add(best.e); }
    lines.push(`  [${f.rel}] ${best ? `HIT  ${best.e.presses}p ${best.e.totalViews}v, ${(best.gap / 1000).toFixed(1)}s off` : 'miss'}` +
      `   ${(f.lines?.[0] ?? '').slice(0, 34)}`);
  }
  const p = fires.length ? hits / fires.length : 0;
  console.log(`${source}: ${hits}/${fires.length} hit, precision ${p.toFixed(3)}, ` +
    `${(fires.length / run.hours).toFixed(2)} fires/hour`);
  for (const l of lines) console.log(l);
  const recall = events.length ? hits / events.length : 0;
  console.log(`  caught ${hits} of ${events.length} real moments (recall ${recall.toFixed(3)})\n`);
}

const missed = events.filter(e => !claimed.has(e));
if (missed.length) {
  console.log(`${missed.length} real moments nothing fired on:`);
  for (const e of missed.sort((a, b) => b.presses - a.presses)) {
    console.log(`  [${rel(e.atMs)}] ${e.presses} press${e.presses > 1 ? 'es' : ''}, ${e.totalViews} views`);
  }
}
