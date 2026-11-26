#!/usr/bin/env node
/**
 * Fit the shipping model on every channel and write it to disk.
 *
 * Distinct from tools/evaluate.mjs on purpose. Evaluate fits a model per fold,
 * scores the held-out channel and throws the weights away -- that is how you
 * get an honest number, and it leaves nothing to run. This fits one model on
 * everything and saves it, which is how you get something that runs and tells
 * you nothing about how well it works.
 *
 * Do not quote a number from this script. The numbers come from evaluate.
 *
 * Usage:
 *   node tools/train.mjs
 *   node tools/train.mjs --features rate --out data/model-rate.json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { loadVideos } from '../src/clipstore.mjs';
import { labelChannels } from '../src/labelled.mjs';
import { makeLogreg, FEATURE_SETS, MODEL_FEATURES } from '../src/model.mjs';
import { SCALES, MIN_MESSAGES } from '../src/windowrow.mjs';
import { calibrateThreshold, DEFAULTS as ONLINE_DEFAULTS, CALIBRATION } from '../src/online.mjs';
import { scorerFor } from '../src/score.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DATASET = flag('dataset', 'data/dataset.jsonl');
const CLIP_DIR = flag('clips', 'data/clips');
const OUT = flag('out', 'data/model.json');
const SET = flag('features', 'rateAndConvergence');

if (!FEATURE_SETS[SET]) {
  console.error(`unknown feature set "${SET}". One of: ${Object.keys(FEATURE_SETS).join(', ')}`);
  process.exit(1);
}
if (!existsSync(DATASET)) {
  console.error(`${DATASET} not found. Run: npm run build-dataset`);
  process.exit(1);
}

const rows = readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const { usable, channels } = labelChannels(rows, { clipDir: CLIP_DIR, videos: loadVideos() });

const train = channels.flatMap(c => usable[c].rows);
const positives = train.filter(r => r.y === 1).length;
if (!positives) {
  console.error('no positive rows after labelling; nothing to fit.');
  process.exit(1);
}

const keys = FEATURE_SETS[SET]();
const scorer = makeLogreg(train, { features: keys });

/**
 * The operating point, measured rather than guessed.
 *
 * Training upweights the positive class so the model does not collapse to
 * predicting zero, which shifts every score upward by an amount depending on
 * the class ratio -- so no fixed probability cutoff is meaningful across
 * retrains. Instead the real firing rule is replayed over the training rows
 * and the threshold binary-searched until it fires at the rate the benchmark
 * allows itself: six per recorded hour.
 */
const FIRES_PER_HOUR = Number(flag('fires-per-hour', 6));
const provisional = {
  scaler: { keys: scorer.scaler.keys, min: scorer.scaler.min, max: scorer.scaler.max },
  weights: scorer.model.w, bias: scorer.model.b,
};
const { threshold, firesPerHour } = calibrateThreshold(
  usable, scorerFor(provisional), { firesPerHour: FIRES_PER_HOUR });

const artifact = {
  version: 1,
  createdAt: new Date().toISOString(),
  featureSet: SET,
  keys,
  weights: scorer.model.w,
  bias: scorer.model.b,
  scaler: { keys: scorer.scaler.keys, min: scorer.scaler.min, max: scorer.scaler.max },
  // The live path has to rebuild identical rows, so the shape travels with
  // the weights rather than being assumed to match.
  rowSpec: { scales: SCALES, minMessages: MIN_MESSAGES, features: MODEL_FEATURES },
  // How to fire, not just how to score. Carried with the weights because the
  // threshold is only meaningful for the model it was measured on.
  online: {
    // The global threshold is now the COLD-START fallback, not the operating
    // point. A channel uses it until it has enough of its own scores to solve
    // for one, which takes `minSpanMs`.
    threshold,
    measuredFiresPerHour: Number(firesPerHour.toFixed(2)),
    targetFiresPerHour: FIRES_PER_HOUR,
    settleMs: ONLINE_DEFAULTS.settleMs,
    refractorySec: ONLINE_DEFAULTS.refractorySec,
    /**
     * Each channel re-solves its own threshold against its own recent scores,
     * holding the RATE steady rather than the threshold.
     *
     * Measured over 20 held-out channels at the same 6/hour: fleet precision
     * 0.110 -> 0.132, recall 0.353 -> 0.397, rate spread 16.7x -> 4.7x. It is
     * not the scorer improving -- per-channel precision does not move
     * (t=-0.97) -- it is the budget going where there is something to find
     * instead of where chat is loudest.
     *
     * The rate stays at 6. Lowering it was tested and rejected: the recall
     * loss is certain (t=-3.09 at 3/hour) and the precision gain is noise
     * (t=1.29). See docs/FINDINGS.md.
     */
    autoCalibrate: { ...CALIBRATION, firesPerHour: FIRES_PER_HOUR },
  },
  trainedOn: {
    channels: channels.length,
    channelNames: channels,
    rows: train.length,
    positives,
    positiveRate: Number((positives / train.length).toFixed(5)),
  },
};

writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n');

console.log(`feature set   ${SET} (${keys.length} features)`);
console.log(`trained on    ${channels.length} channels, ${train.length.toLocaleString()} rows, ` +
  `${positives.toLocaleString()} positive (${(100 * positives / train.length).toFixed(2)}%)`);
console.log(`bias          ${scorer.model.b.toFixed(4)}`);
console.log(`fire at       score > ${threshold.toFixed(4)} ` +
  `(${firesPerHour.toFixed(2)}/hour measured, target ${FIRES_PER_HOUR})`);
console.log(`\n-> ${OUT}`);
console.log('This model has no honest score attached. Run: npm run evaluate');
