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
