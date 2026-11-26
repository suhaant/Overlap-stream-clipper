#!/usr/bin/env node
/**
 * Run both detectors on the same live chat stream and record what each fires on.
 *
 *   node tools/compare-live.mjs zackrawrr 1800
 *
 * The benchmark cannot separate the heuristic (0.130) from the model (0.141) --
 * their intervals overlap almost entirely. So the useful question is not which
 * scores higher but WHERE THEY DISAGREE, and that needs both reading the same
 * messages at the same instant. Two separate `watch.mjs` processes would not do:
 * each opens its own IRC connection, so they would see slightly different
 * message sets and slightly different arrival times, and every disagreement
 * would be confounded with that.
 *
 * No video. The buffer and the renderer are deliberately absent -- this answers
 * "what would it have clipped", not "does the mp4 look good", and ffmpeg on a
 * 37k-viewer stream is a lot of disk for a question it cannot answer.
 *
 * Privacy: the transcript stores only repeated chat TEXT (via chatHighlights),
 * never a login, id or hash. Same rule as data/chat -- see docs/DATA.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { TwitchChat } from '../src/chat.mjs';
import { SpikeDetector } from '../src/detector.mjs';
import { OnlineDetector, toCandidate } from '../src/online.mjs';
import { loadModel, scorerFor } from '../src/score.mjs';
import { chatHighlights } from '../src/caption.mjs';
import { buildRow } from '../src/windowrow.mjs';
import { classify } from '../src/classify.mjs';

const channel = (process.argv[2] || 'zackrawrr').toLowerCase();
const runForSec = Number(process.argv[3] || 1800);
/** --rate N overrides the model's target, for trying an operating point live. */
const rateArg = process.argv.indexOf('--rate');
const rateOverride = rateArg >= 0 ? Number(process.argv[rateArg + 1]) : null;

/** Two fires are "the same moment" if their peaks land this close together. */
const AGREE_MS = 10_000;

const model = loadModel();
const scoreRow = scorerFor(model);
const threshold = model.online.threshold;
if (!Number.isFinite(threshold)) {
  console.error('model has no calibrated firing threshold. Retrain: npm run train');
  process.exit(1);
}

console.log(`channel      ${channel}`);
console.log(`model        ${model.featureSet}, ${model.keys.length} features, fire above ${threshold.toFixed(4)}`);
console.log(`trained on   ${model.trainedOn.channels} channels` +
  (model.trainedOn.channelNames?.includes(channel)
    ? `  !! ${channel} IS ONE OF THEM -- this run is in-sample`
    : `  (${channel} is not one of them -- held out)`));
console.log(`running      ${runForSec}s\n`);

