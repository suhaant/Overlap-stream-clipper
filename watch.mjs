import { mkdirSync } from 'node:fs';
import { TwitchChat } from './src/chat.mjs';
import { SpikeDetector } from './src/detector.mjs';
import { classify, score } from './src/classify.mjs';
import { chatHighlights } from './src/caption.mjs';
import { StreamBuffer } from './src/buffer.mjs';
import { renderClip } from './src/render.mjs';
import { OnlineDetector, toCandidate } from './src/online.mjs';
import { loadModel, scorerFor } from './src/score.mjs';

/**
 * End to end: watch live chat, detect the moment, cut it out of the rolling
 * buffer, reframe it 9:16, burn the chat reaction in, write an mp4.
 *
 *   node watch.mjs stableronaldo,lacy 420
 */
const argv = process.argv.slice(2).filter(a => a !== '--model');
const channels = (argv[0] || 'stableronaldo').split(',');
const runFor = Number(argv[1] || 420);

/**
 * --model swaps the hand-written spike detector for the trained one.
 *
 * Both stay runnable because the benchmark cannot separate them: the heuristic
 * scores 0.130 and the model 0.141, with intervals that overlap almost
 * entirely. Picking a winner on that gap would be reading noise. What the two
 * paths disagree about -- which moments each fires on -- is more informative
 * than the gap, and needs both to exist to be looked at.
 */
const USE_MODEL = process.argv.includes('--model');

let scoreRow = null, fireThreshold = null;
if (USE_MODEL) {
  let model;
  try {
    model = loadModel();
  } catch (e) {
    console.error(`${e.message}`);
    process.exit(1);
  }
  scoreRow = scorerFor(model);
  fireThreshold = model.online?.threshold;
  if (!Number.isFinite(fireThreshold)) {
    console.error('model has no calibrated firing threshold. Retrain: npm run train');
    process.exit(1);
  }
  console.log(`using the trained model: ${model.featureSet}, ${model.keys.length} features, ` +
    `fire above ${fireThreshold.toFixed(4)} (${model.online.measuredFiresPerHour}/hour when measured)`);
}

/** The moment is in the past by the time chat finishes reacting; let the buffer catch up. */
const SETTLE_MS = 15000;

/**
 * Headlines in the shape that actually travels: a short statement of what
 * happened, not a label. "CHAT LOST IT" tells a scroller nothing. Kept free of
 * long words, because a word wider than the canvas cannot be wrapped and the
 * headline has to be rewritten rather than shrunk (see layoutHeadline).
 */
const HOOKS = {
  funny:   'chat lost it at this GTA 6 moment',
  shock:   'chat could not believe this',
  hype:    'chat went crazy at this',
  fail:    'it all went wrong right here',
  scary:   'chat was not ready for this',
  unclear: 'chat erupted at this moment',
};

/**
 * Per-channel framing. Scaling past canvas width crops the sides, and which side
 * to keep depends on where that streamer parks their facecam -- the most valuable
 * pixels in a reaction clip. 0 keeps the left edge, 1 the right, 0.5 centres.
 * Measured per channel; a sensible default is centre.
 */
const CHANNEL_LAYOUT = {
  stableronaldo: { cropAnchorX: 0.12 },   // facecam bottom-left
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

  const chat = new TwitchChat(ch).connect();
  chat.on('error', () => {});

  /** Shared tail: both detectors hand a candidate plus its chat window here. */
  const onMoment = (spike, window, headline) => {
    const cls = classify(window);
    const sc = USE_MODEL ? Math.round(spike.modelScore * 100) : score(spike, cls);
    const lines = chatHighlights(window);
    console.log(`\n[${ch}] ● MOMENT ${cls.kind} ${sc}/100 · ${headline}`);
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
          chatLines: lines.slice(0, 2),
          tmpDir: 'clips/.captions',
          ...(CHANNEL_LAYOUT[ch] || {}),
        });
        made.push({
          ch, out, kind: cls.kind, score: sc,
          // The two paths have no number in common: the heuristic reports a
          // z-score against its own baseline, the model a probability.
          why: USE_MODEL ? `p=${spike.modelScore}` : `z=${spike.peakZ}`,
        });
        console.log(`[${ch}]   -> ${r.out} (${ex.segments} segments, captioned=${r.captioned})`);
        for (const warn of r.warnings) console.log(`[${ch}]   ! ${warn}`);
      } catch (e) {
        console.log(`[${ch}]   render failed: ${e.message.slice(0, 200)}`);
      }
    }, SETTLE_MS);
  };

  if (USE_MODEL) {
    const det = new OnlineDetector(scoreRow, fireThreshold);
    const recent = [];

    /**
     * Ingest on arrival, decide on a clock.
     *
     * Ticking only when a message arrives leaves the detector armed through a
     * lull: there is no tick to expire its settle window, so it waits for chat
     * to come back and then commits to a peak minutes in the past. That is how
     * a 2,011-second decision latency happened once (see measure-latency).
     *
     * The clock is Twitch's, not ours. Feature windows are [t - scale, t), so a
     * second of skew between `tmi-sent-ts` and `Date.now()` quietly drops the
     * newest slice of chat out of every window.
     */
    let lastT = 0, lastSeenAt = 0;
    const twitchNow = () => (lastT ? lastT + (Date.now() - lastSeenAt) : Date.now());

    chat.on('message', (m) => {
      det.ingest(m);
      lastT = m.t; lastSeenAt = Date.now();
      recent.push(m);
      while (recent.length && recent[0].t < m.t - 60_000) recent.shift();
    });

    const ticker = setInterval(() => {
      const fired = det.tick(twitchNow());
      if (!fired) return;
      const cand = toCandidate(fired);
      const window = recent.filter(x => x.t >= cand.onsetAt - 2000 && x.t <= cand.peakAt + 5000);
      onMoment(cand, window,
        `model ${cand.modelScore} · decided ${(cand.decisionLagMs / 1000).toFixed(1)}s after the peak`);
    }, 1000);
    process.on('exit', () => clearInterval(ticker));
  } else {
    const det = new SpikeDetector().start();
    chat.on('message', (m) => det.ingest(m));
    det.on('spike:rejected', (s) =>
      console.log(`[${ch}] – rejected (shape ${s.shape.shape}, conversation not reaction)`));
    det.on('spike', (spike) => onMoment(spike, spike.window,
      `z=${spike.peakZ} · ${spike.peakUniqueChatters} chatters · shape ${spike.shape.shape}`));
  }

  process.on('exit', () => buffer.stop());
}

setTimeout(() => {
  console.log(`\n=== ${made.length} clips produced ===`);
  for (const m of made.sort((a, b) => b.score - a.score)) {
    console.log(`  ${String(m.score).padStart(3)}/100  ${m.kind.padEnd(9)} ${m.why.padEnd(10)} ${m.out}`);
  }
  process.exit(0);
}, runFor * 1000);
