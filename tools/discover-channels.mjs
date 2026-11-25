#!/usr/bin/env node
/**
 * Find the channels worth recording and write them to channels.json.
 *
 * Usage:
 *   node tools/discover-channels.mjs --game "Grand Theft Auto VI"
 *   node tools/discover-channels.mjs --game "..." --min-viewers 2000 --limit 20
 *   node tools/discover-channels.mjs --search "grand theft"
 *
 * Run it again whenever the roster changes. It merges rather than replaces, so
 * a channel that happens to be offline right now is not dropped from the list.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadEnv } from '../src/env.mjs';
import { getGameByName, searchCategories, getStreamsByGame } from '../src/twitch-endpoints.mjs';

loadEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = flag('out', 'channels.json');

async function main() {
  const search = flag('search');
  if (search) {
    const found = await searchCategories(search);
    if (!found.length) { console.log(`no categories matching ${JSON.stringify(search)}`); return; }
    console.log('categories:');
    for (const g of found) console.log(`  ${g.id}\t${g.name}`);
    console.log('\nre-run with --game "<exact name>"');
    return;
  }

  const gameName = flag('game', 'Grand Theft Auto VI');
  const minViewers = Number(flag('min-viewers', 1000));
  const limit = Number(flag('limit', 25));

  const game = await getGameByName(gameName);
  if (!game) {
    console.error(`no category named ${JSON.stringify(gameName)}.`);
    console.error('Try: node tools/discover-channels.mjs --search "grand theft"');
    process.exit(1);
  }

  const live = await getStreamsByGame({ gameId: game.id, minViewers, limit });
  console.log(`${game.name} (${game.id}): ${live.length} live channels at >=${minViewers} viewers`);

  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { channels: [] };
  const byLogin = new Map((prior.channels ?? []).map(c => [c.login, c]));

  for (const s of live) {
    const existing = byLogin.get(s.login) ?? {};
    byLogin.set(s.login, {
      ...existing,
      login: s.login,
      userId: s.userId,
      // Peak observed viewers, not current: the point is whether this channel
      // has ever been big enough to carry the signal, and a mid-session dip
      // should not knock it off the list.
      peakViewers: Math.max(existing.peakViewers ?? 0, s.viewerCount),
      lastSeenLive: new Date().toISOString(),
      lastSeenGame: s.gameName,
      // Kept so the corpus can be split by language later. The claim that
      // convergence is language-independent is testable only if the data
      // spans languages, and this roster happens to.
      language: s.language,
      record: existing.record ?? true,
    });
  }

  const channels = [...byLogin.values()].sort((a, b) => b.peakViewers - a.peakViewers);
  writeFileSync(OUT, JSON.stringify({
    note: 'Discovered by tools/discover-channels.mjs. Set record:false to skip one.',
    game: game.name,
    gameId: game.id,
    updatedAt: new Date().toISOString(),
    channels,
  }, null, 2) + '\n');

  console.log(`wrote ${channels.length} channels to ${OUT}`);
  for (const c of channels.slice(0, 15)) {
    console.log(`  ${String(c.peakViewers).padStart(7)}  ${c.login}${c.record ? '' : '  (skipped)'}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