const startedAt = Date.now();
const rel = (t) => {
  const s = Math.max(0, Math.round((t - startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const fires = [];                 // every fire from either detector, in order
const stats = { messages: 0, ticks: 0, scored: 0 };

/** Rolling text window, for reading back what a fire landed on. */
const recent = [];
const remember = (m) => {
  recent.push(m);
  while (recent.length && recent[0].t < m.t - 120_000) recent.shift();
};

/**
 * Everything runs on Twitch's clock, never ours.
 *
 * Messages carry `tmi-sent-ts`, and feature windows are [t - scale, t). Tick on
 * `Date.now()` while the two clocks differ by even a second or two and the most
 * recent slice of chat falls outside every window -- a silent, systematic shift
 * in exactly the features the model leans on. So: last message's own timestamp,
 * plus however long ago it arrived.
 */
let lastMsgT = 0, lastMsgSeenAt = 0, skewMs = 0;
const twitchNow = () => (lastMsgT ? lastMsgT + (Date.now() - lastMsgSeenAt) : Date.now());
const windowAround = (cand) =>
  recent.filter(x => x.t >= cand.onsetAt - 2000 && x.t <= cand.peakAt + 5000);

const record = (source, cand, detail) => {
  const window = windowAround(cand);
  const lines = chatHighlights(window);
  const cls = classify(window);
  /**
   * The full feature row at the peak, not just the ones the model reads.
   *
   * Suhaan labelled four fires good/bad and neither the model score (0.7822
   * against 0.7855) nor heuristic agreement (1/2 against 1/2) separated them.
   * Working out what would requires the features, and the earlier exports kept
   * only the chat highlights, so those four fires can never be re-analysed.
   * Keeping the row makes a label worth something later.
   */
  const row = online.messages.length ? buildRow(online.messages, cand.peakAt) : null;
  const entry = {
    source, peakAt: cand.peakAt, rel: rel(cand.peakAt),
    kind: cls.kind, chatters: new Set(window.map(m => m.user)).size,
    detail, lines, row,
  };
  fires.push(entry);
  const tag = source === 'model' ? 'MODEL    ' : 'HEURISTIC';
  console.log(`[${entry.rel}] ${tag} ${cls.kind.padEnd(8)} ${detail}`);
  console.log(`          ${lines.slice(0, 3).join(' | ') || '(nothing repeated)'}`);
};

const chat = new TwitchChat(channel).connect();
chat.on('error', () => {});

// ---- the model's own causal rule -------------------------------------------
const autoCalibrate = model.online?.autoCalibrate
  ? { ...model.online.autoCalibrate, ...(rateOverride ? { firesPerHour: rateOverride } : {}) }
  : null;
if (autoCalibrate) {
  console.log(`self-calibrating  ${autoCalibrate.firesPerHour}/hour per channel, ` +
    `after ${autoCalibrate.minSpanMs / 60_000}min of its own scores\n`);
}
const online = new OnlineDetector(scoreRow, threshold, autoCalibrate ? { autoCalibrate } : {});

// ---- the hand-written spike detector ---------------------------------------
const spikes = new SpikeDetector().start();
spikes.on('spike', (s) => record('heuristic', s,
  `z=${s.peakZ} ratio=${s.peakRatio} ${s.peakUniqueChatters} chatters shape=${s.shape.shape}`));
let rejected = 0;
spikes.on('spike:rejected', () => rejected++);

chat.on('message', (m) => {
  stats.messages++;
  remember(m);
  lastMsgT = m.t; lastMsgSeenAt = Date.now();
  skewMs = m.t - lastMsgSeenAt;
  spikes.ingest(m);
  online.ingest(m);
});

/**
 * The model ticks on a clock, not on message arrival. Arrival-driven ticking
 * leaves the detector armed through a lull -- there is no tick to expire the
 * settle window -- which is how a 2,011s decision latency happened once.
 */
const tick = setInterval(() => {
  const now = twitchNow();
  stats.ticks++;
  const fired = online.tick(now);
  if (!fired) return;
  const cand = toCandidate(fired);
  record('model', cand,
    `score=${cand.modelScore} decided ${(cand.decisionLagMs / 1000).toFixed(1)}s after the peak`);
}, 1000);

// ---- the diff ---------------------------------------------------------------
function diff() {
  const model_ = fires.filter(f => f.source === 'model');
  const heur = fires.filter(f => f.source === 'heuristic');
  const usedH = new Set();
  const agreed = [];
  for (const m of model_) {
    let best = -1, bestGap = Infinity;
    for (let i = 0; i < heur.length; i++) {
      if (usedH.has(i)) continue;
      const gap = Math.abs(heur[i].peakAt - m.peakAt);
      if (gap <= AGREE_MS && gap < bestGap) { best = i; bestGap = gap; }
    }
    if (best >= 0) { usedH.add(best); agreed.push({ model: m, heuristic: heur[best], gapMs: bestGap }); }
  }
  return {
    agreed,
    modelOnly: model_.filter(m => !agreed.some(a => a.model === m)),
    heuristicOnly: heur.filter((h, i) => !usedH.has(i)),
    model: model_, heuristic: heur,
  };
}

function report() {
  clearInterval(tick);
  spikes.stop();
  const hours = (Date.now() - startedAt) / 3_600_000;
  const d = diff();
  const per = (n) => (n / hours).toFixed(2);

  console.log(`\n=== ${channel}, ${(hours * 60).toFixed(1)} minutes, ${stats.messages} messages ===\n`);
  console.log(`model fired      ${String(d.model.length).padStart(3)}   ${per(d.model.length)}/hour  (calibrated for ${model.online.targetFiresPerHour})`);
  console.log(`heuristic fired  ${String(d.heuristic.length).padStart(3)}   ${per(d.heuristic.length)}/hour  (+${rejected} rejected by the shape gate)`);
  console.log(`chat clock skew  ${(skewMs / 1000).toFixed(1)}s against ours at the end`);
  if (autoCalibrate) {
    console.log(`recalibrated     ${online.calibrations} times, ending at ` +
      `${online.threshold.toFixed(4)} (fallback was ${threshold.toFixed(4)})`);
  }
  console.log(`both agreed on   ${String(d.agreed.length).padStart(3)}   within ${AGREE_MS / 1000}s`);
  console.log(`model only       ${String(d.modelOnly.length).padStart(3)}`);
  console.log(`heuristic only   ${String(d.heuristicOnly.length).padStart(3)}`);

  const show = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n--- ${title} ---`);
    for (const r of rows) console.log(fmt(r));
  };
  show('agreed', d.agreed, (a) =>
    `[${a.model.rel}] gap ${(a.gapMs / 1000).toFixed(1)}s  ${a.model.kind}\n          ${a.model.lines.slice(0, 2).join(' | ')}`);
  show('model only', d.modelOnly, (m) =>
    `[${m.rel}] ${m.kind} ${m.chatters} chatters  ${m.detail}\n          ${m.lines.slice(0, 2).join(' | ')}`);
  show('heuristic only', d.heuristicOnly, (h) =>
    `[${h.rel}] ${h.kind} ${h.chatters} chatters  ${h.detail}\n          ${h.lines.slice(0, 2).join(' | ')}`);

  mkdirSync('exports', { recursive: true });
  const out = `exports/live-compare-${channel}-${new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
  writeFileSync(out, JSON.stringify({
    channel, startedAt, endedAt: Date.now(), hours: Number(hours.toFixed(3)),
    messages: stats.messages, ticks: stats.ticks, chatClockSkewMs: skewMs,
    model: { featureSet: model.featureSet, threshold, endThreshold: online.threshold,
      calibrations: online.calibrations, autoCalibrate, inSample: Boolean(model.trainedOn.channelNames?.includes(channel)) },
    counts: {
      model: d.model.length, heuristic: d.heuristic.length, heuristicRejected: rejected,
      agreed: d.agreed.length, modelOnly: d.modelOnly.length, heuristicOnly: d.heuristicOnly.length,
    },
    fires,
  }, null, 2) + '\n');
  console.log(`\nwrote ${out}`);
  process.exit(0);
}

setTimeout(report, runForSec * 1000);
process.on('SIGINT', report);
