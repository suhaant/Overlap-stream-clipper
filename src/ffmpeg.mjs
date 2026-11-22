import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve which ffmpeg to use.
 *
 * Homebrew's core `ffmpeg` 9.x is a slim build: no fontconfig, freetype, harfbuzz
 * or libass, so it has neither `drawtext` nor `subtitles` and cannot burn in a
 * caption. `ffmpeg-full` carries all four but is keg-only, so it is deliberately
 * NOT on PATH. We therefore look for a capable build rather than trusting `ffmpeg`.
 */
const CANDIDATES = [
  process.env.FFMPEG,
  '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
  '/opt/homebrew/opt/ffmpeg@7/bin/ffmpeg',
  '/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg',
  '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
  '/usr/local/opt/ffmpeg@7/bin/ffmpeg',
  'ffmpeg',
].filter(Boolean);

function probe(bin) {
  try {
    const filters = execFileSync(bin, ['-hide_banner', '-filters'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const has = (f) => new RegExp(`\\b${f}\\b`).test(filters);
    return { bin, drawtext: has('drawtext'), subtitles: has('subtitles'), gblur: has('gblur') };
  } catch {
    return null;
  }
}

let cached;
export function ffmpegInfo() {
  if (cached) return cached;
  const found = [];
  for (const c of CANDIDATES) {
    if (c.includes('/') && !existsSync(c)) continue;
    const p = probe(c);
    if (p) found.push(p);
  }
  if (!found.length) throw new Error('no usable ffmpeg found');
  // Prefer a build that can render text; fall back to the first that works.
  cached = found.find(f => f.drawtext) || found[0];
  return cached;
}

export const ffmpegBin = () => ffmpegInfo().bin;
export const canBurnText = () => ffmpegInfo().drawtext;

/** Fonts we can hand to drawtext. Arial Bold reads well at small sizes on video. */
export function pickFont() {
  for (const f of [
    process.env.CAPTION_FONT,
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ]) if (f && existsSync(f)) return f;
  return null;
}
