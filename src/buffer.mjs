import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegBin } from './ffmpeg.mjs';

/**
 * ROLLING STREAM BUFFER.
 *
 * You cannot seek backwards on a live HLS manifest. By the time chat has spiked,
 * reacted and been measured, the moment is 20-30 seconds in the past, and Twitch's
 * live playlist only holds a short sliding window of segments. Asking ffmpeg to
 * `-ss` back into it is unreliable at best.
 *
 * So the stream is continuously recorded into a ring of short segments, copied not
 * re-encoded, and a detected spike is cut out of that ring afterwards. This is the
 * structural reason live clipping needs infrastructure that VOD clipping does not,
 * and it is why "clip it from the VOD later" and "clip it live" are different
 * products rather than the same product with a different trigger.
 *
 * Segments are named by wall-clock start time (strftime), so mapping a spike's
 * timestamps onto files is arithmetic rather than bookkeeping.
 */
export class StreamBuffer {
  constructor(channel, { dir, segmentSec = 4, retainSec = 900 } = {}) {
    this.channel = channel;
    this.dir = dir || `buffer/${channel}`;
    this.segmentSec = segmentSec;
    this.retainSec = retainSec;
    this.proc = null;
    this.manifest = null;
  }

  /** Resolve the live HLS manifest. yt-dlp handles Twitch's token dance for us. */
  resolveManifest() {
    const out = execFileSync('yt-dlp', [
      '-g', '--no-warnings', '--no-playlist',
      `https://www.twitch.tv/${this.channel}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 });
    const urls = out.trim().split('\n').filter(Boolean);
    if (!urls.length) throw new Error(`no manifest for ${this.channel} (offline?)`);
    this.manifest = urls[urls.length - 1];
    return this.manifest;
  }

  start() {
    mkdirSync(this.dir, { recursive: true });
    if (!this.manifest) this.resolveManifest();

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', this.manifest,
      '-c', 'copy',                 // no re-encode: buffering must stay cheap
      '-f', 'segment',
      '-segment_time', String(this.segmentSec),
      '-reset_timestamps', '1',
      '-strftime', '1',
      join(this.dir, 'seg_%Y%m%d-%H%M%S.ts'),
    ];
    this.proc = spawn(ffmpegBin(), args);
    this.proc.stderr.on('data', () => {});
    this.pruneTimer = setInterval(() => this.prune(), 30000);
    return this;
  }

  stop() {
    clearInterval(this.pruneTimer);
    this.proc?.kill('SIGINT');
  }

  /** Parse seg_YYYYMMDD-HHMMSS.ts back into a wall-clock start. */
  #startOf(name) {
    const m = name.match(/seg_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ts$/);
    if (!m) return null;
    const [, Y, M, D, h, mi, s] = m.map(Number);
    return new Date(Y, M - 1, D, h, mi, s).getTime();
  }

  segments() {
    let files;
    try { files = readdirSync(this.dir); } catch { return []; }
    return files
      .filter(f => f.endsWith('.ts'))
      .map(f => ({ path: join(this.dir, f), startMs: this.#startOf(f) }))
      .filter(s => s.startMs !== null)
      .sort((a, b) => a.startMs - b.startMs)
      .map((s, i, all) => ({
        ...s,
        // The last segment is still being written, so its end is "now".
        endMs: i + 1 < all.length ? all[i + 1].startMs : Date.now(),
      }));
  }

  prune() {
    const cutoff = Date.now() - this.retainSec * 1000;
    for (const s of this.segments()) {
      if (s.endMs < cutoff) { try { unlinkSync(s.path); } catch {} }
    }
  }

  /**
   * Concatenate the segments covering [startMs, endMs] into one file.
   * Returns the offset into that file where the requested window begins, so the
   * caller can seek without a second re-encode.
   */
  extract(startMs, endMs, outPath) {
    const covering = this.segments().filter(s => s.startMs < endMs && s.endMs > startMs);
    if (!covering.length) return null;

    // Guard against a segment still mid-write.
    const usable = covering.filter(s => { try { return statSync(s.path).size > 2048; } catch { return false; } });
    if (!usable.length) return null;

    const listPath = `${outPath}.list`;
    writeFileSync(listPath, usable.map(s => `file '${s.path.replace(/'/g, "'\\''")}'`).join('\n'));

    execFileSync(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', outPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    try { unlinkSync(listPath); } catch {}
    return {
      path: outPath,
      offsetSec: Math.max(0, (startMs - usable[0].startMs) / 1000),
      coveredMs: usable[usable.length - 1].endMs - usable[0].startMs,
      segments: usable.length,
    };
  }
}
