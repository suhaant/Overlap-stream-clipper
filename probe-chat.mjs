// Probe: can we read a live Twitch chat with zero credentials?
// Anonymous IRC-over-WebSocket using the undocumented justinfan nick.
const channel = (process.argv[2] || 'shroud').toLowerCase().replace(/^#/, '');
const seconds = Number(process.argv[3] || 20);

const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
let count = 0;
const started = Date.now();

ws.addEventListener('open', () => {
  // tags  -> per-message metadata (emotes, user id, badges, timestamp)
  // commands -> room state + moderation events
  ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
  ws.send(`NICK justinfan${Math.floor(Math.random() * 99999)}`);
  ws.send(`JOIN #${channel}`);
  console.log(`connecting to #${channel} ...`);
});

ws.addEventListener('message', (ev) => {
  for (const line of ev.data.split('\r\n').filter(Boolean)) {
    if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
    const m = line.match(/^@(\S*) :(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
    if (!m) { if (/ (001|JOIN|ROOMSTATE|NOTICE) /.test(line)) console.log('  irc:', line.slice(0, 120)); continue; }
    count++;
    const tags = Object.fromEntries(m[1].split(';').map(p => p.split('=')));
    if (count <= 8) console.log(`  [${m[2]}] ${m[3].slice(0, 70)}  (emotes=${tags.emotes || 'none'})`);
  }
});

ws.addEventListener('error', (e) => console.log('ERROR', e.message || e));

setTimeout(() => {
  const secs = (Date.now() - started) / 1000;
  console.log(`\n=> ${count} messages in ${secs.toFixed(1)}s = ${(count / secs * 60).toFixed(0)} msg/min`);
  ws.close(); process.exit(0);
}, seconds * 1000);
