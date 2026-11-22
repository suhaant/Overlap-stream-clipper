import { mkdirSync } from 'node:fs';
import { TwitchChat } from './src/chat.mjs';
import { SpikeDetector } from './src/detector.mjs';
import { classify, score } from './src/classify.mjs';
import { chatHighlights } from './src/caption.mjs';
import { StreamBuffer } from './src/buffer.mjs';
import { renderClip } from './src/render.mjs';

/**
 * End to end: watch live chat, detect the moment, cut it out of the rolling
 * buffer, reframe it 9:16, burn the chat reaction in, write an mp4.
 *
 *   node watch.mjs stableronaldo,lacy 420
 */
const channels = (process.argv[2] || 'stableronaldo').split(',');
const runFor = Number(process.argv[3] || 420);

/** The moment is in the past by the time chat finishes reacting; let the buffer catch up. */
const SETTLE_MS = 15000;

const HOOKS = {
  funny: 'chat lost it', shock: 'wait what', hype: 'chat went crazy',
  fail: 'oh no', scary: 'chat panicked', unclear: 'chat erupted',
};

mkdirSync('clips', { recursive: true });
const made = [];

for (const ch of channels) {
  let buffer;
  try {
    buffer = new StreamBuffer(ch, { dir: `buffer/${ch}` }).start();
    console.log(`[${ch}] recording buffer + watching chat`);
  } catch (e) {
    console.log(`[${ch}] cannot buffer: ${e.message}`);
    continue;
  }

  const det = new SpikeDetector().start();
  const chat = new TwitchChat(ch).connect();
  chat.on('message', (m) => det.ingest(m));
  chat.on('error', () => {});

  det.on('spike:rejected', (s) =>
    console.log(`[${ch}] – rejected (shape ${s.shape.shape}, conversation not reaction)`));

  det.on('spike', (spike) => {
    const cls = classify(spike.window);
    const sc = score(spike, cls);
    const lines = chatHighlights(spike.window);
    console.log(`\n[${ch}] ● MOMENT ${cls.kind} ${sc}/100 · z=${spike.peakZ} · ` +
      `${spike.peakUniqueChatters} chatters · shape ${spike.shape.shape}`);
    console.log(`[${ch}]   chat: ${lines.join(' | ')}`);

    setTimeout(async () => {
      const raw = `clips/.raw-${spike.id}.ts`;
      let ex;
      try {
        ex = buffer.extract(spike.clipStartAt, spike.clipEndAt, raw);
      } catch (e) {
        console.log(`[${ch}]   extract failed: ${e.message.slice(0, 120)}`); return;
      }
      if (!ex) { console.log(`[${ch}]   no buffered video covering that window yet`); return; }

      const out = `clips/${ch}-${spike.id}-${cls.kind}.mp4`;
      try {
        const r = await renderClip({
          input: ex.path, startSec: ex.offsetSec,
          durationSec: spike.durationMs / 1000, out,
          hook: HOOKS[cls.kind] || HOOKS.unclear,
          chatLines: lines,
          tmpDir: 'clips/.captions',
        });
        made.push({ ch, out, kind: cls.kind, score: sc, z: spike.peakZ });
        console.log(`[${ch}]   -> ${r.out} (${ex.segments} segments, captioned=${r.captioned})`);
      } catch (e) {
        console.log(`[${ch}]   render failed: ${e.message.slice(0, 200)}`);
      }
    }, SETTLE_MS);
  });

  process.on('exit', () => buffer.stop());
}

setTimeout(() => {
  console.log(`\n=== ${made.length} clips produced ===`);
  for (const m of made.sort((a, b) => b.score - a.score)) {
    console.log(`  ${String(m.score).padStart(3)}/100  ${m.kind.padEnd(9)} z=${String(m.z).padStart(6)}  ${m.out}`);
  }
  process.exit(0);
}, runFor * 1000);
