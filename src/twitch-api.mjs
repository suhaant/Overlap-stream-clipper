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
