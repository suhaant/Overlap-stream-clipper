# Scope

## The task, stated so it can be scored

Given only Twitch chat up to time *t*, with no access to anything after *t*,
emit a score for second *t* that estimates whether a human viewer would have
pressed the clip button on this moment.

Three parts of that sentence are load-bearing.

**"only chat"** is a constraint, not a belief that chat is sufficient. It is
chosen because chat is free, text-sized, language-agnostic and available the
instant a stream starts, and because it isolates the variable: if a
chat-only model beats a production tool that also reads audio and video, the
result means something. Video and audio features join later, as an ablation
that has to earn its compute.

**"no access to anything after t"** is the part that separates this from the
prior work in `docs/RESEARCH.md`. Every published chat method peak-picks over a
finished video. Online means the peak is not knowable at decision time.

**"would have pressed the clip button"** is the label, and it is chosen because
it is the only clip-worthiness signal that exists in volume, for free, with a
timestamp. It is not the same thing as "is clip-worthy" and the difference is
discussed under label noise below.

## Labels

`GET https://api.twitch.tv/helix/clips` returns, per clip:

    vod_offset   "The zero-based offset, in seconds, to where the clip starts
                  in the video (VOD). Is null if the video is not available or
                  hasn't been created yet from the live stream."

That is a human-pressed timestamp. Positives are the seconds people clipped.
Negatives are every other second of the same stream, which is where the useful
negatives live: the raid, the sub train, the drama, every moment that spikes
message volume without being worth posting.

`view_count` on the clip gives a free quality weight. "Someone clipped it" and
"someone clipped it and it got 400k views" are different strengths of the same
label, and the API returns results sorted by view count descending.

Auth is an app access token with no scope. There is no documented lookback
limit, but pagination caps at roughly 1,000 results per query, so harvesting
goes window by window over `started_at`/`ended_at`.

### Why the data has to be recorded forward

The labels are retrospective but the features are not recoverable. Twitch
removed the public VOD-comments endpoint, so for a stream that aired last week
there is no supported way to get its chat back. `src/chat.mjs` reads live chat
only.

So the loop is: record chat live, wait for the VOD and its clips to appear, then
ask the API what people clipped and align backwards. Labels arrive about a day
after the features. No human ever annotates anything.

The consequence worth internalising: **the dataset only accumulates in
wall-clock time.** A day the recorder is not running is a day of data that
cannot be bought or backfilled.

### Label noise, honestly

- People press clip for in-jokes, accidents and to save a URL for later.
- Big channels get more clips per minute regardless of content quality, so a
  raw model learns to detect audience size. Normalise per channel.
- Clip creation is itself partly chat-driven: chat says "CLIP IT" and people
  do. That makes chat and the label correlated through a path that is not
  "something happened on screen". This inflates apparent performance and cannot
  be fully removed. It can be measured by holding out the explicit
  clip-requesting messages as a feature and checking how much performance
  depends on them.
- `vod_offset` is null during an indeterminate delay after creation, "typically
  minutes long", and null whenever the VOD is gone. Harvest on a lag and drop
  nulls.

## Metric

Precision@6 per stream-hour, tolerance +/- 3 seconds, split held out by
channel.

- **Precision@k, not AUC.** The product ships on the order of six clips an
  hour. Whether second 1,847 of a four-hour stream is correctly scored 0.02 is
  irrelevant. Only the ranking at the very top matters.
- **k = 6** because that is roughly the posting rate a clipping campaign
  sustains. Report k = 3 and k = 12 as well.
- **+/- 3 seconds** because a detection three seconds early still produces the
  right clip once `preRollMs` is applied. Exact-second equality would measure
  nothing useful.
- **Held out by channel, never by second.** Random second-level splits leak the
  same moment into train and test through overlapping windows and produce a
  beautiful meaningless number.
- Secondary: recall of clips above a view-count threshold, which asks whether
  the *good* moments were found rather than any moment.

## Baselines, in order of how embarrassing it is to lose to them

1. **Message rate z-score.** Pure velocity. This is what ClipSpeed's public
   description amounts to ("chat-velocity spikes") and what NeonClipping ships
   for free. If the model cannot beat this, there is no project.
2. **The current heuristic**, `src/detector.mjs` at its tuned thresholds. The
   thing this replaces.
3. **LIGHTOR reimplemented**: message count, mean message length, bag-of-words
   similarity to a one-cluster k-means centre, over 25s windows, logistic
   regression. The published method, and the real bar.
4. **Audio energy**, if time allows. Not chat, but it is the competing signal
   and a streamer screams far more often than something clip-worthy happens, so
   it should have poor precision by construction. Worth proving rather than
   asserting.

## Out of scope

Not building: a clipping product, a posting scheduler, a hosted API, anything
touching payments, or vision features. Not competing with the five products in
`docs/RESEARCH.md`.

The deliverable is a number on a held-out set, a benchmark other people can
score against, and the recorder that keeps producing both.

## How it could be wrong

Written down in advance so it cannot be rationalised later.

- Chat-only may plateau below the heuristic once the heuristic is tuned on the
  same data. That would be a real result and worth publishing.
- Clip-button labels may be too noisy to learn from at the second level, in
  which case the unit becomes a 10-second bucket and the metric loosens.
- If performance turns out to rest mostly on explicit "clip it" messages, the
  model is detecting chat telling itself to clip, not moments. Measurable, and
  it would sink the claim.
