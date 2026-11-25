import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakPick, precisionAtK, weightedRecall, evaluate, bootstrapCI } from '../src/eval.mjs';

const at = (sec, score) => ({ t: sec * 1000, score });
const ev = (sec, presses = 1) => ({ atMs: sec * 1000, presses });

test('peak picking keeps the best of a cluster and suppresses the rest', () => {
  const scored = [at(100, 0.3), at(110, 0.9), at(120, 0.5), at(400, 0.4)];
  const kept = peakPick(scored, { refractorySec: 45 });

  assert.equal(kept.length, 2, 'one eruption must not yield three detections');
  assert.equal(kept[0].t, 110_000);
  assert.equal(kept[1].t, 400_000);
});

test('firing before the press is a hit, firing after is not', () => {
  const events = [ev(100)];
  // 20s early: exactly what a detector at the chat peak does.
  assert.equal(precisionAtK([at(80, 1)], events, { k: 1 }).hits, 1);
  // 44s early: inside the measured press-lag distribution.
  assert.equal(precisionAtK([at(56, 1)], events, { k: 1 }).hits, 1);
  // 60s early: beyond it.
  assert.equal(precisionAtK([at(40, 1)], events, { k: 1 }).hits, 0);
  // 3s late: still cuts the right clip once pre-roll applies.
  assert.equal(precisionAtK([at(103, 1)], events, { k: 1 }).hits, 1);
  // 30s late: the human already clipped it, so nothing was added.
  assert.equal(precisionAtK([at(130, 1)], events, { k: 1 }).hits, 0);
});

test('one event cannot be claimed twice', () => {
  const events = [ev(100)];
  // Two detections bracketing the same moment: one hit, one false positive.
  const r = precisionAtK([at(80, 1), at(90, 0.9)], events, { k: 2 });
  assert.equal(r.hits, 1);
  assert.equal(r.precision, 0.5);
});

test('precision counts only the top k', () => {
  const events = [ev(100), ev(500)];
  const detections = [at(80, 0.9), at(480, 0.8), at(900, 0.7)];
  assert.equal(precisionAtK(detections, events, { k: 2 }).precision, 1);
  assert.ok(Math.abs(precisionAtK(detections, events, { k: 3 }).precision - 2 / 3) < 1e-9);
});

test('weighted recall values the moments more people clipped', () => {
  const events = [ev(100, 20), ev(500, 1)];
  // Finding the heavily-clipped one is worth far more than the other.
  const big = weightedRecall([at(80, 1)], events, { k: 1 });
  const small = weightedRecall([at(480, 1)], events, { k: 1 });
  assert.ok(Math.abs(big - 20 / 21) < 1e-9, `got ${big}`);
  assert.ok(Math.abs(small - 1 / 21) < 1e-9, `got ${small}`);
});

test('a perfect scorer scores 1 and a blind one scores low', () => {
  const rows = [];
  for (let s = 0; s < 3600; s += 10) rows.push({ t: s * 1000, hit: s === 500 || s === 2000 });
  const byChannel = {
    a: { rows, events: [ev(520), ev(2020)], hours: 1 },
  };
  const oracle = evaluate(byChannel, (r) => (r.hit ? 1 : 0), { perHour: 2 });
  assert.equal(oracle.precision, 1);

  const blind = evaluate(byChannel, () => 1, { perHour: 2 });
  assert.ok(blind.precision < 1, `blind scorer got ${blind.precision}`);
});

test('the mean is over channels, so one busy channel cannot decide it', () => {
  const mk = (n, hit) => {
    const rows = [];
    for (let s = 0; s < n; s += 10) rows.push({ t: s * 1000, hit: s === hit });
    return rows;
  };
  const byChannel = {
    big: { rows: mk(3600, 500), events: [ev(520)], hours: 1 },
    small: { rows: mk(3600, 500), events: [ev(3000)], hours: 1 },
  };
  const r = evaluate(byChannel, (x) => (x.hit ? 1 : 0), { perHour: 1 });
  // One channel perfect, one channel wrong: 0.5, regardless of row counts.
  assert.equal(r.precision, 0.5);
});

test('channels with no events are skipped rather than scored zero', () => {
  const rows = [{ t: 1000, hit: true }];
  const r = evaluate({ a: { rows, events: [], hours: 1 } }, () => 1, { perHour: 1 });
  assert.equal(r.channels, 0);
});

test('the bootstrap widens as channels shrink and refuses a single channel', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ precision: i % 2 ? 0.8 : 0.4 }));
  const few = many.slice(0, 3);
  const wide = bootstrapCI(few);
  const tight = bootstrapCI(many);
  assert.ok((wide.hi - wide.lo) > (tight.hi - tight.lo), 'fewer channels must give a wider interval');
  assert.ok(Number.isNaN(bootstrapCI([{ precision: 1 }]).lo));
});
