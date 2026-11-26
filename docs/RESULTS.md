# Predicting clip-worthy moments from Twitch chat alone

Five days of work on one question: **can chat alone tell you when something
clip-worthy just happened, without looking at the video?**

Short answer: yes, measurably, but weakly — and the useful part is knowing
exactly how weakly and why.

Everything here is reproducible from this repository. `npm run evaluate`
regenerates every number.

---

## Setup

| | |
|---|---|
| Chat recorded | 25 channels, continuous, ~282 stream-hours |
| Scored windows | 118,244 |
| Channels evaluated | 20 (those with enough labelled moments) |
| Labels | the Twitch clip button — `vod_offset` from `GET /helix/clips` |
| Validation | leave-one-channel-out; a channel is never scored by a model fitted on it |
| Intervals | bootstrap over channels, 95% |
| Dependencies | none; Node 22 built-ins only |

**Why record forward rather than mine history.** Twitch removed the public
VOD-comments endpoint, so chat for an already-aired stream is unrecoverable.
Labels can arrive late; features cannot. Every hour of data here had to be
captured live as it happened.

**Why the clip button.** It is a free, timestamped, human judgement of "this
is worth keeping", made by the audience in real time, on footage nobody was
paid to review. Press counts also give a natural weight: a moment twenty
people clipped is a stronger example than one person's.

---

## Results

Two labellings, because they answer different questions and reporting only
one would be a choice about which story to tell.

```
                    find the TOP 6/hour          find ANY clipped moment
scorer             precision      95% CI       precision      95% CI
-------------------------------------------------------------------------
random                 0.076  [0.06, 0.10]         0.240  [0.20, 0.29]
constant               0.094  [0.06, 0.14]         0.214  [0.16, 0.28]
velocity               0.118  [0.08, 0.17]         0.305  [0.23, 0.39]
chatterVelocity        0.124  [0.08, 0.17]         0.325  [0.25, 0.41]
convergenceOnly        0.090  [0.06, 0.12]         0.271  [0.21, 0.34]
LIGHTOR (prior work)   0.101  [0.07, 0.14]         0.252  [0.19, 0.32]
hand-written rule      0.130  [0.09, 0.19]         0.353  [0.28, 0.43]
logreg, words only     0.111  [0.08, 0.15]         0.305  [0.23, 0.38]
logreg, rates          0.134  [0.09, 0.18]         0.343  [0.26, 0.43]
logreg, rates+shape    0.141  [0.10, 0.19]         0.347  [0.27, 0.42]
online detector        0.165  [0.11, 0.23]         0.381  [0.29, 0.47]
-------------------------------------------------------------------------
chance                 0.041                       0.251
```

**Read it as:** roughly **2.2× chance** at finding the best six moments of an
hour, **1.6× chance** at finding any moment somebody clipped. Both are real.
The first is the harder and more useful question — nobody wants every moment
anyone ever clipped — and it is far more discriminating, since the second
leaves only 0.75 of headroom above a 0.25 floor.

**Two baselines exist to make the headline honest.** `random` is a measured
floor, not an assumed one. `constant` scores every window identically, so
peak-picking falls back to time order and it fires earliest-first — it catches
any scorer that wins by firing early rather than by being right. Beating both
is the bar.

**The model does not clearly beat the hand-written rule.** 0.141 against
0.130, intervals almost entirely overlapping, in both labellings. Stated
plainly because it is true: the machine learning has not yet earned its place
over a good heuristic.

---

## What the signal actually is

Not vocabulary. Matching chat against KEKW / LOL / POG is the obvious
implementation and it is measurably worse — `logreg, words only` scores 0.111
against 0.134 for ignoring words entirely.

What works is **convergence**: many people typing the same short thing at the
same instant, regardless of what it is.

| window | repetition | lexicon match | truth |
|---|---:|---:|---|
| 86 people typing `heist` | **0.877** | 0.008 | real moment |
| `NOOO / SAJ / SAJ` | **0.521** | 0.125 | real moment |
| `@M0hamdQ LOL / ciao bello / mhm` | 0.250 | **0.500** | conversation |

A lexicon only catches reactions whose words you anticipated, and above it
ranked pure conversation over the best moment in the run. Convergence has
three properties that matter commercially:

- **No per-game tuning.** GTA 6 slang, Valorant slang, whatever ships next.
- **Language independent.** Works unchanged on Spanish and Russian chat.
- **Not spoofable by one actor.** It counts unique chatters converging, so a
  spammer or a bot farm moves nothing.

---

