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
