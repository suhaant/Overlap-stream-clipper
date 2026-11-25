#!/usr/bin/env node
/**
 * Join recorded chat to harvested clips and emit a labelled feature table.
 *
 *   node tools/build-dataset.mjs
 *   node tools/build-dataset.mjs --step 1000 --out data/dataset.jsonl
 *
 * One line per scored window: the channel, the time, the label, and the
 * features at three timescales. Run tools/record-all.mjs and
 * tools/harvest-clips.mjs first; this reads only what they wrote, plus the
 * VOD metadata it needs to place a clip on the clock.
 */

import { loadEnv } from '../src/env.mjs';
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readRange, recordedChannels, recordedSpan } from '../src/chatlog.mjs';
import { windowFeatures } from '../src/features.mjs';
import { locateClip, clusterPresses, matchEvent } from '../src/align.mjs';
import { getVideoById } from '../src/twitch-endpoints.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const CHAT_DIR = flag('chat', 'data/chat');
const CLIP_DIR = flag('clips', 'data/clips');
const OUT = flag('out', 'data/dataset.jsonl');
const STEP_MS = Number(flag('step', 1000));
const TOLERANCE = Number(flag('tolerance', 3));
/** Multi-scale: the model needs the shape over time, not one instant. */
const SCALES = [4000, 10000, 30000];
const MIN_MESSAGES = Number(flag('min-messages', 5));

const VIDEO_CACHE = 'data/videos.json';
const LIVE_WINDOWS = flag('live-windows', 'data/live-windows.json');

function loadClips(channel) {
  const path = join(CLIP_DIR, `${channel}.jsonl`);
  if (!existsSync(path)) return [];
  const out = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      // A later harvest may have backfilled the offset; keep the better record.
      const prior = out.get(c.id);
      if (!prior || (prior.vodOffset === null && c.vodOffset !== null)) out.set(c.id, c);
    } catch { /* torn line */ }
  }
  return [...out.values()];
}

/** VOD metadata, cached on disk: the same VOD backs hundreds of clips. */
async function videoLookup(ids) {
  const cache = existsSync(VIDEO_CACHE) ? JSON.parse(readFileSync(VIDEO_CACHE, 'utf8')) : {};
  let fetched = 0;
  for (const id of ids) {
    if (cache[id] !== undefined) continue;
    cache[id] = await getVideoById(id).catch(() => null);
    fetched++;
  }
  if (fetched) {
    mkdirSync('data', { recursive: true });
    writeFileSync(VIDEO_CACHE, JSON.stringify(cache));
  }
  return { cache, fetched };
}

