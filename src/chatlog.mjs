import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hourKey } from './recorder.mjs';

/**
 * Read back what src/recorder.mjs wrote.
 *
 * On-disk records are deliberately terse ({t,u,x,e,s}) because they are written
 * tens of times a second; everything downstream wants the same shape the live
 * chat client emits, so the translation happens here, once.
 */

/** Terse disk record -> the shape src/shape.mjs and src/detector.mjs expect. */
export function expand(rec) {
  return {
    t: rec.t,
    user: rec.u,
    text: rec.x,
    emoteCount: rec.e ?? 0,
    sub: rec.s === 1,
  };
}

/** Every UTC hour key touched by [startMs, endMs], inclusive. */
export function hourKeysBetween(startMs, endMs) {
  const keys = [];
  const HOUR = 3600_000;
  // Floor to the hour so a range starting mid-hour still reads that hour's file.
  for (let t = Math.floor(startMs / HOUR) * HOUR; t <= endMs; t += HOUR) {
    keys.push(hourKey(t));
  }
  return keys;
}

/**
 * Messages and audit records for one channel over a time range.
 *
 * Audit records come back separately rather than being dropped. A window that
 * contains a `reconnecting` is a window where we were not listening, and
 * treating that as "chat went quiet" would teach a model that silence predicts
 * nothing when in fact we simply missed it. The dataset builder uses this to
 * exclude affected windows instead of quietly training on holes.
 */
export function readRange(dir, channel, startMs, endMs) {
  const messages = [];
  const audits = [];
  const missingHours = [];

  for (const key of hourKeysBetween(startMs, endMs)) {
    const path = join(dir, channel, `${key}.jsonl`);
    if (!existsSync(path)) { missingHours.push(key); continue; }

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      // A process killed mid-write leaves a torn final line. Skip it rather
      // than failing the whole hour.
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec.t !== 'number' || rec.t < startMs || rec.t > endMs) continue;
      if (rec._) audits.push(rec);
      else if (typeof rec.x === 'string') messages.push(expand(rec));
    }
  }

  // Twitch's tmi-sent-ts is the ordering authority, but records arrive in
  // arrival order and can cross an hour boundary out of sequence.
  messages.sort((a, b) => a.t - b.t);
  return { messages, audits, missingHours };
}

/** Did we lose the connection anywhere in this range? */
export function hasGap(audits) {
  return audits.some(a => a._ === 'reconnecting' || a._ === 'error' || a._ === 'close');
}

/** Channels with at least one recorded hour. */
export function recordedChannels(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => readdirSync(join(dir, name)).some(f => f.endsWith('.jsonl')))
    .sort();
}

/** The span of time a channel has recorded data for, or null. */
export function recordedSpan(dir, channel) {
  const chanDir = join(dir, channel);
  if (!existsSync(chanDir)) return null;
  const files = readdirSync(chanDir).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) return null;

  const first = parseHourKey(files[0].replace('.jsonl', ''));
  const last = parseHourKey(files[files.length - 1].replace('.jsonl', ''));
  if (first === null || last === null) return null;
  return { startMs: first, endMs: last + 3600_000, hours: files.length };
}

/** 20261125-14 -> epoch ms of that hour's start. */
export function parseHourKey(key) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const [, y, mo, d, h] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h);
}
