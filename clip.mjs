import { renderClip } from './src/render.mjs';

const [input, start, duration, out] = process.argv.slice(2);
if (!input) {
  console.log('usage: node clip.mjs <input|m3u8-url> <startSec> <durationSec> <out.mp4>');
  process.exit(1);
}
const t0 = Date.now();
const r = await renderClip({
  input, startSec: Number(start), durationSec: Number(duration), out,
});
console.log(`rendered ${r.out}  ${r.width}x${r.height}  ${r.durationSec}s  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
