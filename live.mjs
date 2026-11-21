import { TwitchChat } from './src/chat.mjs';
import { SpikeDetector } from './src/detector.mjs';
import { classify, score } from './src/classify.mjs';

const channels = (process.argv[2] || 'ohnepixel').split(',');
const runFor = Number(process.argv[3] || 170);
const found = [];

for (const ch of channels) {
  const det = new SpikeDetector().start();
  const chat = new TwitchChat(ch).connect();
  let lastLog = 0;

  chat.on('message', (m) => det.ingest(m));
  chat.on('open', () => console.log(`[${ch}] joined`));

  det.on('tick', (s) => {
    if (Date.now() - lastLog < 5000) return;
    lastLog = Date.now();
    const bar = '█'.repeat(Math.min(Math.round(s.ratio * 6), 40));
    process.stdout.write(
      `[${ch}] ${s.ratio.toFixed(2)}x  ${s.msgRate.toFixed(0)} msg/s  ` +
      `base ${s.baselineUniqueRate.toFixed(1)} u/s  ${bar}${s.spiking ? ' ● SPIKING' : ''}\n`
    );
  });

  det.on('spike:open', (s) => console.log(`[${ch}] ▲ spike opening at ${s.ratio.toFixed(2)}x`));

  det.on('spike', (spike) => {
    const cls = classify(spike.window);
    const sc = score(spike, cls);
    found.push({ channel: ch, ...spike, cls, score: sc });
    const ts = new Date(spike.onsetAt).toLocaleTimeString();

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`[${ch}] MOMENT  ${cls.kind.toUpperCase()}  score ${sc}/100`);
    console.log(`  peak ${spike.peakRatio}x baseline · ${spike.peakUniqueChatters} unique chatters in 4s`);
    console.log(`  on-screen onset ~${ts} (chat peak minus 3.5s reaction lag)`);
    console.log(`  clip window ${(spike.durationMs / 1000).toFixed(0)}s · chat asked to clip it ${cls.clipRequests}x`);
    console.log(`  chat said:`);
    for (const m of spike.window.slice(0, 6)) console.log(`    ${m.login}: ${m.text.slice(0, 58)}`);
    console.log(`${'─'.repeat(72)}\n`);
  });
}

setTimeout(() => {
  console.log(`\n\n=== ${found.length} moments detected across ${channels.length} channel(s) ===`);
  for (const f of found.sort((a, b) => b.score - a.score)) {
    console.log(`  ${String(f.score).padStart(3)}/100  ${f.cls.kind.padEnd(11)} ${f.channel}  ${f.peakRatio}x  ${f.peakUniqueChatters} chatters`);
  }
  process.exit(0);
}, runFor * 1000);
