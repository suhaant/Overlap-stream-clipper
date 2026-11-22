/**
 * The three Helix endpoints this project reads, on top of the transport in
 * src/twitch-api.mjs.
 */

import { helix, collect } from './twitch-api.mjs';

/** Resolve channel logins (the name in the URL) to broadcaster ids. */
export async function getUsers(logins, opts = {}) {
  const names = (Array.isArray(logins) ? logins : [logins]).map(s => s.toLowerCase());
  if (!names.length) return [];
  const out = [];
  // Get Users takes at most 100 logins per request.
  for (let i = 0; i < names.length; i += 100) {
    const json = await helix('users', { login: names.slice(i, i + 100) }, opts);
    out.push(...(json.data ?? []));
  }
  return out;
}

/** login -> id, for the channel list. Missing or banned logins are absent. */
export async function resolveChannels(logins, opts = {}) {
  const users = await getUsers(logins, opts);
  return new Map(users.map(u => [u.login, u.id]));
}

/**
 * Parse Helix's duration string into seconds.
 *
 * Get Videos returns duration as text, not a number: the docs give "3m21s" and
 * "1h0m5s" as examples and say "leading zero units left out", so every unit is
 * optional and the string cannot be split on a fixed shape.
 *
 * Returns null rather than NaN for anything unparseable, so a caller has to
 * decide what to do about it instead of silently propagating NaN into a
 * timestamp. That exact bug cost an afternoon in src/render.mjs.
 */
export function parseDuration(text) {
  if (typeof text !== 'string') return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  // The regex matches the empty string, which is not a duration.
  if (!m || !m[0]) return null;
  const [, h, min, s] = m;
  if (h === undefined && min === undefined && s === undefined) return null;
  return Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

/**
 * A channel's past broadcasts, newest first.
 *
 * `type: 'archive'` is the automatic VOD of a live stream, which is the only
 * kind a clip's vod_offset can point into. Highlights and uploads are excluded.
 */
export async function getVideos({ userId, first = 100, maxPages = 5 }, opts = {}) {
  const rows = await collect('videos', {
    user_id: userId, type: 'archive', first,
  }, { maxPages, ...opts });

  return rows.map(v => ({
    id: v.id,
    streamId: v.stream_id ?? null,
    title: v.title,
    createdAt: v.created_at,
    publishedAt: v.published_at ?? null,
    durationText: v.duration,
    durationSec: parseDuration(v.duration),
    url: v.url,
    viewCount: v.view_count,
  }));
}

/** One VOD by id, or null. Used to resolve a clip's video_id. */
export async function getVideoById(videoId, opts = {}) {
  const json = await helix('videos', { id: videoId }, opts);
  const v = json.data?.[0];
  if (!v) return null;
  return {
    id: v.id,
    streamId: v.stream_id ?? null,
    createdAt: v.created_at,
    durationText: v.duration,
    durationSec: parseDuration(v.duration),
  };
}

/** Normalise a Helix clip row to the fields this project uses. */
export function normaliseClip(c) {
  return {
    id: c.id,
    broadcasterId: c.broadcaster_id,
    broadcasterName: c.broadcaster_name,
    creatorId: c.creator_id,
    videoId: c.video_id || null,      // docs: empty string when unavailable
    // Seconds into the VOD where the clip starts. Null while Twitch is still
    // computing it ("typically minutes long" after creation) and null forever
    // if the VOD is gone. The label is useless without it.
    vodOffset: Number.isFinite(c.vod_offset) ? c.vod_offset : null,
    createdAt: c.created_at,
    durationSec: c.duration,
    viewCount: c.view_count,
    gameId: c.game_id || null,
    language: c.language,
    title: c.title,
    url: c.url,
    isFeatured: Boolean(c.is_featured),
  };
}

/**
 * Clips for one channel in one time window.
 *
 * Two API facts shape this. Results come back sorted by view count descending,
 * not chronologically, so a truncated page is a loss of the *least* viewed
 * clips rather than of a time range. And total results cap at roughly 1,000
 * across all pagination, which is why the caller windows by time instead of
 * paging further.
 */
export async function getClips({
  broadcasterId, startedAt, endedAt, first = 100, maxPages = 10,
}, opts = {}) {
  const rows = await collect('clips', {
    broadcaster_id: broadcasterId,
    started_at: startedAt,
    ended_at: endedAt,
    first,
  }, { maxPages, ...opts });
  return rows.map(normaliseClip);
}

const HOUR_MS = 3600_000;

/**
 * Walk a long date range in windows, so the ~1,000-result cap applies per
 * window rather than to the whole harvest.
 *
 * Six hours is the default because it is about one streaming session: a busy
 * channel can produce hundreds of clips in a session but not thousands, so the
 * cap stays out of reach while the number of requests stays small.
 *
 * Yields one window's clips at a time, deduplicated by id across windows: the
 * API truncates start and end times to the minute, so adjacent windows can
 * return the same clip twice.
 */
export async function* harvestClips({
  broadcasterId, from, to, windowHours = 6, onWindow = () => {},
}, opts = {}) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`harvestClips: unparseable range ${from} .. ${to}`);
  }
  if (start >= end) return;

  const seen = new Set();
  const step = Math.max(1, windowHours) * HOUR_MS;

  for (let t = start; t < end; t += step) {
    const windowStart = new Date(t).toISOString();
    const windowEnd = new Date(Math.min(t + step, end)).toISOString();
    const clips = await getClips({
      broadcasterId, startedAt: windowStart, endedAt: windowEnd,
    }, opts);

    const fresh = clips.filter(c => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);

    onWindow({ windowStart, windowEnd, returned: clips.length, fresh: fresh.length });
    // A window that comes back at the cap means clips were lost; the caller
    // should narrow windowHours and re-run.
    if (clips.length >= 1000) {
      onWindow({ windowStart, windowEnd, atCap: true });
    }
    if (fresh.length) yield fresh;
  }
}