## Running live

Offline peak-picking sorts the whole hour and takes the best windows. That is
a fair way to measure a scorer and an impossible way to run one — it needs the
end of the hour to rank the beginning. The live detector is separate code:
cross a threshold to arm, track the maximum for up to 8s, commit at the peak,
then suppress for 45s.

```
compute per channel-second    0.221 ms    (busiest channel, 158 msg/min)
channels per core             ~4,500
decision latency              p50 3.0s   p90 8.0s   max 8.0s (hard bound)
```

The latency is bounded by the settle window by construction, not empirically.
Clips are cut retroactively from a rolling buffer, so waiting for the peak
costs nothing but the wait.

**This is the number with commercial weight.** Chat-only detection is cheap
enough to run on every live channel simultaneously. Nothing that decodes video
is.

**Live, you cannot seek backwards.** By the time chat has spiked and been
measured the moment is 20–30s in the past and has left the live HLS playlist.
The stream must be continuously recorded into a ring of short segments and the
moment cut out of that ring afterwards. This is the structural reason "clip
from the VOD later" and "clip it live" are different products.

**Chat reacts 3–5s after the event** — encode, network, human reaction time.
Clip from the chat peak and you land on the laughter and miss the joke.

---

## Held-out live run

80 minutes on a 49,000-viewer channel the model had never seen, both detectors
on one shared chat connection, scored afterwards against the clip button.

```
                fires   hit   precision   real moments caught
model               5     2       0.400         2 of 28
hand-written        9     4       0.444         4 of 28
```

Both detectors independently found the same moments within **0.1–2.0 seconds**
of each other. A second process on its own chat connection found one of them
1.9s from the first, which is the measurement noise floor for this kind of
comparison.

**Recall is the real weakness.** 28 moments happened; the better detector
caught 4. Among those missed was the most-viewed clip of the hour (16
independent presses, 122 views). The system is tuned far too conservatively,
and that is a dial, not a wall.

---

## What I got wrong

Four errors found and corrected during the work. They are listed because the
corrections are the part I would most want checked.

**1. The chance rate was computed against wall-clock hours** rather than
windows that could actually be picked. It read 2.5% while a scorer that knows
nothing scored 7.3%. Corrected to share of pickable windows, then
cross-validated against a measured random scorer.

**2. The labels were front-loaded.** Qualifying a moment on an absolute press
count meant the bar tracked audience size, not moment quality, and a
clock-only scorer beat chance 2×. Fixed by defining moments relatively — top N
per block of equal pickable time.

**3. A precision ceiling I derived was an artifact of my own label cap.** I
argued a perfect detector could not exceed 0.416 because it fires more often
than moments occur. The event count I used was capped at 6/hour by the
labelling. Uncapped the rate is 9.40/hour against 2.28 capped. The detector
*under*-fires. The ceiling never bound, and everything inferred from it was
withdrawn.

**4. Two headline numbers were artifacts of the test harness**, not the
system. Maximum decision latency of 18.8s came from replaying message-by-message,
where a quiet stretch has no arrival to close out a pending decision; driven on
a clock as it actually runs, it is bounded at 8.0s. Capacity of ~1,100 channels
per core divided one second by the cost of the most expensive kind of tick;
measured across all ticks it is ~4,500.

---

## Known limitations

- **Recall is low.** ~25% of clipped moments in the benchmark, worse live.
- **It cannot read.** The shipped features are volume and shape only, so chat
  arguing (`YES / No / Wait`) is indistinguishable from chat laughing. Word
  features were tested and made things worse against this label set.
- **It cannot know whether the moment was visible.** Chat may be reacting to
  something said rather than shown. Nothing in the signal distinguishes these.
- **20 channels, ~282 hours, one game.** Mostly GTA VI. Generalisation across
  genres is untested.
- **The clip button is a proxy.** It measures "a viewer thought this was worth
  keeping", not "this clip will perform". Those can differ.
- **Twitch's clips API is unreliable for counting.** It sorts by view count and
  its time-window filtering is inconsistent between calls. Press rates quoted
  from it are approximate.

---

## Reproducing

```bash
npm test                 # 77 tests
npm run build-dataset    # chat + labels -> feature rows
npm run evaluate         # the table above
npm run train            # fit and calibrate the live detector
npm run measure-latency  # the timing numbers
npm run ceiling          # fire budget against real moment supply
```

`exports/benchmark-*.json` contains the held-out windows as timestamps,
features and labels with **no chat text**, so the result can be checked
without redistributing anyone's messages.
