#!/usr/bin/env node
/**
 * Fetch the intervals each recorded channel was actually broadcasting.
 *
 * The recorder stays joined to a channel whether or not the stream is up, so
 * roughly three quarters of recorded seconds are offline chat: people talking
 * in an empty room. Nobody clips an offline channel, so every one of those
 * seconds is a window a scorer may pick and can never be right about. That
 * dilutes the chance rate and, worse, hands a free win to any scorer biased
 * toward the start of the recording, because the start is where the stream
 * was up.
 *
 * Ground truth is the channel's archive VODs: a VOD exists for each broadcast,
 * `created_at` is when it started and `duration` how long it ran. This is
 * strictly better than the VODs reachable from harvested clips, which only
 * cover broadcasts somebody happened to clip.
 *
 * Usage:
 *   node tools/fetch-live-windows.mjs
 *   node tools/fetch-live-windows.mjs --days 7
 *
 * Writes data/live-windows.json: { login: [{ lo, hi, vodId }] }, epoch ms.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../src/env.mjs';
import { getVideos, resolveChannels } from '../src/twitch-endpoints.mjs';
import { recordedChannels, recordedSpan } from '../src/chatlog.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CHAT_DIR = flag('dir', 'data/chat');
const OUT = flag('out', 'data/live-windows.json');
const DAYS = Number(flag('days', 7));

const channels = recordedChannels(CHAT_DIR);
if (!channels.length) {
  console.error(`no recorded channels under ${CHAT_DIR}`);
  process.exit(1);
}

// Only VODs that could overlap what we recorded are worth keeping.
const since = Date.now() - DAYS * 86_400_000;

// resolveChannels returns a Map of login -> user id.
const byLogin = await resolveChannels(channels);

const out = {};
let totalWindows = 0;

for (const login of channels) {
  const userId = byLogin.get(login);
  if (!userId) {
    console.log(`  ${login}: no such user, skipped`);
    continue;
  }

  const vods = await getVideos({ userId });
  const windows = vods
    .map(v => {
      const lo = Date.parse(v.createdAt);
      // A VOD still being written has no duration yet. Freezing it at
      // Date.now() looks harmless and silently throws away every second
      // recorded after this fetch: the window ends, later chat falls outside
      // it, and the dataset builder drops it as offline without a word. Null
      // means "still going", and the consumer treats it as open-ended.
      const sec = v.durationSec ?? null;
      return { lo, hi: sec == null ? null : lo + sec * 1000, ongoing: sec == null, vodId: v.id };
    })
    .filter(w => Number.isFinite(w.lo) && (w.hi === null || w.hi > since))
    .sort((a, b) => a.lo - b.lo);

  out[login] = windows;
  totalWindows += windows.length;

  const span = recordedSpan(CHAT_DIR, login);
  const overlap = span
    ? windows.reduce((s, w) =>
        s + Math.max(0, Math.min(w.hi ?? Infinity, span.endMs) - Math.max(w.lo, span.startMs)), 0)
    : 0;
  const recorded = span ? span.endMs - span.startMs : 0;
  console.log(
    `  ${login.padEnd(18)} ${String(windows.length).padStart(2)} broadcasts, ` +
    `${(overlap / 3.6e6).toFixed(1)}h of ${(recorded / 3.6e6).toFixed(1)}h recorded was live`,
  );
}

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`\n${totalWindows} broadcast windows across ${Object.keys(out).length} channels`);
console.log(`-> ${OUT}`);
