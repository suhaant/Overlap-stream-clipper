#!/usr/bin/env node
/**
 * How much precision the fire budget leaves on the table.
 *
 *   npm run ceiling
 *
 * The detector fires at a calibrated rate. Viewers press the clip button at
 * whatever rate they press it. When the first is larger than the second, most
 * fires cannot be real moments however good the scorer is -- the ceiling on
 * precision is events/fires, and no amount of model quality beats it.
 *
 * Written after a live run on zackrawrr fired four times in a half hour during
 * which viewers clipped nothing at all. The clip shown was a false positive,
 * which is what 0.165 precision means, but the check also revealed that the
 * benchmark's headline number sits against a ceiling of 0.416 rather than 1.0.
 */

import { readFileSync } from 'node:fs';
import { labelChannels } from '../src/labelled.mjs';
import { loadVideos } from '../src/clipstore.mjs';

const rows = readFileSync('data/dataset.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const videos = loadVideos();
const { byChannel } = labelChannels(rows, { clipDir: 'data/clips', videos });

const R = JSON.parse(readFileSync('data/results.json', 'utf8'));
const names = R.channels, pc = R.results.online.perChannel;

console.log('channel'.padEnd(15), 'hours'.padStart(5), 'events/h'.padStart(9), 'fires/h'.padStart(8), 'ceiling'.padStart(8), 'actual'.padStart(7));
const out = [];
for (let i = 0; i < names.length; i++) {
  const g = byChannel[names[i]];
  if (!g) continue;
  const eph = g.events.length / g.hours;
  const fph = pc[i].fires / g.hours;
  const ceiling = Math.min(1, eph / fph);
  out.push({ ch: names[i], hours: g.hours, eph, fph, ceiling, p: pc[i].precision });
}
out.sort((a, b) => b.ceiling - a.ceiling);
for (const r of out) console.log(r.ch.padEnd(15), r.hours.toFixed(1).padStart(5), r.eph.toFixed(2).padStart(9), r.fph.toFixed(2).padStart(8), r.ceiling.toFixed(3).padStart(8), r.p.toFixed(3).padStart(7));

const totE = out.reduce((s, r) => s + r.eph * r.hours, 0);
const totF = out.reduce((s, r) => s + r.fph * r.hours, 0);
console.log(`\nacross all: ${totE.toFixed(0)} labelled events, ${totF.toFixed(0)} fires -> pooled ceiling ${(totE/totF).toFixed(3)}`);
console.log(`measured online precision: ${R.results.online.precision.toFixed(3)}`);

const rank=(xs)=>{const s=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]);const r=[];s.forEach(([,i],k)=>r[i]=k+1);return r;};
const spear=(a,b)=>{const ra=rank(a),rb=rank(b),n=a.length,m=(n+1)/2;let num=0,da=0,db=0;
  for(let i=0;i<n;i++){num+=(ra[i]-m)*(rb[i]-m);da+=(ra[i]-m)**2;db+=(rb[i]-m)**2;}return num/Math.sqrt(da*db);};
console.log(`\nspearman events/h vs fires/h: ${spear(out.map(r=>r.eph), out.map(r=>r.fph)).toFixed(3)}  (does firing track where moments are?)`);
console.log(`achieved fraction of ceiling: ${(R.results.online.precision / (totE/totF)).toFixed(2)}`);