/** First index with t >= target, over a time-sorted array. */
function lowerBound(msgs, target) {
  let lo = 0, hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msgs[mid].t < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const channels = recordedChannels(CHAT_DIR);
  if (!channels.length) { console.error(`no recorded chat in ${CHAT_DIR}`); process.exit(1); }

  // Resolve every VOD referenced by any clip, in one pass, before scoring.
  const allClips = new Map();
  const videoIds = new Set();
  for (const ch of channels) {
    const clips = loadClips(ch);
    allClips.set(ch, clips);
    for (const c of clips) if (c.videoId && c.vodOffset !== null) videoIds.add(c.videoId);
  }
  const { cache: videos, fetched } = await videoLookup(videoIds);
  console.log(`${videoIds.size} VODs referenced (${fetched} newly fetched)\n`);

  rmSync(OUT, { force: true });
  mkdirSync('data', { recursive: true });

  /**
 * Broadcast intervals per channel, from tools/fetch-live-windows.mjs.
 *
 * The recorder stays joined whether or not the stream is up, and nobody clips
 * an offline channel, so an offline window is one a scorer may pick and can
 * never be right about. Gating them out is the difference between a timeline
 * and a timeline of things that could have happened.
 *
 * A channel absent from the file -- or present with no broadcasts, which is
 * what a channel with VODs disabled looks like -- is left ungated rather than
 * dropped. cohhcarnage publishes no archives and is one of the best-labelled
 * channels we have; silently deleting it would be worse than not gating it.
 */
const liveWindows = existsSync(LIVE_WINDOWS)
  ? JSON.parse(readFileSync(LIVE_WINDOWS, 'utf8'))
  : {};
if (!Object.keys(liveWindows).length) {
  console.log(`${LIVE_WINDOWS} not found -- windows will not be gated to broadcast time.`);
  console.log('Run: node tools/fetch-live-windows.mjs\n');
}

let totalRows = 0, totalPos = 0, totalEvents = 0, skippedGap = 0, skippedOffline = 0;
  const perChannel = [];

  for (const ch of channels) {
    const span = recordedSpan(CHAT_DIR, ch);
    if (!span) continue;

    const { messages, audits } = readRange(CHAT_DIR, ch, span.startMs, span.endMs);
    if (messages.length < 50) { perChannel.push({ ch, rows: 0, pos: 0, events: 0, note: 'too little chat' }); continue; }

    const located = allClips.get(ch).map(c => locateClip(c, videos[c.videoId])).filter(Boolean);
    const events = clusterPresses(located);
    totalEvents += events.length;

    // Windows overlapping a disconnect are dropped: we were not listening, so
    // quiet there means nothing and a label inside it has no features behind it.
    const gapTimes = audits.filter(a => a._ !== 'open').map(a => a.t);

    // Broadcast intervals for this channel, or null to leave it ungated.
    const live = liveWindows[ch]?.length ? liveWindows[ch] : null;
    const isLive = (t) => !live || live.some(w => t >= w.lo && t <= w.hi);

    const from = Math.max(span.startMs, messages[0].t);
    const to = Math.min(span.endMs, messages[messages.length - 1].t);
    const lines = [];
    let rows = 0, pos = 0;

    for (let t = from + Math.max(...SCALES); t <= to; t += STEP_MS) {
      if (gapTimes.some(g => Math.abs(g - t) < 60_000)) { skippedGap++; continue; }
      if (!isLive(t)) { skippedOffline++; continue; }

      const row = { ch, t };
      let enough = false;
      for (const scale of SCALES) {
        const lo = lowerBound(messages, t - scale);
        const hi = lowerBound(messages, t);
        const w = messages.slice(lo, hi);
        if (scale === SCALES[0] && w.length >= MIN_MESSAGES) enough = true;
        const f = windowFeatures(w, { windowMs: scale });
        const tag = `w${scale / 1000}`;
        for (const [k, v] of Object.entries(f)) row[`${tag}_${k}`] = Number(v.toFixed(4));
      }
      if (!enough) continue;

      const hit = matchEvent(t, events, { toleranceSec: TOLERANCE });
      row.label = hit ? 1 : 0;
      row.presses = hit ? hit.presses : 0;
      row.views = hit ? hit.totalViews : 0;
      if (hit) pos++;
      rows++;
      lines.push(JSON.stringify(row));
      if (lines.length >= 5000) { appendFileSync(OUT, lines.join('\n') + '\n'); lines.length = 0; }
    }
    if (lines.length) appendFileSync(OUT, lines.join('\n') + '\n');

    totalRows += rows; totalPos += pos;
    perChannel.push({ ch, rows, pos, events: events.length, hours: span.hours });
  }

  console.log('channel'.padEnd(20) + 'windows'.padStart(9) + 'positive'.padStart(10) + 'events'.padStart(8));
  for (const r of perChannel.sort((a, b) => b.pos - a.pos)) {
    console.log(r.ch.padEnd(20) + String(r.rows).padStart(9) + String(r.pos).padStart(10) + String(r.events ?? 0).padStart(8) + (r.note ? '  ' + r.note : ''));
  }
  console.log(`\n${totalRows.toLocaleString()} windows, ${totalPos.toLocaleString()} positive (${(totalPos / Math.max(totalRows, 1) * 100).toFixed(2)}%), ${totalEvents} clip events`);
  console.log(`${skippedGap.toLocaleString()} windows dropped for overlapping a disconnect`);
  console.log(`${skippedOffline.toLocaleString()} windows dropped for falling outside broadcast time`);
  console.log(`-> ${OUT}`);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
