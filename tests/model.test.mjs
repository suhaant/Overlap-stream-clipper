import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelFeatures, MODEL_FEATURES, RATE_FEATURES, FEATURE_SETS,
  makeLogreg, subsample,
} from '../src/model.mjs';

/** A window row at a given absolute volume and short/long ratio. */
const row = ({ base = 100, spike = 1, chatterSpike = null, label = 0, len = 20 }) => ({
  ch: 'x', t: 0, label,
  w4_messages: base * spike, w10_messages: base * spike, w30_messages: base,
  w4_chatters: base * (chatterSpike ?? spike) * 0.6,
  w10_chatters: base * (chatterSpike ?? spike) * 0.6,
  w30_chatters: base * 0.6,
  w4_meanLength: len, w10_meanLength: len, w30_meanLength: 20,
  w4_crowdRepetition: 0.1, w10_crowdRepetition: 0.1, w30_crowdRepetition: 0.1,
});

test('rate features exclude msgRate and chatterRate', () => {
  // Regression: msgRate is messages/windowSeconds, so msgRate_r4 is
  // algebraically identical to messages_r4 and including both double-counted
  // rate against every other signal. The first fit showed 0.659 vs 0.658.
  assert.ok(!RATE_FEATURES.includes('msgRate'));
  assert.ok(!RATE_FEATURES.includes('chatterRate'));
  assert.ok(!MODEL_FEATURES.some(n => n.startsWith('msgRate_')));
  assert.ok(!MODEL_FEATURES.some(n => n.startsWith('chatterRate_')));
});

test('a silent baseline gives a ratio of 1, not Infinity or NaN', () => {
  const f = modelFeatures({ w4_messages: 7, w10_messages: 7, w30_messages: 0 });
  assert.equal(f.messages_r4, 1);
  assert.equal(f.messages_r10, 1);
  for (const v of Object.values(modelFeatures({}))) assert.ok(Number.isFinite(v));
});

test('features are invariant to channel size at equal relative activity', () => {
  // The benchmark holds out whole channels, so this is the property that
  // decides whether a model transfers at all: a 3x spike must look the same
  // in a chat of 20 and a chat of 20,000.
  const small = modelFeatures(row({ base: 20, spike: 3 }));
  const huge = modelFeatures(row({ base: 20_000, spike: 3 }));
  for (const k of MODEL_FEATURES) {
    assert.ok(Math.abs(small[k] - huge[k]) < 1e-9, `${k} moved with channel size`);
  }
});

test('feature sets partition rate from everything else', () => {
  const rate = FEATURE_SETS.rate();
  const shares = FEATURE_SETS.shares();
  assert.equal(rate.length + shares.length, MODEL_FEATURES.length);
  assert.equal(rate.filter(n => shares.includes(n)).length, 0);
  assert.ok(FEATURE_SETS.rateAndConvergence().length > rate.length);
  assert.ok(FEATURE_SETS.rateAndConvergence().every(n => MODEL_FEATURES.includes(n)));
});

test('subsample keeps every positive and is deterministic', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ label: i % 100 === 0 ? 1 : 0, i }));
  const a = subsample(rows, { maxNegatives: 500 });
  const b = subsample(rows, { maxNegatives: 500 });
  assert.equal(a.filter(r => r.label === 1).length, 50);
  assert.equal(a.length, 550);
  assert.deepEqual(a.map(r => r.i), b.map(r => r.i), 'a rerun must give the same rows');
  // Below the cap nothing is dropped.
  assert.equal(subsample(rows, { maxNegatives: 1e6 }).length, 5000);
});

test('the fit learns a rate spike and transfers across channel size', () => {
  const train = [];
  for (let i = 0; i < 400; i++) {
    train.push({ ...row({ base: 50 + i, spike: 1, label: 0 }), y: 0 });
    train.push({ ...row({ base: 50 + i, spike: 4, label: 1 }), y: 1 });
  }
  const scorer = makeLogreg(train, { features: FEATURE_SETS.rate() });

  assert.ok(scorer(row({ base: 60, spike: 4 })) > scorer(row({ base: 60, spike: 1 })));
  // Trained only on chats of 50-450; must still work on one 100x bigger.
  assert.ok(scorer(row({ base: 50_000, spike: 4 })) > scorer(row({ base: 50_000, spike: 1 })),
    'the model must not depend on absolute volume');
});
