import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModel, scorerFor, liveScorer } from '../src/score.mjs';
import { buildRow, SCALES, MIN_MESSAGES } from '../src/windowrow.mjs';
import { MODEL_FEATURES, FEATURE_SETS, makeLogreg } from '../src/model.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hypecut-score-'));

/** Synthetic chat: `n` messages in the `ms` before `at`, from `people`. */
const chat = (at, ms, n, people, text = 'that was insane') => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: at - ms + Math.floor((i / n) * ms), user: `u${i % people}`, text });
  }
  return out.sort((a, b) => a.t - b.t);
};

function trainedArtifact(features = FEATURE_SETS.rate()) {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const at = 1_700_000_000_000 + i * 1000;
    const quiet = buildRow(chat(at, 30_000, 60, 30), at);
    const loud = buildRow(chat(at, 30_000, 60, 30).concat(chat(at, 4000, 60, 40)), at);
    if (quiet) rows.push({ ...quiet, y: 0 });
    if (loud) rows.push({ ...loud, y: 1 });
  }
  const scorer = makeLogreg(rows, { features });
  return {
    version: 1, featureSet: 'rate', keys: features,
    weights: scorer.model.w, bias: scorer.model.b,
    scaler: { keys: scorer.scaler.keys, min: scorer.scaler.min, max: scorer.scaler.max },
    rowSpec: { scales: SCALES, minMessages: MIN_MESSAGES, features: MODEL_FEATURES },
  };
}

test('the live path and the offline path give identical scores', () => {
  // The whole point of src/windowrow.mjs. If this drifts, the benchmark
  // describes a system that is not the one running.
  const artifact = trainedArtifact();
  const at = 1_700_000_500_000;
  const messages = chat(at, 30_000, 90, 40).concat(chat(at, 4000, 70, 50));
  messages.sort((a, b) => a.t - b.t);

  const offline = scorerFor(artifact)(buildRow(messages, at));
  const online = liveScorer(artifact)(messages, at);
  assert.equal(online, offline);
});

test('a quiet chat scores null, not zero', () => {
  // Zero would rank silence above an ordinary conversation, which inverts the
  // thing being measured.
  const at = 1_700_000_500_000;
  assert.equal(liveScorer(trainedArtifact())(chat(at, 30_000, 2, 2), at), null);
});

test('a reaction spike scores above steady chat', () => {
  const artifact = trainedArtifact();
  const score = liveScorer(artifact);
  const at = 1_700_000_500_000;
  const steady = chat(at, 30_000, 60, 30);
  const spike = chat(at, 30_000, 60, 30).concat(chat(at, 4000, 80, 60));
  spike.sort((a, b) => a.t - b.t);
  assert.ok(score(spike, at) > score(steady, at));
});

test('loadModel refuses a model whose row shape no longer matches the code', () => {
  const stale = { ...trainedArtifact(), rowSpec: { scales: [1000, 5000], minMessages: MIN_MESSAGES } };
  const p = join(dir, 'stale.json');
  writeFileSync(p, JSON.stringify(stale));
  assert.throws(() => loadModel(p), /scales/);

  const wrongMin = { ...trainedArtifact(), rowSpec: { scales: SCALES, minMessages: 999 } };
  const p2 = join(dir, 'wrongmin.json');
  writeFileSync(p2, JSON.stringify(wrongMin));
  assert.throws(() => loadModel(p2), /minMessages/);

  assert.throws(() => loadModel(join(dir, 'nope.json')), /npm run train/);
});

test('a real trained artifact round-trips through loadModel', () => {
  const p = join(dir, 'ok.json');
  writeFileSync(p, JSON.stringify(trainedArtifact()));
  const m = loadModel(p);
  assert.equal(m.weights.length, m.scaler.keys.length);
  assert.ok(Number.isFinite(m.bias));
});
