/**
 * Twitch Helix client.
 *
 * Only the read endpoints this project needs, and deliberately no dependency on
 * an SDK: the whole surface is three endpoints and a token, and a dependency
 * here would be the only one in the repo.
 *
 * Auth is the client-credentials grant, which yields an *app* access token.
 * Get Clips, Get Videos and Get Users all accept one and require no scope, so
 * nothing here ever touches a user's account or asks them to authorise
 * anything.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const HELIX = 'https://api.twitch.tv/helix';

/**
 * Read credentials at call time rather than at import time, so a process that
 * never makes a request (a test, say) does not need them set.
 */
export function credentials() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set. ' +
      'Register an application at https://dev.twitch.tv/console/apps to get them.',
    );
  }
  return { clientId, clientSecret };
}

// Module-level cache. One token serves every request in the process, and Twitch
// hands out app tokens with a ~60 day lifetime, so refreshing is rare.
let cached = null;

/** Seconds of slack before stated expiry, so a long request cannot straddle it. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * An app access token, minted on first use and reused until it is close to
 * expiring. `force` discards the cache, which is what a 401 should do: a token
 * can be revoked server-side well before its stated expiry.
 */
export async function appToken({ force = false, fetchImpl = fetch } = {}) {
  if (!force && cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Deliberately does not echo the body: a failed token request can quote the
    // client_id back, and this error is likely to end up in a log.
    throw new Error(`twitch token request failed: ${res.status}`);
  }

  const json = await res.json();
  if (!json.access_token) throw new Error('twitch token response had no access_token');

  cached = {
    token: json.access_token,
    // expires_in is seconds. Treat a missing value as one hour rather than
    // trusting it forever.
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

/** Drop the cached token. Exported for tests and for an explicit re-auth. */
export function resetToken() { cached = null; }

/** Build a Helix URL, dropping undefined params and repeating array values. */
export function helixUrl(path, params = {}) {
  const url = new URL(`${HELIX}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    // Helix takes repeated keys for multi-valued params (id=a&id=b), never a
    // comma-joined list.
    for (const v of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(v));
    }
  }
  return url.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Helix request, with the two failures that actually happen in a long
 * harvest run handled in one place.
 *
 * 401: the token was revoked or expired early. Mint a new one and retry once.
 * Retrying more than once would mean the credentials themselves are wrong, and
 * hammering that is how a client id gets throttled.
 *
 * 429: Twitch uses a token bucket per client id and returns `Ratelimit-Reset`
 * as a UNIX timestamp in SECONDS. Waiting until that moment is both correct and
 * cheaper than guessing with exponential backoff, which is why the header is
 * preferred over the fallback.
 */
export async function helix(path, params = {}, {
  fetchImpl = fetch, maxRetries = 5, onWait = () => {},
} = {}) {
  let authRetried = false;

  for (let attempt = 0; ; attempt++) {
    const token = await appToken({ fetchImpl });
    const res = await fetchImpl(helixUrl(path, params), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': credentials().clientId,
      },
    });

    if (res.ok) return res.json();

    if (res.status === 401 && !authRetried) {
      authRetried = true;
      await appToken({ force: true, fetchImpl });
      continue;
    }

    if (res.status === 429 && attempt < maxRetries) {
      const reset = Number(res.headers.get('Ratelimit-Reset'));
      // The header is seconds-since-epoch, not a duration. Clamp so a stale or
      // malformed value cannot park the process for an hour.
      const waitMs = Number.isFinite(reset) && reset > 0
        ? Math.min(Math.max(reset * 1000 - Date.now(), 0), 60_000)
        : Math.min(1000 * 2 ** attempt, 30_000);
      onWait({ status: 429, waitMs, attempt });
      await sleep(waitMs + 250);
      continue;
    }

    if (res.status >= 500 && attempt < maxRetries) {
      const waitMs = Math.min(1000 * 2 ** attempt, 30_000);
      onWait({ status: res.status, waitMs, attempt });
      await sleep(waitMs);
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`helix ${path} failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Walk a cursor-paginated endpoint, yielding one page of `data` at a time.
 *
 * Stops when the response carries no cursor, and also when a page comes back
 * empty: an endpoint that returns a cursor alongside zero rows would otherwise
 * loop forever.
 *
 * `maxPages` exists because Get Clips caps total results at roughly 1,000
 * however far you page, so an unbounded walk is always a bug.
 */
export async function* paginate(path, params = {}, { maxPages = 10, ...opts } = {}) {
  let after;
  for (let page = 0; page < maxPages; page++) {
    const json = await helix(path, { ...params, after }, opts);
    const rows = json.data ?? [];
    if (rows.length) yield rows;
    after = json.pagination?.cursor;
    if (!after || !rows.length) return;
  }
}

/** Every row from a paginated endpoint, flattened. */
export async function collect(path, params = {}, opts = {}) {
  const out = [];
  for await (const page of paginate(path, params, opts)) out.push(...page);
  return out;
}
