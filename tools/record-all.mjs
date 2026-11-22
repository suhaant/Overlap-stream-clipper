#!/usr/bin/env node
/**
 * Keep every channel in channels.json recorded.
 *
 * Usage:
 *   node tools/record-all.mjs
 *   node tools/record-all.mjs --channels channels.json --dir data/chat
 *   node tools/record-all.mjs --only stableronaldo,kaicenat
 *
 * This is the process that has to stay up. Everything downstream can be rebuilt
 * from what it writes; nothing can recover an hour it was not running for.
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadEnv } from '../src/env.mjs';
import { ChatRecorder } from '../src/recorder.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CHANNELS = flag('channels', 'channels.json');
const DIR = flag('dir', 'data/chat');
const HEARTBEAT_MS = Number(flag('heartbeat', 60_000));
const only = flag('only');

function channelList() {
  if (only) return only.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!existsSync(CHANNELS)) {
    console.error(`${CHANNELS} not found. Run: node tools/discover-channels.mjs --game "Grand Theft Auto VI"`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(CHANNELS, 'utf8'));
  return (cfg.channels ?? []).filter(c => c.record !== false).map(c => c.login);
}

const logins = channelList();
if (!logins.length) { console.error('no channels to record'); process.exit(1); }

console.log(`recording ${logins.length} channels into ${DIR}/`);

const recorders = logins.map((login) => {
  const r = new ChatRecorder(login, { dir: DIR });
  // A recorder that throws must not take the other channels down with it: one
  // channel going bad is a gap in one channel, not the end of the run.
  r.on('error', (e) => console.error(`[${login}] ${e.message ?? e}`));
  r.on('rotate', ({ hour }) => console.log(`[${login}] -> ${hour}.jsonl`));
  return r.start();
});

const startedAt = Date.now();

function heartbeat() {
  const hours = Math.max((Date.now() - startedAt) / 3_600_000, 1 / 60);
  let messages = 0;
  let bytes = 0;
  const live = [];

  for (const r of recorders) {
    messages += r.stats.messages;
    bytes += r.stats.bytes;
    // "Live" here means we have seen a message in the last two minutes, which
    // is a usable proxy for the stream being up and chat being active. A
    // channel with no messages is either offline or below the viewer floor
    // where this method works at all.
    if (r.stats.lastMessageAt && Date.now() - r.stats.lastMessageAt < 120_000) {
      live.push(r.channel);
    }
  }

  const mb = bytes / 1e6;
  const perChannelHourMb = live.length ? mb / hours / live.length : 0;

  console.log(
    `[${new Date().toISOString()}] ${live.length}/${recorders.length} active, ` +
    `${messages.toLocaleString()} msgs, ${mb.toFixed(1)} MB, ` +
    `${perChannelHourMb.toFixed(2)} MB per channel-hour, ` +
    `projected ${(perChannelHourMb * 24 * 30 * recorders.length / 1000).toFixed(1)} GB/month`,
  );
}

const beat = setInterval(heartbeat, HEARTBEAT_MS);

function shutdown() {
  clearInterval(beat);
  console.log('\nflushing...');
  let messages = 0;
  for (const r of recorders) messages += r.stop().messages;
  console.log(`recorded ${messages.toLocaleString()} messages across ${recorders.length} channels`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
