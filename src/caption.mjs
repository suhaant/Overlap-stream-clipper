import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Burned-in captions for the 9:16 clip.
 *
 * THE LETTERBOX IS THE FEATURE. Reframing 16:9 into 9:16 leaves blurred bands above
 * and below the video -- about 40% of the frame doing nothing. We put the chat
 * reaction there. That is not a workaround for wasted space: showing chat losing it
 * IS the native format for gaming clips, and it is the one overlay this detector can
 * produce honestly, because the chat reaction is literally the evidence that made
 * the clip. Every other tool has to guess at a caption; we already have the crowd's.
 *
 * Text is passed via `textfile=` rather than `text=` so arbitrary chat content
 * cannot break out of ffmpeg's filter syntax -- chat is full of colons, quotes,
 * backslashes and commas, all of which are filter delimiters.
 */

/** Arial has no emoji coverage, and a missing glyph renders as a tofu box. */
const stripUnrenderable = (s) => s
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/[\u0000-\u001F\u007F\u{E0000}-\u{E007F}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Pick the chat lines that best show the reaction.
 * Deduplicate, because 80 people typing "KEKW" should occupy one line, not eighty --
 * but keep the count, because the count is the point.
 */
export function chatHighlights(window, max = 4) {
  const counts = new Map();
  for (const m of window) {
    const t = stripUnrenderable(m.text || '');
    if (!t || t.length > 42) continue;
    const key = t.toLowerCase();
    const prev = counts.get(key);
    if (prev) prev.n++;
    else counts.set(key, { text: t, n: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.text.length - b.text.length)
    .slice(0, max)
    .map(h => (h.n > 1 ? `${h.text}  x${h.n}` : h.text));
}

/**
 * Build drawtext filters for the top hook and the bottom chat strip.
 * `videoHeight` is the height of the centred 16:9 frame inside the 9:16 canvas.
 */
export function captionFilters({
  hook, chatLines = [], tmpDir, font,
  width = 1080, height = 1920, videoHeight = 608,
}) {
  mkdirSync(tmpDir, { recursive: true });
  const filters = [];
  let i = 0;

  const topBandBottom = (height - videoHeight) / 2;
  const bottomBandTop = topBandBottom + videoHeight;

  const draw = (text, { y, size, color = 'white', box = true }) => {
    // A non-finite y silently renders the text off-frame rather than failing, which
    // is how a NaN from a bad probe once produced a clip with no captions at all.
    if (!Number.isFinite(y)) throw new Error(`caption y is not finite: ${y}`);
    const file = join(tmpDir, `cap${i++}.txt`);
    writeFileSync(file, text, 'utf8');
    const opts = [
      `fontfile='${font}'`,
      `textfile='${file}'`,
      `fontsize=${size}`,
      `fontcolor=${color}`,
      `x=(w-text_w)/2`,
      `y=${Math.round(y)}`,
      `shadowcolor=black@0.85`, `shadowx=3`, `shadowy=3`,
    ];
    if (box) opts.push(`box=1`, `boxcolor=black@0.45`, `boxborderw=18`);
    filters.push(`drawtext=${opts.join(':')}`);
  };

  if (hook) {
    draw(clamp(stripUnrenderable(hook).toUpperCase(), 26), {
      y: topBandBottom - 150, size: 74,
    });
  }

  if (chatLines.length) {
    draw('CHAT', { y: bottomBandTop + 60, size: 40, color: '#b39cff' });
    let y = bottomBandTop + 140;
    for (const line of chatLines.slice(0, 4)) {
      draw(clamp(line, 34), { y, size: 52 });
      y += 96;
    }
  }

  return filters;
}
