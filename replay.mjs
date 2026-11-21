import { readFileSync } from 'node:fs';
import { SpikeDetector } from './src/detector.mjs';
import { classify, score } from './src/classify.mjs';

/**
 * Deterministic offline replay. Same data, same thresholds, same answer -- every
 * time. This is what makes the detector tunable: live streams are never twice the
 * same, so you cannot measure a threshold change against them.
 *
 *   node replay.mjs data/chat-*.jsonl --fireZ=3.5 --shapeGate=0.35 --verbose
 */
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : (isNaN(Number(v)) ? v : Number(v))];
  })
);
const verbose = Boolean(flags.verbose);
delete flags.verbose;

const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
const byChannel = new Map();
for (const l of lines) {
  const m = JSON.parse(l);
  if (!byChannel.has(m.ch)) byChannel.set(m.ch, []);
  byChannel.get(m.ch).push(m);
}

const accepted = [], rejected = [];
let totals = { messages: 0, considered: 0 };

for (const [ch, msgs] of byChannel) {
  msgs.sort((a, b) => a.t - b.t);
  if (msgs.length < 50) continue;

  const det = new SpikeDetector(flags);
  det.on('spike', (s) => accepted.push({ ch, ...s }));
  det.on('spike:rejected', (s) => rejected.push({ ch, ...s }));

  const first = msgs[0].t, last = msgs[msgs.length - 1].t;
  det.startedAt = first;
  let i = 0;
  for (let now = first; now <= last; now += det.cfg.tickMs) {
    while (i < msgs.length && msgs[i].t <= now) det.ingest(msgs[i++]);
    det.tick(now);
  }
  totals.messages += det.stats.messages;
  totals.considered += det.stats.considered;
}

const span = (() => {
  const all = lines.map(l => JSON.parse(l).t);
  return (Math.max(...all) - Math.min(...all)) / 60000;
})();

console.log(`\n${file}`);
console.log(`${totals.messages} messages · ${byChannel.size} channels · ${span.toFixed(1)} min`);
console.log(`thresholds: ${JSON.stringify(flags)}`);
console.log(`\ncandidates ${totals.considered} → accepted ${accepted.length} · rejected ${rejected.length}` +
  (totals.considered ? ` (gate removed ${(rejected.length / totals.considered * 100).toFixed(0)}%)` : ''));

const show = (list, label) => {
  if (!list.length) return;
  console.log(`\n── ${label} ──`);
  for (const s of list.sort((a, b) => (b.shape.shape - a.shape.shape))) {
    const cls = classify(s.window);
    const sc = score(s, cls);
    console.log(`${String(sc).padStart(3)}/100  shape ${s.shape.shape.toFixed(2)}  z=${String(s.peakZ).padStart(5)}  ` +
      `${s.peakUniqueChatters.toString().padStart(3)} chatters  ${cls.kind.padEnd(10)} ${s.ch}` +
      (cls.clipRequests ? `  "clip it"x${cls.clipRequests}` : ''));
    if (verbose) {
      console.log(`       signals: ${JSON.stringify(s.shape.signals)}`);
      for (const m of s.window.filter(m => m.text).slice(0, 5)) {
        console.log(`       ${m.login}: ${m.text.slice(0, 64)}`);
      }
    }
  }
};

show(accepted, `ACCEPTED (${accepted.length})`);
if (verbose) show(rejected, `REJECTED by shape gate (${rejected.length})`);
