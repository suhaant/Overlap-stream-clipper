#!/usr/bin/env node
/**
 * Verify the Twitch credentials work, before spending a day on a harvest that
 * was going to fail on the first request.
 *
 *   node tools/check-auth.mjs
 *
 * Checks four things in order, and stops at the first that fails:
 *   1. credentials are present
 *   2. they mint an app access token
 *   3. the token is accepted by Helix
 *   4. the GTA 6 category resolves and somebody is live in it
 *
 * Prints nothing that should not be pasted into a bug report: the token is
 * never shown and the secret is reported only as present or absent.
 */

import { loadEnv } from '../src/env.mjs';
import { appToken, resetToken } from '../src/twitch-api.mjs';
import { getGameByName, getStreamsByGame } from '../src/twitch-endpoints.mjs';

loadEnv();

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

async function main() {
  console.log('checking Twitch credentials\n');

  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;

  if (!id || !secret) {
    bad('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are not both set');
    console.log('\n  cp .env.example .env, then fill it in from');
    console.log('  https://dev.twitch.tv/console/apps');
    process.exit(1);
  }
  // Enough to tell two client ids apart in a screenshot, not enough to use.
  ok(`client id present (${id.slice(0, 6)}...${id.slice(-4)}, ${id.length} chars)`);
  ok(`client secret present (${secret.length} chars)`);

  resetToken();
  let token;
  try {
    token = await appToken();
    ok('minted an app access token');
  } catch (e) {
    bad(e.message);
    console.log('\n  A 400 or 403 here almost always means one of:');
    console.log('   - the secret was regenerated, which invalidates the old one');
    console.log('   - the id and secret are from different applications');
    console.log('   - a stray space or quote got copied into .env');
    process.exit(1);
  }
  if (!token || token.length < 10) { bad('token looks malformed'); process.exit(1); }

  let game;
  try {
    game = await getGameByName('Grand Theft Auto VI');
    ok('Helix accepted the token');
  } catch (e) {
    bad(`Helix rejected the request: ${e.message}`);
    process.exit(1);
  }

  if (!game) {
    bad('no category named exactly "Grand Theft Auto VI"');
    console.log('\n  find the right name: node tools/discover-channels.mjs --search "grand theft"');
    process.exit(1);
  }
  ok(`category resolved: ${game.name} (id ${game.id})`);

  const live = await getStreamsByGame({ gameId: game.id, minViewers: 1000, limit: 25 });
  if (!live.length) {
    console.log(`  note  nobody is live in ${game.name} above 1000 viewers right now`);
    console.log('        the credentials are fine; try a lower --min-viewers or come back later');
  } else {
    ok(`${live.length} channels live above 1000 viewers`);
    const top = live.slice(0, 5);
    console.log('');
    for (const s of top) {
      console.log(`        ${String(s.viewerCount).padStart(7)}  ${s.login}`);
    }
  }

  console.log('\nready. next: npm run discover -- --game "Grand Theft Auto VI"');
}

main().catch(e => { bad(e.message); process.exit(1); });
