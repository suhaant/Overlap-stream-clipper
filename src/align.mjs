/**
 * ALIGNMENT: turning clips into labelled moments on the chat timeline.
 *
 * Measured, not assumed. tools/verify-alignment.mjs checked 173 clips across
 * 12 VODs: clips pressed while the stream was live land in a three-second band
 * with a median of -5s against `vod.created_at + vod_offset`, and not one fell
 * before -30s. So the VOD timeline is real wall-clock, running about five
 * seconds behind the live edge the viewer was watching.
 */

/** Measured stream delay between the live edge and the VOD timeline. */
export const STREAM_DELAY_SEC = 5;

/** Clips pressed outside this gap were made by someone browsing an old VOD. */
export const LIVE_GAP = { minSec: -30, maxSec: 600 };

/**
 * Where a clip sits on the wall clock.
 *
 * Two different times matter and they are not the same:
 *
 *   momentMs   where the clip STARTS in the broadcast
 *   pressedMs  when a human actually hit the button
 *
 * `pressedMs` is the one worth predicting. The task is "would a viewer clip
 * this right now", and the press is the observable act. Using the clip's start
 * instead would require knowing where inside a thirty-second clip the event
 * actually was, which nobody records. Cutting backwards from the press is
 * already what preRollMs does in the live pipeline.
 */
export function locateClip(clip, video) {
  if (!video?.createdAt || clip.vodOffset === null || clip.vodOffset === undefined) return null;
  const vodStart = new Date(video.createdAt).getTime();
  const pressedMs = new Date(clip.createdAt).getTime();
  if (!Number.isFinite(vodStart) || !Number.isFinite(pressedMs)) return null;

  const momentMs = vodStart + clip.vodOffset * 1000 - STREAM_DELAY_SEC * 1000;
  const gapSec = (pressedMs - (vodStart + clip.vodOffset * 1000)) / 1000;

  return {
    id: clip.id,
    momentMs,
    pressedMs,
    gapSec,
    madeLive: gapSec > LIVE_GAP.minSec && gapSec < LIVE_GAP.maxSec,
    viewCount: clip.viewCount ?? 0,
    durationSec: clip.durationSec ?? null,
  };
}

/**
 * Group presses into events.
 *
 * When something happens, many people clip it within seconds of each other.
 * Left ungrouped those become a dozen positive labels a few seconds apart,
 * which both inflates the apparent number of moments and lets a model score
 * twelve hits for finding one thing.
 *
 * Grouping also produces the weight that matters: a moment twenty people
 * clipped is a stronger example than one that a single person clipped, and the
 * view counts say whether anyone watched the result.
 *
 * `windowSec` is 45 rather than something tighter because the press lag itself
 * is spread out -- people take their time reaching for the button.
 */
export function clusterPresses(located, { windowSec = 45 } = {}) {
  const live = located.filter(Boolean).filter(c => c.madeLive).sort((a, b) => a.pressedMs - b.pressedMs);
  const events = [];

  for (const clip of live) {
    const last = events[events.length - 1];
    if (last && clip.pressedMs - last.lastPressMs <= windowSec * 1000) {
      last.presses++;
      last.lastPressMs = clip.pressedMs;
      last.totalViews += clip.viewCount;
      last.clipIds.push(clip.id);
      // The earliest press is the best estimate of when the moment landed;
      // later ones are people reacting to the reaction.
      last.momentMs = Math.min(last.momentMs, clip.momentMs);
    } else {
      events.push({
        atMs: clip.pressedMs,
        momentMs: clip.momentMs,
        lastPressMs: clip.pressedMs,
        presses: 1,
        totalViews: clip.viewCount,
        clipIds: [clip.id],
      });
    }
  }

  return events.map(e => ({
    atMs: e.atMs,
    momentMs: e.momentMs,
    presses: e.presses,
    totalViews: e.totalViews,
    maxViews: e.totalViews,
    clipIds: e.clipIds,
    spanSec: (e.lastPressMs - e.atMs) / 1000,
  }));
}

/**
 * Is second `t` within tolerance of a labelled event?
 *
 * Tolerance exists because a detection a few seconds early still cuts the
 * right clip once pre-roll is applied, so demanding the exact second would
 * measure clock alignment rather than detection.
 */
export function isHit(tMs, events, { toleranceSec = 3 } = {}) {
  const tol = toleranceSec * 1000;
  return events.some(e => Math.abs(e.atMs - tMs) <= tol);
}

/** The event a detection matches, or null. Used for precision@k scoring. */
export function matchEvent(tMs, events, { toleranceSec = 3 } = {}) {
  const tol = toleranceSec * 1000;
  let best = null;
  for (const e of events) {
    const d = Math.abs(e.atMs - tMs);
    if (d <= tol && (!best || d < Math.abs(best.atMs - tMs))) best = e;
  }
  return best;
}
