#!/usr/bin/env node
/**
 * Verify that a clip's vod_offset can be mapped to wall-clock time.
 *
 *   node tools/verify-alignment.mjs --hours 8 --channels 8
 *
 * Everything downstream rests on one assumption the Twitch docs never state:
 * that a VOD's `created_at` is the moment the stream started, so that
 *
 *     moment_wall_clock = vod.created_at + clip.vod_offset
 *
 * The docs define vod_offset as "the zero-based offset, in seconds, to where
 * the clip starts in the video (VOD)" and define created_at as "when the video
 * was created", which is not the same claim. If created_at were the time the
 * VOD *record* was written, or the time the stream ended, every label in the
 * dataset would be aligned to the wrong second and nothing downstream would
 * work. That is worth half an hour to check rather than discovering it later.
 *
 * The test: for clips made while the stream was live, the moment computed from
 * the VOD timeline should land within seconds of when the clip was created.
 * A wrong assumption gives noise. A right one gives a tight band.
 */

import { loadEnv } from '../src/env.mjs';
import { readFile } from 'node:fs/promises';
import { getClips, getVideoById } from '../src/twitch-endpoints.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const HOURS = Number(flag('hours', 8));
const N_CHANNELS = Number(flag('channels', 8));

/** Clips made long after the stream are someone browsing an old VOD. */
export const LIVE_WINDOW = { minSec: -30, maxSec: 600 };

/**
 * The live-made clips cluster a few seconds BELOW zero, meaning the VOD
 * timeline runs slightly behind the live edge the viewer was watching when
 * they pressed the button. That is ordinary stream delay, and because it is
 * systematic rather than random it can simply be subtracted.
 */
export function summarise(gaps) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const live = sorted.filter(g => g > LIVE_WINDOW.minSec && g < LIVE_WINDOW.maxSec);
  const liveMedian = live.length ? live[Math.floor(live.length / 2)] : null;
  return {
    n: sorted.length,
    liveCount: live.length,
    liveShare: sorted.length ? live.length / sorted.length : 0,
    liveMedian,
    p10: q(0.1), median: q(0.5), p90: q(0.9),
    // The assumption is wrong if clips routinely appear to have been made
    // before the moment they point at. A handful of seconds is stream delay;
    // minutes would mean the timeline does not line up at all.
    impossible: sorted.filter(g => g < LIVE_WINDOW.minSec).length,
  };
}

async function main() {
  const cfg = JSON.parse(await readFile('channels.json', 'utf8'));
  const chans = cfg.channels.filter(c => c.userId).slice(0, N_CHANNELS);
  const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
  const now = new Date().toISOString();

  const videos = new Map();
  const gaps = [];
  let noOffset = 0;

  for (const c of chans) {
    const clips = await getClips({
      broadcasterId: c.userId, startedAt: since, endedAt: now, maxPages: 1,
    });
    for (const clip of clips) {
      if (clip.vodOffset === null || !clip.videoId) { noOffset++; continue; }
      if (!videos.has(clip.videoId)) {
        videos.set(clip.videoId, await getVideoById(clip.videoId).catch(() => null));
      }
      const v = videos.get(clip.videoId);
      if (!v) continue;
      const moment = new Date(v.createdAt).getTime() + clip.vodOffset * 1000;
      gaps.push((new Date(clip.createdAt).getTime() - moment) / 1000);
    }
  }

  if (!gaps.length) { console.log('no clips with an offset in this window'); return; }

  const s = summarise(gaps);
  console.log(`${s.n} clips across ${videos.size} VODs, ${chans.length} channels, last ${HOURS}h`);
  console.log(`${noOffset} clips had no vod_offset yet\n`);
  console.log('clip.created_at minus (vod.created_at + vod_offset), seconds:');
  console.log(`  p10 ${s.p10.toFixed(1)}   median ${s.median.toFixed(1)}   p90 ${s.p90.toFixed(1)}`);
  console.log(`  made live (${LIVE_WINDOW.minSec}s..${LIVE_WINDOW.maxSec}s): ${s.liveCount} (${(s.liveShare * 100).toFixed(0)}%), median ${s.liveMedian?.toFixed(1)}s`);
  console.log(`  impossible (before ${LIVE_WINDOW.minSec}s): ${s.impossible}`);

  console.log('');
  if (s.impossible === 0 && s.liveMedian !== null && Math.abs(s.liveMedian) < 30) {
    console.log('PASS. created_at is the stream start, and the offset maps to wall clock.');
    console.log(`Apply a constant correction of ${(-s.liveMedian).toFixed(0)}s for stream delay.`);
  } else {
    console.log('FAIL. The mapping does not hold; do not build the dataset on it.');
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
