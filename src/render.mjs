import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ffmpegBin, canBurnText, pickFont } from './ffmpeg.mjs';
import { captionFilters } from './caption.mjs';

const ffprobeBin = () => ffmpegBin().replace(/ffmpeg$/, 'ffprobe');

/** Source pixel dimensions, so we know how tall the scaled frame will be. */
export function probeDimensions(input) {
  const out = execFileSync(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', input,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // A concatenated .ts can carry several program entries, so ffprobe prints one
  // CSV line per match. Take the first, or the lines splice together and yield NaN.
  const [w, h] = out.trim().split('\n')[0].split(',').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(`unparseable ffprobe dimensions: ${JSON.stringify(out.slice(0, 80))}`);
  }
  return { width: w, height: h };
}

const even = (n) => Math.round(n / 2) * 2;

/**
 * LAYOUT, derived by hand.
 *
 * These numbers are not guesses. One clip was edited by hand in Edits against a
 * reference clip that actually went viral, and these are what looked right when it
 * did:
 *
 *   videoScale   1.63  -- video is 163% of canvas WIDTH, so it overflows and crops
 *                         the sides. At 1.0 the frame is letterboxed and most of
 *                         the canvas is wasted blur. This was the single biggest
 *                         visual error in the earlier version.
 *   videoOffsetY 0.125 -- pushed down an eighth of the canvas, clearing a band at
 *                         the top for the headline rather than overlapping it.
 *
 * Cropping the sides does cost the far-left HUD, which is the trade for filling the
 * frame; a facecam in a bottom corner usually survives, but not always. Per-channel
 * override is the right answer and is why these are parameters.
 */
export const LAYOUT = { videoScale: 1.63, videoOffsetY: 0.125, cropAnchorX: 0.5, blurSigma: 28 };

export function renderClip({
  input, startSec, durationSec, out,
  hook, chatLines = [],
  width = 1080, height = 1920,
  videoScale = LAYOUT.videoScale,
  videoOffsetY = LAYOUT.videoOffsetY,
  cropAnchorX = LAYOUT.cropAnchorX,
  blurSigma = LAYOUT.blurSigma,
  fps, crf = 20, tmpDir,
}) {
  mkdirSync(dirname(out), { recursive: true });

  let aspect = 9 / 16;
  try {
    const src = probeDimensions(input);
    aspect = src.height / src.width;
  } catch { /* assume 16:9 */ }

  const scaledW = even(width * videoScale);
  const scaledH = even(scaledW * aspect);
  // Scaling past the canvas width means the sides get cropped, and WHICH side is
  // a per-channel decision: a facecam in a bottom corner is the most valuable pixels
  // in a reaction clip, and a centred crop throws it away. 0 keeps the left edge,
  // 1 the right, 0.5 centres. stableronaldo's cam is bottom-left, so that channel
  // wants a low anchor.
  const overlayX = Math.round((width - scaledW) * Math.min(Math.max(cropAnchorX, 0), 1));
  const overlayY = Math.round((height - scaledH) / 2 + height * videoOffsetY);
  const videoTop = overlayY;
  const videoBottom = overlayY + scaledH;

  const chain = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=${blurSigma}[bgb]`,
    `[fg]scale=${scaledW}:${scaledH}[fgs]`,
  ];
  let last = `[bgb][fgs]overlay=${overlayX}:${overlayY}`;

  const font = pickFont();
  const warnings = [];
  let captioned = false;

  if ((hook || chatLines.length) && canBurnText() && font) {
    const caps = captionFilters({
      hook, chatLines, font, width, height, videoTop, videoBottom,
      tmpDir: tmpDir || `${dirname(out)}/.captions`,
    });
    warnings.push(...caps.warnings);
    if (caps.filters.length) { last += ',' + caps.filters.join(','); captioned = true; }
  } else if (hook && !canBurnText()) {
    warnings.push('ffmpeg has no drawtext; captions skipped');
  }

  chain.push(`${last},format=yuv420p[v]`);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // -ss before -i seeks by keyframe and is far faster on a long source; on a
    // live manifest it also avoids pulling segments we would only discard.
    '-ss', String(startSec),
    '-i', input,
    '-t', String(durationSec),
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
    '-map', '0:a?',              // gameplay sources sometimes have no audio
    ...(fps ? ['-r', String(fps)] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    out,
  ];

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin(), args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0
      ? resolve({ out, width, height, durationSec, captioned, warnings,
                  layout: { scaledW, scaledH, overlayX, overlayY, videoTop, videoBottom } })
      : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 700)}`)));
  });
}

/** Turn a detected spike into the render arguments for its clip. */
export function clipPlanFor(spike, { streamStartedAt, input, outDir = 'clips' }) {
  const startSec = Math.max(0, (spike.clipStartAt - streamStartedAt) / 1000);
  return {
    input,
    startSec: Number(startSec.toFixed(2)),
    durationSec: Number((spike.durationMs / 1000).toFixed(2)),
    out: `${outDir}/${spike.id}.mp4`,
  };
}
