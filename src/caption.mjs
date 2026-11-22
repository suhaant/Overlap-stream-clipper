import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tokens, normalize, isReactionish, isScreaming, isEmojiOnly } from './lexicon.mjs';

/**
 * Burned-in captions.
 *
 * The geometry here was derived by hand-editing one clip in Edits against a
 * reference viral clip, then measuring what actually looked right. Three numbers
 * came out of that and are now the defaults in render.mjs: video scaled to 163% of
 * canvas width, pushed down 12.5% of canvas height, headline in the band above it.
 * Letterboxing at native scale -- what this did before -- wastes the frame.
 */

/** Arial has no emoji coverage, and a missing glyph renders as a tofu box. */
const stripUnrenderable = (s) => s
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/[\u0000-\u001F\u007F\u{E0000}-\u{E007F}]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Rough advance width of Arial Bold as a fraction of point size. */
const CHAR_W = 0.56;

/**
 * Wrap a headline into lines, and shrink the font until the longest line fits.
 *
 * THE LONG-WORD RULE. drawtext does not wrap, so we wrap here -- but the real trap
 * is a single word wider than the canvas. The first headline tried in Edits was
 * "stableronaldo's chat LOST IT during GTA 6", which broke as "STABLERONA /
 * LDO'S CHAT" because the handle alone is 14 characters. Reference clips get away
 * with this only because "N3on" is short. So a word that cannot fit on its own
 * line is the failure case, and the headline must be rewritten rather than
 * squeezed -- callers get told, instead of silently shipping a broken frame.
 */
export function layoutHeadline(text, { maxWidth, maxSize = 92, minSize = 48, maxLines = 3 }) {
  const words = stripUnrenderable(text).toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const longest = Math.max(...words.map(w => w.length));
  const sizeForLongestWord = maxWidth / (longest * CHAR_W);
  if (sizeForLongestWord < minSize) {
    return {
      error: `headline word too long to render: "${words.find(w => w.length === longest)}" ` +
             `(${longest} chars needs ${Math.round(sizeForLongestWord)}pt, floor is ${minSize}pt)`,
    };
  }

  // Largest size at which the text still wraps into maxLines.
  for (let size = Math.min(maxSize, sizeForLongestWord); size >= minSize; size -= 2) {
    const perLine = Math.floor(maxWidth / (size * CHAR_W));
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length <= perLine) cur = next;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return { lines, size: Math.round(size) };
  }
  return { error: 'headline too long for the available band' };
}

/**
 * Pick the chat lines that best show the reaction. Deduplicate, because 80 people
 * typing "KEKW" should be one line -- but keep the count, because the count is the
 * point.
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
 * Build drawtext filters. `videoTop`/`videoBottom` are the y bounds of the video
 * pane inside the canvas; the headline goes in the band above, chat in the band
 * below, and each is skipped when its band is too short to hold it.
 */
export function captionFilters({
  hook, chatLines = [], tmpDir, font,
  width = 1080, height = 1920, videoTop, videoBottom,
}) {
  mkdirSync(tmpDir, { recursive: true });
  const filters = [];
  const warnings = [];
  let i = 0;

  const draw = (text, { y, size, color = 'white', boxAlpha = 0.5 }) => {
    if (!Number.isFinite(y)) throw new Error(`caption y is not finite: ${y}`);
    const file = join(tmpDir, `cap${i++}.txt`);
    writeFileSync(file, text, 'utf8');
    filters.push('drawtext=' + [
      `fontfile='${font}'`,
      `textfile='${file}'`,
      `fontsize=${Math.round(size)}`,
      `fontcolor=${color}`,
      `x=(w-text_w)/2`,
      `y=${Math.round(y)}`,
      `shadowcolor=black@0.9`, `shadowx=4`, `shadowy=4`,
      `box=1`, `boxcolor=black@${boxAlpha}`, `boxborderw=20`,
    ].join(':'));
  };

  const pad = 60;
  const usable = width - pad * 2;

  if (hook) {
    const laid = layoutHeadline(hook, { maxWidth: usable });
    if (laid?.error) {
      warnings.push(laid.error);
    } else if (laid) {
      const lineH = laid.size * 1.22;
      const blockH = laid.lines.length * lineH;
      // Sit the block in the band above the video, biased toward the video.
      let y = Math.max(40, videoTop - blockH - 50);
      if (y + blockH > videoTop) y = Math.max(20, videoTop - blockH - 10);
      for (const line of laid.lines) { draw(line, { y, size: laid.size }); y += lineH; }
    }
  }

  const bottomBand = height - videoBottom;
  if (chatLines.length && bottomBand > 150) {
    const size = 46;
    const lineH = size * 1.5;
    const fit = Math.max(0, Math.min(chatLines.length, Math.floor((bottomBand - 40) / lineH)));
    let y = videoBottom + 30;
    for (const line of chatLines.slice(0, fit)) {
      draw(clamp(line, 30), { y, size, boxAlpha: 0.55 });
      y += lineH;
    }
    if (fit < chatLines.length) warnings.push(`only ${fit}/${chatLines.length} chat lines fit`);
  }

  return { filters, warnings };
}

/** The handful of messages that best explain why this fired. */
export function evidence(window, limit = 5) {
  return window
    .filter(m => (m.text && isReactionish(m.text)) || isScreaming(m.text || ''))
    .slice(0, limit)
    .map(m => ({ login: m.login, text: m.text }));
}
