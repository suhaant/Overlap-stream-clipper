#!/usr/bin/env node
/**
 * Print what the model learned, fit on everything.
 *
 * A precision number says whether a model works; the weights say whether it
 * works for a reason you can defend. Fit on all channels rather than
 * leave-one-out, because this is for reading the model, not for scoring it --
 * the scores come from tools/evaluate.mjs and its channel-held-out folds.
 */
import { readFileSync, existsSync } from 'node:fs';
import { makeLogreg, weightReport, FEATURE_SETS } from '../src/model.mjs';

const DATASET = process.argv[2] ?? 'data/dataset.jsonl';
if (!existsSync(DATASET)) {
  console.error(`${DATASET} not found. Run: npm run build-dataset`);
  process.exit(1);
}
const rows = readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

for (const set of Object.keys(FEATURE_SETS)) {
  const scorer = makeLogreg(rows, { features: FEATURE_SETS[set]() });
  console.log(`\n${set} -- ${scorer.keys.length} features, bias ${scorer.model.b.toFixed(3)}`);
  for (const { name, weight } of weightReport(scorer, 10)) {
    const bar = '#'.repeat(Math.min(30, Math.round(Math.abs(weight) * 20)));
    console.log(`  ${name.padEnd(24)}${weight.toFixed(3).padStart(8)}  ${bar}`);
  }
}
