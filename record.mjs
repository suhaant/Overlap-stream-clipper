import { TwitchChat } from './src/chat.mjs';
import { createWriteStream, mkdirSync } from 'node:fs';

/**
 * Capture raw chat to JSONL so the detector can be tuned deterministically offline.
 * You cannot tune a detector against a live stream you are unable to replay --
 * every threshold change would be measured against different data. Record once,
 * replay a thousand times.
 */
const channels = (process.argv[2] || 'ohnepixel').split(',');
const minutes = Number(process.argv[3] || 8);

mkdirSync('data', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const path = `data/chat-${stamp}.jsonl`;
const out = createWriteStream(path, { flags: 'a' });
const counts = {};

for (const ch of channels) {
  counts[ch] = 0;
  const chat = new TwitchChat(ch).connect();
  chat.on('message', (m) => {
    counts[ch]++;
    out.write(JSON.stringify({ ch, ...m }) + '\n');
  });
  chat.on('error', () => {});
}

const iv = setInterval(() => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[${new Date().toLocaleTimeString()}] ${total} msgs | ` +
    Object.entries(counts).map(([c, n]) => `${c}:${n}`).join(' '));
}, 60000);

setTimeout(() => {
  clearInterval(iv);
  out.end();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nDONE ${total} messages -> ${path}`);
  console.log(Object.entries(counts).map(([c, n]) => `  ${c}: ${n}`).join('\n'));
  process.exit(0);
}, minutes * 60000);
