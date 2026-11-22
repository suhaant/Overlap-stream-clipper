import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Cut a detected window out of a source and reframe it 9:16 for short-form.
 *
 * The reframe is "letterbox on blur": the original 16:9 frame sits full-width and
 * centred over a blurred, zoomed copy of itself. For gameplay this beats a centre
 * crop, because a crop throws away the minimap, the weapon wheel and the wanted
 * stars -- the HUD lives at the frame edges, and that HUD is often what the moment
 * is about. Overlap's own `Convert to Vertical` node exposes the same choice via
 * its `style` and `gaussian_blur` settings; this is the equivalent of their
 * blurred-background style rather than the aggressive crop.
 *
 * `input` may be a local file OR an HLS manifest URL, which is how this stage
 * plugs into a live stream without changing.
 */
export function renderClip({
  input, startSec, durationSec, out,
  width = 1080, height = 1920, blurSigma = 28, crf = 20,
}) {
  mkdirSync(dirname(out), { recursive: true });

  const filter = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=${blurSigma}[bgb]`,
    `[fg]scale=${width}:-2[fgs]`,
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`,
  ].join(';');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // -ss BEFORE -i seeks by keyframe and is far faster on a long source; for a
    // live manifest it also avoids pulling segments we are going to discard.
    '-ss', String(startSec),
    '-i', input,
    '-t', String(durationSec),
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?',           // audio is optional: gameplay sources sometimes have none
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', // so it starts playing before it finishes downloading
    out,
  ];

  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0
      ? resolve({ out, width, height, durationSec })
      : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 600)}`)));
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
