# Running the data collection

Day 1 of `docs/PLAN-5DAY.md`. Three commands, in this order, and then the
recorder stays up.

## One-time: Twitch credentials

The chat recorder needs nothing — `src/chat.mjs` reads anonymously. The Helix
calls (discovery and clip harvesting) need an app access token, which needs a
registered application.

**Enable two-factor auth on the Twitch account first.** This is a hard
requirement, not a suggestion: the docs say "You must also enable two-factor
authentication (2FA) for your account", and registration is unavailable without
it. Settings → Security and Privacy. The console needs a refresh afterwards —
the docs note "You'll need to refresh your console for these changes to take
effect."

Then at https://dev.twitch.tv/console/apps:

1. Applications → **Register Your Application**.
2. **Name** — must be unique across every Twitch application, so a generic name
   gets rejected. Something like `overlap-stream-clipper-research` works.
3. **OAuth Redirect URLs** — `https://localhost:3000`, then click **Add**. It must
   be HTTPS: the form rejects `http://` outright, even for localhost. The value is
   never visited, because the client-credentials grant does not redirect, but
   the form requires a well-formed one.
4. **Category** — Application Integration.
5. Captcha, then **Create**.
6. **Manage** on the new app → copy the **Client ID**, then **New Secret** and
   copy that too.

Keep the secret somewhere safe. Generating a new one invalidates the old
immediately: "Getting a new secret invalidates the previous secret, which might
make your API requests fail until you update your app."

Then copy the example file, fill in the two values, and check them:

```bash
cp .env.example .env
```

```bash
node tools/check-auth.mjs
```

That verifies the credentials, the token mint, Helix acceptance and the category
lookup as separate steps, so a failure says which one is wrong. It prints no
token and reports the secret only by length.

No scope is requested anywhere. An app access token cannot read or act on any
user's account; it only reads public endpoints.

## 1. Find the channels

```bash
npm run discover -- --game "Grand Theft Auto VI" --min-viewers 1000 --limit 25
```

Writes `channels.json`. If the category name is wrong, the tool says so; find
the right one with `npm run discover -- --search "grand theft"`.

Re-run it whenever you want: it merges, so a channel that happens to be offline
keeps its place in the list. Set `"record": false` on any channel to skip it.

The viewer floor is not arbitrary. LIGHTOR reports chat-based detection needs
more than roughly 500 messages an hour and more than 100 viewers to work, so
anything much below that is disk spent on data that cannot carry the signal.

## 2. Start recording

```bash
npm run record-all
```

One JSONL file per channel per UTC hour under `data/chat/`. The heartbeat prints
MB per channel-hour and projects monthly disk every minute.

Leave it running. This is the step that cannot be caught up on later: Twitch
removed the public VOD-comments endpoint, so chat for a stream that already
aired cannot be fetched back. Labels can be harvested days late; chat cannot.

To keep it alive across a laptop sleep or a crash, run it under something that
restarts it. The crude version:

```bash
while true; do npm run record-all; sleep 5; done
```

## 3. Harvest the labels, on a lag

```bash
npm run harvest -- --days 3
```

Writes `data/clips/<login>.jsonl`.

Run this at least a day behind the recording, and then **run it again a few days
later**. A clip's `vod_offset` is null for an indeterminate period after
creation — the docs say the delay is "typically minutes long" — and null forever
once the VOD expires. A clip harvested too early has no usable label. The
harvester appends backfilled offsets on a later pass rather than duplicating the
record, and prints how many are still waiting.

## What ends up on disk

```
data/
  chat/
    .salt                        <- never publish this
    stableronaldo/
      20261122-14.jsonl
      20261122-15.jsonl
  clips/
    stableronaldo.jsonl
```

A chat line is `{t, u, x, e, s}`: Twitch's own `tmi-sent-ts`, a salted hash of
the chatter, the message text, the native emote count, and a subscriber flag.
A line with a `_` key is an audit record (`open`, `reconnecting`, `error`,
`close`) rather than a message — these are in the data stream on purpose, so a
gap caused by us disconnecting is visible rather than looking like chat going
quiet.

There is no login and no raw user id in the file. The features need unique
chatter *counts*, not identities, so the identities are not kept. That is also
what makes the eventual benchmark shareable.

`.salt` has to stay put and stay private: regenerate it and one chatter becomes
two either side of the restart, which silently inflates every uniqueness
feature; publish it next to the hashes and they become reversible for any login
someone cares to guess.

## Checking it is working

```bash
# messages recorded in the current hour, per channel
for d in data/chat/*/; do printf '%s %s\n' "$(wc -l < "$d$(ls -t "$d" | head -1)")" "$d"; done

# how many harvested clips actually have a usable label
cat data/clips/*.jsonl | node -e 'let n=0,o=0;require("readline").createInterface({input:process.stdin}).on("line",l=>{if(!l.trim())return;n++;if(JSON.parse(l).vodOffset!==null)o++}).on("close",()=>console.log(o+"/"+n+" with an offset"))'
```

## Re-running the pipeline after more recording

One command, in dependency order:

```
npm run refresh
```

That is `live-windows` (fetch each channel's broadcast intervals), `harvest
--days 3` (clip labels, which also backfills `vod_offset` on clips harvested
too early), `build-dataset`, `evaluate`. Each step fails loudly rather than
leaving a stale file behind, and `npm run weights` afterwards prints what the
fit leaned on.

**Re-run it on a lag.** A clip's `vod_offset` is null for an indeterminate
period after creation and null forever once the VOD expires, so a harvest run
too early simply has no label for that moment. Running it daily for a few days
picks up what the previous pass could not see — the 2026-11-25 pass backfilled
48 offsets that the 10:07 pass had missed.

**Do not stop the recorder to do any of this.** Twitch removed the public
VOD-comments endpoint, so chat for a stream that has already aired is
unrecoverable. Labels can arrive late; features cannot arrive at all. Every
tool above reads from `data/` and none of them touch the recorder.

**What will not survive.** Idle sleep is held off while a Claude session is
active, but a closed lid or a manual Sleep still sleeps the machine, and the
recorder dies with it. The gap shows up in `data/chat/<channel>/` as a missing
hour file, and `readRange` reports it in `missingHours` so a gap is visible
rather than silently read as a quiet stream.
