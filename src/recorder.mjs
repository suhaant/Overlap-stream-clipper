import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { TwitchChat } from './chat.mjs';

/**
 * CHAT RECORDER.
 *
 * Writes one channel's chat to newline-delimited JSON, one file per UTC hour,
 * so that aligning a clip's wall-clock time to the right file is arithmetic
 * rather than a search. Same reasoning as the strftime segment names in
 * src/buffer.mjs.
 *
 * Why this exists at all: the features are not recoverable after the fact.
 * Twitch removed the public VOD-comments endpoint, so chat for a stream that
 * already aired cannot be fetched. Labels can be harvested a day later; chat
 * has to be caught as it happens. Every hour this is not running is an hour of
 * training data that cannot be bought back.
 */

/** Identities are not needed, uniqueness is. */
function userKey(userId, salt) {
  return createHash('sha256').update(salt).update(String(userId)).digest('hex').slice(0, 12);
}

/**
 * A stable per-dataset salt, generated once and kept on disk.
 *
 * Hashing the user id lets us count unique chatters, which is the signal
 * src/detector.mjs actually uses, without keeping a record of who said what.
 * The salt must be stable across restarts or the same person becomes two people
 * either side of a crash, which would quietly inflate every uniqueness feature.
 * It must also not be published with the data, or the hashes become reversible
 * for any login someone cares to guess.
 */
export function datasetSalt(dir) {
  mkdirSync(dir, { recursive: true });
  if (process.env.RECORDER_SALT) return process.env.RECORDER_SALT;
  const path = join(dir, '.salt');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const salt = randomBytes(24).toString('hex');
  writeFileSync(path, salt + '\n', { mode: 0o600 });
  return salt;
}

/** UTC hour key, e.g. 20261122-14. */
export function hourKey(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
}

export class ChatRecorder extends EventEmitter {
  constructor(channel, { dir = 'data/chat', flushMs = 5000 } = {}) {
    super();
    this.channel = channel.toLowerCase();
    this.root = dir;
    this.dir = join(dir, this.channel);
    this.flushMs = flushMs;
    this.salt = datasetSalt(dir);
    this.buffer = [];
    this.stream = null;
    this.currentHour = null;
    this.stats = { messages: 0, bytes: 0, flushes: 0, reconnects: 0, startedAt: null, lastMessageAt: null };
  }

  start() {
    mkdirSync(this.dir, { recursive: true });
    this.stats.startedAt = Date.now();

    this.chat = new TwitchChat(this.channel);

    // Audit records go in the same stream as the messages, so a gap in the
    // record is visible in the data rather than only in a log we might not
    // keep. A model trained across an undetected gap learns that chat went
    // quiet when in fact we stopped listening.
    this.chat.on('open', () => this.#audit('open'));
    this.chat.on('reconnecting', (delay) => {
      this.stats.reconnects++;
      this.#audit('reconnecting', { delay });
    });
    this.chat.on('error', () => this.#audit('error'));

    this.chat.on('message', (m) => {
      this.stats.messages++;
      this.stats.lastMessageAt = m.t;
      this.buffer.push({
        t: m.t,
        u: userKey(m.user, this.salt),
        x: m.text,
        e: m.emoteCount,
        s: m.sub ? 1 : 0,
      });
    });

    this.chat.connect();
    this.timer = setInterval(() => this.flush(), this.flushMs);
    // Unref so a recorder never keeps a short-lived script alive on its own.
    this.timer.unref?.();
    return this;
  }

  #audit(type, extra = {}) {
    this.buffer.push({ t: Date.now(), _: type, ...extra });
    this.emit('audit', { type, ...extra });
  }

  /** Switch files when the UTC hour turns over. */
  #streamFor(ms) {
    const key = hourKey(ms);
    if (key !== this.currentHour) {
      this.stream?.end();
      this.currentHour = key;
      this.stream = createWriteStream(join(this.dir, `${key}.jsonl`), { flags: 'a' });
      this.stream.on('error', (e) => this.emit('error', e));
      this.emit('rotate', { channel: this.channel, hour: key });
    }
    return this.stream;
  }

  /**
   * Write what is buffered. Called on an interval rather than per message so a
   * busy channel does not mean a syscall per line; a crash costs flushMs of
   * chat, which is an acceptable trade against the write volume.
   */
  flush() {
    if (!this.buffer.length) return 0;
    const batch = this.buffer;
    this.buffer = [];

    // Group by hour so a batch straddling the hour boundary lands in both
    // files correctly instead of all going wherever the last record pointed.
    const byHour = new Map();
    for (const rec of batch) {
      const key = hourKey(rec.t);
      if (!byHour.has(key)) byHour.set(key, []);
      byHour.get(key).push(rec);
    }

    for (const [key, records] of [...byHour.entries()].sort()) {
      const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      this.#streamFor(new Date(
        // Reconstruct a timestamp inside that hour from the key itself, so the
        // file chosen depends on the records and never on the current time.
        Date.UTC(
          Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1,
          Number(key.slice(6, 8)), Number(key.slice(9, 11)),
        ),
      ).getTime()).write(text);
      this.stats.bytes += Buffer.byteLength(text);
    }

    this.stats.flushes++;
    return batch.length;
  }

  stop() {
    clearInterval(this.timer);
    this.#audit('close');
    this.flush();
    this.chat?.close();
    this.stream?.end();
    return this.stats;
  }
}
