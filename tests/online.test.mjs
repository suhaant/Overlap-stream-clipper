import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnlineDetector, advance, advanceScored, calibrateThreshold, toCandidate } from '../src/online.mjs';

/** A detector driven by scores directly, bypassing feature building. */
const det = (threshold = 0.5, opts = {}) => new OnlineDetector(() => 0, threshold, opts);

/** Feed a score series one second apart; collect what it fires. */
function run(d, scores, startAt = 1_700_000_000_000) {
  const fired = [];
  scores.forEach((s, i) => {
    const out = advanceScored(d, startAt + i * 1000, s);
    if (out) fired.push({ ...out, index: i });
  });
  return fired;
}

test('fires at the peak, not at the first threshold crossing', () => {
  // The crossing is the start of a reaction. Firing there cuts the clip
  // before the thing people are reacting to has landed.
  const fired = run(det(0.5, { settleMs: 8000 }), [0.1, 0.2, 0.6, 0.8, 0.95, 0.7, 0.3, 0.1]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].index, 6, 'commits when the score falls back below threshold');
  assert.equal(fired[0].score, 0.95);
  assert.equal(fired[0].t % 1000, 0);
  // The peak was at index 4, committed at 6: two seconds of settle.
  assert.equal(fired[0].decidedAt - fired[0].t, 2000);
});

test('the settle window bounds how long it will wait', () => {
  // A score that never falls back must still commit, or a long hype train
  // becomes one clip decided minutes later.
  const fired = run(det(0.5, { settleMs: 5000 }), new Array(30).fill(0.9));
  assert.ok(fired.length >= 1);
  assert.ok(fired[0].decidedAt - fired[0].armedAt <= 5000 + 1000);
});

test('an armed detector commits when chat goes quiet', () => {
  // Regression. advance() returns early when there is too little chat to
  // build a row; without an expiry check the detector stayed armed until
  // chat returned and then fired on a peak up to 2,011 seconds old.
  const d = det(0.5, { settleMs: 4000 });
  const t0 = 1_700_000_000_000;
  assert.equal(advanceScored(d, t0, 0.9), null, 'arms');
  assert.equal(d.state, 'armed');

  assert.equal(advance(d, null, t0 + 1000), null, 'still inside the settle window');
  const fired = advance(d, null, t0 + 9000);
  assert.ok(fired, 'must commit once settled, even with no chat');
  assert.equal(fired.score, 0.9);
  assert.equal(fired.t, t0, 'fires on the peak it actually saw');
  assert.equal(d.state, 'idle');
});

test('refractory stops one eruption becoming six clips', () => {
  const scores = [];
  for (let i = 0; i < 120; i++) scores.push(i % 4 === 0 ? 0.9 : 0.2);
  const fired = run(det(0.5, { settleMs: 2000, refractorySec: 45 }), scores);
  for (let i = 1; i < fired.length; i++) {
    assert.ok(fired[i].decidedAt - fired[i - 1].decidedAt >= 45_000,
      'fires closer together than the refractory period');
  }
});

test('calibrateThreshold hits the requested fire rate', () => {
  // A channel of pure noise: the only thing setting the rate is the threshold,
  // so if the search is right the measured rate lands on target.
  const t0 = 1_700_000_000_000;
  let seed = 1;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows = Array.from({ length: 3600 * 4 }, (_, i) => ({ t: t0 + i * 1000, r: rand() }));
  const byChannel = { noise: { rows, hours: 4 } };

  for (const target of [3, 6, 12]) {
    const { threshold, firesPerHour } = calibrateThreshold(byChannel, (r) => r.r, { firesPerHour: target });
    assert.ok(threshold > 0 && threshold < 1, `implausible threshold ${threshold}`);
    assert.ok(Math.abs(firesPerHour - target) <= 1.0,
      `asked for ${target}/hour, measured ${firesPerHour.toFixed(2)}`);
  }
});

test('toCandidate matches the shape the heuristic emits', () => {
  const c = toCandidate({ t: 1_700_000_050_000, score: 0.8137, decidedAt: 1_700_000_055_000 });
  assert.equal(c.source, 'model');
  assert.equal(c.peakAt - c.onsetAt, 3500, 'walks back by the measured reaction lag');
  assert.equal(c.clipEndAt - c.clipStartAt, c.durationMs);
  assert.equal(c.durationMs, 30_000);
  assert.equal(c.decisionLagMs, 5000);
  assert.equal(c.modelScore, 0.8137);
  for (const k of ['id', 'peakAt', 'onsetAt', 'clipStartAt', 'clipEndAt', 'durationMs']) {
    assert.ok(c[k] !== undefined, `missing ${k}, which watch.mjs reads`);
  }
});
