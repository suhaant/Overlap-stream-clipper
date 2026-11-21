import { EventEmitter } from 'node:events';

/**
 * Anonymous read-only Twitch chat client.
 *
 * Twitch accepts an unauthenticated IRC login if the nick looks like
 * `justinfan<digits>`. It is undocumented but long-standing, and it means we can
 * read any public channel's chat with zero credentials and zero rate-limit risk.
 * Twitch officially steers new projects to EventSub `channel.chat.message`, which
 * needs a user token + `user:read:chat`. For a pitch demo, justinfan is the right
 * call: no OAuth dance, nothing to leak. Production would use EventSub.
 */
export class TwitchChat extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.ws = null;
    this.closed = false;
    this.reconnects = 0;
  }

  connect() {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;

    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK justinfan${Math.floor(Math.random() * 999999)}`);
      ws.send(`JOIN #${this.channel}`);
      this.reconnects = 0;
      this.emit('open');
    });

    ws.addEventListener('message', (ev) => {
      for (const line of String(ev.data).split('\r\n')) {
        if (line) this.#line(line);
      }
    });

    ws.addEventListener('close', () => {
      if (this.closed) return;
      // Twitch drops idle/greedy connections. Back off and rejoin.
      const delay = Math.min(30000, 1000 * 2 ** this.reconnects++);
      this.emit('reconnecting', delay);
      setTimeout(() => this.connect(), delay);
    });

    ws.addEventListener('error', (e) => this.emit('error', e));
    return this;
  }

  #line(line) {
    if (line.startsWith('PING')) { this.ws.send('PONG :tmi.twitch.tv'); return; }

    const m = line.match(/^@(\S*) :(\w+)!\S+ PRIVMSG #\S+ :(.*)$/);
    if (!m) {
      if (line.includes(' ROOMSTATE ')) this.emit('roomstate', line);
      return;
    }

    const tags = {};
    for (const pair of m[1].split(';')) {
      const i = pair.indexOf('=');
      tags[pair.slice(0, i)] = pair.slice(i + 1);
    }

    // Native Twitch emotes arrive in the `emotes` tag. Third-party emotes
    // (7TV/BTTV) -- which is where KEKW, LULW, Sadge actually live -- come
    // through as plain text. So text matching matters more than this tag.
    const emoteCount = tags.emotes
      ? tags.emotes.split('/').reduce((n, e) => n + e.split(',').length, 0)
      : 0;

    this.emit('message', {
      // tmi-sent-ts is Twitch's own clock: better than ours for ordering.
      t: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now(),
      user: tags['user-id'] || m[2],
      login: m[2],
      text: m[3],
      emoteCount,
      sub: tags.subscriber === '1',
      mod: tags.mod === '1',
    });
  }

  close() { this.closed = true; this.ws?.close(); }
}
