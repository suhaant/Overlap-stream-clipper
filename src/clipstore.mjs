import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { locateClip, clusterPresses } from './align.mjs';

/**
 * Reading harvested clips back into labelled events.
 *
 * Shared by the dataset builder and the evaluator so the two cannot disagree
 * about what an event is -- the same reason src/lexicon.mjs and
 * src/features.mjs are shared.
 */

/** Harvested clips for one channel, newest record per id. */
export function loadClips(dir, channel) {
  const path = join(dir, `${channel}.jsonl`);
  if (!existsSync(path)) return [];
  const out = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      const prior = out.get(c.id);
      // A later harvest may carry the offset an earlier one was too early for.
      if (!prior || (prior.vodOffset === null && c.vodOffset !== null)) out.set(c.id, c);
    } catch { /* torn final line from a killed process */ }
  }
  return [...out.values()];
}

export function loadVideos(path = 'data/videos.json') {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

/** Clustered clip events for one channel. */
export function eventsFor(dir, channel, videos) {
  return clusterPresses(
    loadClips(dir, channel)
      .map(c => locateClip(c, videos[c.videoId]))
      .filter(Boolean),
  );
}

/**
 * Decide which clustered moments count as events.
 *
 * An absolute press threshold sounds neutral and is not. Clip presses scale
 * with concurrent viewers, chat volume scales sublinearly with them (big chats
 * have more lurkers, and slow mode and rate limits bite), so a fixed bar of
 * three presses is far easier to clear in a channel's busiest hour than its
 * quietest. Measured on 2026-11-25: the hour the recorder joined carried 2.2x
 * the qualifying events per window of the hour after it, on only 20% more
 * chat. Events bunched into 38% of the first fifth of each recorded span, and
 * a scorer that does nothing but pick the earliest windows beat noise twice
 * over -- 0.073 against 0.037 -- without knowing anything about chat.
 *
 * `topPerHour` fixes it by asking the question the metric already asks. The
 * metric is precision@6/hour: give me this hour's best moments. So the labels
 * should be this hour's best moments -- the top N by press count within each
 * channel-hour -- not every moment that cleared a bar set by audience size.
 * Event density then becomes uniform in time by construction, and position
 * stops being worth anything.
 *
 * `floorPresses` stops it manufacturing events in a dead hour: a moment two
 * people cared about is thin, and one person is not a crowd at all.
 */
export function qualifyEvents(events, { minPresses = 0, topPerHour = 0, floorPresses = 2, blocks = null } = {}) {
  let out = events;

  if (minPresses > 0) {
    out = out.filter(e => (e.presses ?? 1) >= minPresses);
  }

  if (topPerHour > 0) {
    // Bucket by block if the caller supplied boundaries, otherwise by clock
    // hour. Clock hours are the wrong bucket at the edges of a recording: the
    // hour the recorder joins is a partial one, and giving 35 minutes a full
    // hour's quota inflates its event density by half again. Blocks of equal
    // pickable time have no edges to get wrong.
    const bucketOf = blocks
      ? (t) => { let i = 0; while (i < blocks.length && t >= blocks[i]) i++; return i; }
      : (t) => Math.floor(t / 3_600_000);

    const groups = new Map();
    for (const e of out) {
      if ((e.presses ?? 1) < floorPresses) continue;
      const key = bucketOf(e.atMs);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    out = [];
    for (const group of groups.values()) {
      group.sort((a, b) =>
        (b.presses ?? 1) - (a.presses ?? 1) ||
        (b.totalViews ?? 0) - (a.totalViews ?? 0) ||
        a.atMs - b.atMs);                 // deterministic on ties
      out.push(...group.slice(0, topPerHour));
    }
    out.sort((a, b) => a.atMs - b.atMs);
  }

  return out;
}

/**
 * Split a channel's pickable timeline into blocks of equal window count.
 *
 * Returns the timestamps where each block ends, so a block is an equal slice
 * of time a scorer could actually have picked in -- not an equal slice of the
 * wall clock, which a quiet stretch would make meaningless.
 */
export function windowBlocks(times, perBlock) {
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  for (let i = perBlock; i < sorted.length; i += perBlock) out.push(sorted[i]);
  return out;
}
