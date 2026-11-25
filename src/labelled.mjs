/**
 * Turning the raw dataset into channels with events and training labels.
 *
 * Shared by tools/evaluate.mjs and tools/train.mjs. The reason is the same one
 * that put the row builder in src/windowrow.mjs: if the model is fit against
 * one definition of "clip-worthy" and scored against another, both tools pass
 * their tests and the reported number is about a different question than the
 * shipped model answers. Keeping the definition in one place makes that
 * mistake impossible rather than unlikely.
 */

import { eventsFor, qualifyEvents, windowBlocks } from './clipstore.mjs';
import { matchEvent } from './align.mjs';

export const DEFAULTS = {
  topPerHour: 6,
  minPresses: 0,
  toleranceSec: 3,
  minRows: 30,
};

/**
 * Group rows by channel, attach qualified events, and set `y` on every row.
 *
 * `label` on the raw row means "somebody pressed clip here", which is the
 * right thing to have stored -- it bakes no threshold into the data. `y` is
 * the question actually being asked: was this one of the block's best moments.
 *
 * Returns { byChannel, usable, channels }, where `usable` drops channels with
 * no events in range, since they cannot distinguish one scorer from another.
 */
export function labelChannels(rows, { clipDir, videos, ...opts } = {}) {
  const { topPerHour, minPresses, toleranceSec, minRows } = { ...DEFAULTS, ...opts };

  const byChannel = {};
  for (const r of rows) {
    (byChannel[r.ch] ??= { rows: [], events: [], hours: 0 }).rows.push(r);
  }

  for (const [ch, g] of Object.entries(byChannel)) {
    const times = g.rows.map(r => r.t);
    const from = Math.min(...times), to = Math.max(...times);
    g.hours = (to - from) / 3_600_000;

    // Only events inside the window we have features for can ever be hit.
    g.allEvents = eventsFor(clipDir, ch, videos).filter(e => e.atMs >= from && e.atMs <= to);

    // One block per hour's worth of pickable windows, so each block gets the
    // same quota of events as the metric gives it picks.
    const perBlock = Math.max(1, Math.round(g.rows.length / Math.max(g.hours, 1)));
    g.events = qualifyEvents(g.allEvents, {
      minPresses,
      topPerHour,
      blocks: topPerHour > 0 ? windowBlocks(times, perBlock) : null,
    });

    for (const r of g.rows) {
      r.y = matchEvent(r.t, g.events, { toleranceSec }) ? 1 : 0;
    }
  }

  const usable = Object.fromEntries(
    Object.entries(byChannel).filter(([, g]) => g.events.length > 0 && g.rows.length > minRows),
  );

  return { byChannel, usable, channels: Object.keys(usable) };
}
