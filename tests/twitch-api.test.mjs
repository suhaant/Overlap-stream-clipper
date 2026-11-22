import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set before importing anything that reads them. These are not real
// credentials; the fake fetch below never leaves the process.
process.env.TWITCH_CLIENT_ID = 'test-client-id';
process.env.TWITCH_CLIENT_SECRET = 'test-client-secret';

const { appToken, resetToken, helix, helixUrl, paginate } =
  await import('../src/twitch-api.mjs');
const { parseDuration, harvestClips } = await import('../src/twitch-endpoints.mjs');

/** Minimal stand-in for a fetch Response. */
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const tokenReply = (token = 'tok', expiresIn = 5000000) =>
  reply(200, { access_token: token, expires_in: expiresIn });

test('helixUrl drops empty params and repeats array values', () => {
  const url = helixUrl('clips', {
    broadcaster_id: '1', id: ['a', 'b'], after: undefined, started_at: '',
  });
  assert.equal(
    url,
    'https://api.twitch.tv/helix/clips?broadcaster_id=1&id=a&id=b',
  );
});

test('the app token is minted once and reused', async () => {
  resetToken();
  let mints = 0;
  const fetchImpl = async () => { mints++; return tokenReply(); };

  const a = await appToken({ fetchImpl });
  const b = await appToken({ fetchImpl });

  assert.equal(a, 'tok');
  assert.equal(b, 'tok');
  assert.equal(mints, 1, 'second call should have used the cache');
});

test('a token close to expiry is re-minted', async () => {
  resetToken();
  let mints = 0;
  // 30s lifetime is inside the 60s margin, so it is never considered fresh.
  const fetchImpl = async () => { mints++; return tokenReply(`tok${mints}`, 30); };

  await appToken({ fetchImpl });
  await appToken({ fetchImpl });

  assert.equal(mints, 2);
});

test('a 401 refreshes the token and retries exactly once', async () => {
  resetToken();
  const calls = [];
  let unauthorised = true;

  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('oauth2/token')) return tokenReply(`tok${calls.length}`);
    if (unauthorised) { unauthorised = false; return reply(401, { error: 'Unauthorized' }); }
    return reply(200, { data: [{ id: 'ok' }] });
  };

  const json = await helix('users', { login: 'x' }, { fetchImpl });

  assert.deepEqual(json.data, [{ id: 'ok' }]);
  const tokenCalls = calls.filter(u => u.includes('oauth2/token')).length;
  assert.equal(tokenCalls, 2, 'one initial mint plus one forced refresh');
});

test('a repeated 401 gives up instead of looping', async () => {
  resetToken();
  const fetchImpl = async (url) => String(url).includes('oauth2/token')
    ? tokenReply()
    : reply(401, { error: 'Unauthorized' });

  await assert.rejects(
    () => helix('users', {}, { fetchImpl }),
    /failed: 401/,
  );
});

test('a 429 waits for Ratelimit-Reset, which is a unix timestamp', async () => {
  resetToken();
  let limited = true;
  const waits = [];
  const resetAt = Math.floor((Date.now() + 120) / 1000);

  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2/token')) return tokenReply();
    if (limited) {
      limited = false;
      return reply(429, { error: 'Too Many Requests' }, {
        'Ratelimit-Reset': String(resetAt),
      });
    }
    return reply(200, { data: [] });
  };

  await helix('clips', {}, { fetchImpl, onWait: (w) => waits.push(w) });

  assert.equal(waits.length, 1);
  assert.equal(waits[0].status, 429);
  // Interpreting the header as a duration would have produced something
  // astronomical; as a timestamp it is well under the one-minute clamp.
  assert.ok(waits[0].waitMs <= 60_000, `waited ${waits[0].waitMs}ms`);
});

test('a nonsense Ratelimit-Reset falls back to bounded backoff', async () => {
  resetToken();
  let limited = true;
  const waits = [];

  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2/token')) return tokenReply();
    if (limited) {
      limited = false;
      return reply(429, {}, { 'Ratelimit-Reset': 'not-a-number' });
    }
    return reply(200, { data: [] });
  };

  await helix('clips', {}, { fetchImpl, onWait: (w) => waits.push(w) });
  assert.equal(waits.length, 1);
  assert.ok(waits[0].waitMs > 0 && waits[0].waitMs <= 30_000);
});

test('pagination follows the cursor and stops without one', async () => {
  resetToken();
  const pages = [
    { data: [{ id: 1 }], pagination: { cursor: 'c1' } },
    { data: [{ id: 2 }], pagination: { cursor: 'c2' } },
    { data: [{ id: 3 }], pagination: {} },
  ];
  let i = 0;
  const fetchImpl = async (url) => String(url).includes('oauth2/token')
    ? tokenReply()
    : reply(200, pages[i++]);

  const seen = [];
  for await (const page of paginate('clips', {}, { fetchImpl })) seen.push(...page);

  assert.deepEqual(seen.map(r => r.id), [1, 2, 3]);
});

test('pagination stops on an empty page even if a cursor is returned', async () => {
  resetToken();
  let requests = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2/token')) return tokenReply();
    requests++;
    // A cursor forever, no rows ever: the shape that would loop.
    return reply(200, { data: [], pagination: { cursor: 'always' } });
  };

  const seen = [];
  for await (const page of paginate('clips', {}, { fetchImpl })) seen.push(...page);

  assert.equal(seen.length, 0);
  assert.equal(requests, 1, 'should not have asked for a second empty page');
});

test('parseDuration handles omitted units and rejects junk', () => {
  assert.equal(parseDuration('3m21s'), 201);
  assert.equal(parseDuration('1h0m5s'), 3605);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('garbage'), null);
  assert.equal(parseDuration('1x'), null);
  assert.equal(parseDuration(undefined), null);
});

test('harvestClips windows the range and drops duplicates across windows', async () => {
  resetToken();
  const windows = [];
  // The same clip in two adjacent windows, which happens because the API
  // truncates the range to the minute.
  const byWindow = [
    [{ id: 'a', vod_offset: 10 }, { id: 'b', vod_offset: 20 }],
    [{ id: 'b', vod_offset: 20 }, { id: 'c', vod_offset: 30 }],
  ];
  let call = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2/token')) return tokenReply();
    return reply(200, { data: byWindow[call++] ?? [], pagination: {} });
  };

  const got = [];
  for await (const batch of harvestClips({
    broadcasterId: '1',
    from: '2026-11-20T00:00:00Z',
    to: '2026-11-20T12:00:00Z',
    windowHours: 6,
    onWindow: (w) => windows.push(w),
  }, { fetchImpl })) got.push(...batch);

  assert.deepEqual(got.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(windows.filter(w => !w.atCap).length, 2, 'two six-hour windows');
});

test('harvestClips rejects an unparseable range', async () => {
  await assert.rejects(
    async () => {
      for await (const _ of harvestClips({ broadcasterId: '1', from: 'nope', to: 'also nope' })) break;
    },
    /unparseable range/,
  );
});
