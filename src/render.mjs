import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ffmpegBin, canBurnText, pickFont } from './ffmpeg.mjs';
import { captionFilters } from './caption.mjs';

const ffprobeBin = () => ffmpegBin().replace(/ffmpeg$/, 'ffprobe');

/** Source pixel dimensions, so we know how tall the centred frame will be. */
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

/**
 * Cut a detected window out of a source and reframe it 9:16 for short-form.
 *
 * The reframe is "letterbox on blur": the original 16:9 frame sits full-width and
 * centred over a blurred, zoomed copy of itself. For gameplay this beats a centre
 * crop, because a crop throws away the minimap, the weapon wheel and the wanted
 * stars -- the HUD lives at the frame edges, and that HUD is often what the moment
 * is about. Overlap's `Convert to Vertical` node exposes the same choice through
 * its `style` and `gaussian_blur` settings.
 *
 * `input` may be a local file OR an HLS manifest URL, so the same stage serves a
 * recorded VOD and a live stream unchanged.
 */
export function renderClip({
  input, startSec, durationSec, out,
  hook, chatLines = [],
  width = 1080, height = 1920, blurSigma = 28, crf = 20, tmpDir,
}) {
  mkdirSync(dirname(out), { recursive: true });

  const chain = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=${blurSigma}[bgb]`,
    `[fg]scale=${width}:-2[fgs]`,
  ];

  let last = `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`;

  const font = pickFont();
  const wantsText = Boolean(hook || chatLines.length);
  let captioned = false;

  if (wantsText && canBurnText() && font) {
    // Height of the centred frame once scaled to full canvas width. The fallback
    // assumes a 16:9 source: 1080 wide -> 608 tall, NOT height*9/16.
    let videoHeight = Math.round((width * 9) / 16 / 2) * 2;
    try {
      const src = probeDimensions(input);
      videoHeight = Math.round((width * src.height) / src.width / 2) * 2;
    } catch { /* keep the 16:9 assumption */ }
    if (!Number.isFinite(videoHeight) || videoHeight <= 0 || videoHeight > height) {
      videoHeight = Math.round((width * 9) / 16 / 2) * 2;
    }

    const caps = captionFilters({
      hook, chatLines, font, width, height, videoHeight,
      tmpDir: tmpDir || `${dirname(out)}/.captions`,
    });
    if (caps.length) { last += ',' + caps.join(','); captioned = true; }
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
    '-map', '0:a?',            // gameplay sources sometimes have no audio track
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',  // playable before it finishes downloading
    out,
  ];

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin(), args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0
      ? resolve({ out, width, height, durationSec, captioned })
      : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 700)}`)));
  });
}

/** Turn a detected spike into the render arguments for its clip. */
export function clipPlanFor(spike, { streamStartedAt, input, outDir = 'clips' }) {
  // Spike timestamps are wall-clock; ffmpeg wants an offset into the source.
  const startSec = Math.max(0, (spike.clipStartAt - streamStartedAt) / 1000);
  return {
    input,
    startSec: Number(startSec.toFixed(2)),
    durationSec: Number((spike.durationMs / 1000).toFixed(2)),
    out: `${outDir}/${spike.id}.mp4`,
  };
}
