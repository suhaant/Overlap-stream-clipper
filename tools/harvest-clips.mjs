#!/usr/bin/env node
/**
 * Harvest the labels: every clip viewers made on the recorded channels.
 *
 * Usage:
 *   node tools/harvest-clips.mjs --days 3
 *   node tools/harvest-clips.mjs --days 7 --window-hours 3
 *   node tools/harvest-clips.mjs --only stableronaldo
 *
 * Writes data/clips/<login>.jsonl, one clip per line, merged with whatever was
 * already there. Re-running is safe and is in fact the intended usage: a clip's
 * vod_offset is null for an indeterminate period after creation ("typically
 * minutes long" per the docs), and null forever once the VOD expires. So a clip
 * harvested too early has no usable label, and a later pass fills it in.
 *
 * Run it on a lag of at least a day, and again a few days later to catch the
 * offsets that had not been computed yet.
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { harvestClips } from '../src/twitch-endpoints.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CHANNELS = flag('channels', 'channels.json');
const OUT_DIR = flag('dir', 'data/clips');
const DAYS = Number(flag('days', 3));
const WINDOW_HOURS = Number(flag('window-hours', 6));
const only = flag('only');

function targets() {
  if (only) {
    return only.split(',').map(s => ({ login: s.trim().toLowerCase(), userId: null }));
  }
  if (!existsSync(CHANNELS)) {
    console.error(`${CHANNELS} not found. Run tools/discover-channels.mjs first.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(CHANNELS, 'utf8'));
  return (cfg.channels ?? []).filter(c => c.userId);
}

/** Clip ids already on disk, so a re-run appends only what is new. */
function existingIds(path) {
  if (!existsSync(path)) return new Map();
  const seen = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      // Keep the newest record for an id: a later harvest may have the
      // vod_offset that the first one was too early to see.
      if (!seen.has(rec.id) || rec.vodOffset !== null) seen.set(rec.id, rec);
    } catch { /* a torn final line from a killed process */ }
  }
  return seen;
}

async function main() {
  const chans = targets();
  if (!chans.length) { console.error('no channels with a resolved userId'); process.exit(1); }

  mkdirSync(OUT_DIR, { recursive: true });
  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);
  console.log(`harvesting ${chans.length} channels, ${from.toISOString()} .. ${to.toISOString()}`);

  let totalNew = 0;
  let totalNull = 0;

  for (const chan of chans) {
    const path = join(OUT_DIR, `${chan.login}.jsonl`);
    const known = existingIds(path);
    const lines = [];
    let fetched = 0;
    let filled = 0;

    for await (const batch of harvestClips({
      broadcasterId: chan.userId,
      from: from.toISOString(),
      to: to.toISOString(),
      windowHours: WINDOW_HOURS,
      onWindow: (w) => {
        if (w.atCap) {
          console.warn(`  ! ${chan.login} ${w.windowStart} hit the result cap; re-run with a smaller --window-hours`);
        }
      },
    })) {
      for (const clip of batch) {
        fetched++;
        const prior = known.get(clip.id);
        // Append when it is new, or when this pass has an offset the stored
        // copy lacked. Otherwise skip: nothing has changed.
        if (!prior) { lines.push(clip); }
        else if (prior.vodOffset === null && clip.vodOffset !== null) { lines.push(clip); filled++; }
      }
    }

    const withOffset = lines.filter(c => c.vodOffset !== null).length;
    totalNull += lines.length - withOffset;
    totalNew += lines.length;

    if (lines.length) {
      appendFileSync(path, lines.map(c => JSON.stringify(c)).join('\n') + '\n');
    }
    console.log(
      `  ${chan.login}: ${fetched} seen, ${lines.length} written ` +
      `(${withOffset} with an offset, ${filled} backfilled)`,
    );
  }

  console.log(`\n${totalNew} clip records written, ${totalNull} still awaiting a vod_offset`);
  if (totalNull) console.log('re-run in a day or two to pick those up');
}

main().catch(e => { console.error(e.message); process.exit(1); });
