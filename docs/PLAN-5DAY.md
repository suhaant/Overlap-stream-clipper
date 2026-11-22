# Five days

Ordered by dependency, not by interest. Day 1 is the least interesting work in
the project and everything else is blocked on it, because the dataset only
accrues in wall-clock time and every hour the recorder is not running is an
hour of GTA 6 launch-window chat that cannot be recovered.

Each bullet is roughly one commit.

## Day 1 — the data spine

Nothing can be learned until chat is on disk and clips can be fetched.

- `src/twitch-api.mjs`: client-credentials app token, cached and refreshed on
  401. No user scope needed.
- Helix request helper: pagination by cursor, 429 backoff honouring
  `Ratelimit-Reset`.
- `getClips({ broadcasterId, startedAt, endedAt })`, windowed to stay under the
  ~1,000-result pagination cap.
- `getVideos({ userId, type: 'archive' })` plus a parser for the `1h0m5s`
  duration string, which the API returns as text and not seconds.
- `getUsers` to resolve channel logins to broadcaster ids.
- `tools/harvest-clips.mjs`: a channel list in, one JSONL file of clips out,
  idempotent so it can be re-run without duplicating.
- `src/recorder.mjs`: wraps `src/chat.mjs`, writes newline-delimited JSON per
  channel per hour, flushed on an interval so a crash loses seconds not hours.
- Reconnect with backoff, and a `PART`/`JOIN` audit line so gaps in the record
  are visible rather than silent.
- `tools/record-all.mjs`: supervise N channels, restart a dead one, log a
  heartbeat.
- `channels.json`: the GTA 6 channel list, with a note on why each is in it.
- Disk accounting: measure bytes per channel-hour and write the projection into
  the file, so a month of recording does not become a surprise.
- Tests: token refresh on 401, pagination termination, duration parsing,
  JSONL round-trip.
- Start the recorder. From here it runs continuously.

## Day 2 — alignment and features

- Verify empirically that a VOD's `created_at` plus `vod_offset` lands where the
  chat says it should. The docs do not state that `created_at` is the stream
  start, so this is an assumption that has to be tested, on a stream where a
  known clip exists.
- `src/align.mjs`: clip `vod_offset` to wall-clock, then to an index into the
  recorded chat for that channel.
- Second-level resampling: chat messages to a per-second grid, gaps marked
  missing rather than zero, because no data and no chat are different.
- `src/features.mjs`: pull the window maths out of `detector.mjs` so the
  detector and the model compute features from one implementation and cannot
  drift. Same reason `src/lexicon.mjs` exists.
- Feature set per window: message rate, unique chatters, convergence,
  type-token ratio, mean message length, emote density, caps ratio, share of
  the top repeated token, fraction of messages that are emote-only.
- Trailing context: each feature at 4s, 10s, 30s and its delta, so the model
  sees shape over time and not one instant.
- Per-channel normalisation against the rolling median/MAD baseline already in
  `detector.mjs`, so an 86-message spike means something different on a 2k
  channel than on a 200k one.
- An explicit `clip_request` feature counting "clip it"-type messages, kept
  separate so its contribution can be measured and, if it dominates, reported.
- `tools/build-dataset.mjs`: recorded chat plus harvested clips to a flat
  feature table with labels and a channel column.
- Tests on features, with a fixture that models varied text rather than one
  repeated string. The old fixture lied this way once already.

## Day 3 — the eval harness and the baselines

The harness comes before the model so there is no opportunity to tune against
the test set by accident.

- `src/eval.mjs`: precision@k with +/- 3s tolerance, non-maximum suppression so
  one eruption cannot claim six hits.
- Channel-held-out and time-held-out splits. Report both; time-held-out is the
  honest one for a launch window where the game itself is changing.
- Baseline 1: message-rate z-score.
- Baseline 2: the current `detector.mjs` thresholds, unchanged.
- Baseline 3: LIGHTOR reimplemented. 25s windows, three features, logistic
  regression. The published bar.
- A results table written by script, not by hand, so it cannot drift from the
  code.
- Confidence intervals by bootstrap over channels. With a handful of channels
  the intervals will be wide, and that is the point of showing them.

## Day 4 — the model

- Gradient boosting over the windowed features. Not a transformer: a few
  thousand positives does not support one, and feature importances are the
  thing worth reading this week.
- Enforce causality in code, not by convention: a test that asserts no feature
  at time t reads a message with a timestamp after t.
- Score calibration, then peak-picking with a refractory period, reusing the
  hysteresis idea in `detector.mjs`.
- Ablations by feature group: convergence only, rate only, lexicon only, all.
  This is the experiment that answers whether convergence actually carries the
  signal or whether rate was doing the work the whole time.
- Measure the reaction lag from the data instead of assuming it. The 3.5s in
  `detector.mjs` versus LIGHTOR's 23-27s is an open conflict and this is where
  it gets settled.
- Per-channel calibration, and a check on whether a channel the model has never
  seen degrades gracefully.
- If precision@6 does not beat the velocity baseline, stop and write that down.

## Day 5 — online inference and the writeup

- `src/score.mjs`: load the model, score a live window, same interface the
  detector exposes so `watch.mjs` changes in one place.
- Wire it into `watch.mjs` behind a flag so the heuristic stays runnable for
  comparison.
- Measure decision latency end to end: message arrival to score.
- Run it live on a stream and record what it fires on, alongside the heuristic,
  for a qualitative diff.
- `docs/RESULTS.md`: the table, the ablations, the lag finding, the intervals.
- Honest limitations section, written against `docs/SCOPE.md`'s "how it could be
  wrong" so the predictions get graded.
- `tools/export-benchmark.mjs`: the held-out set as timestamps and labels with
  no chat text, which is shareable without redistributing user messages.

## Not in these five days

Vision or audio features, a hosted API, anything multi-game beyond what the
channel list happens to cover, and any claim about beating a commercial product
that has not been run on this test set.

## The one thing that must happen today

The recorder starts. Everything after Day 1 can slip; recording cannot, because
it is the only step whose input disappears if it is not taken.
