# Findings

A running log, newest last. `docs/SCOPE.md` wrote down in advance how this
could fail; this is where those predictions get graded.

## 25 Nov — alignment confirmed

`vod.created_at + vod_offset` really is wall-clock. Measured over 173 clips
and 12 VODs: clips pressed during the live stream land in a three-second band,
median -5s, and not one fell before -30s. A wrong assumption would have given
noise. The -5s is the delay between the live edge a viewer watches and the VOD
timeline, and it is now subtracted in `src/align.mjs`.

Side effect worth having: 88% of clips are pressed while the stream is live and
the rest are someone browsing a VOD hours or days later. One in that sample was
19 days after the fact. They are a different kind of judgement and are excluded.

## 25 Nov — convergence was measuring the wrong thing

Two bugs, both found by running the existing maths over real recorded chat.

**Within-message repetition.** A single chatter posting
`GOLD GOLD GOLDGOLD GOLD GOLD` scored 0.950 on the old message-level measure.
Convergence is meant to mean "many people said the same thing"; the old version
meant "the same thing was said many times", which is what one spammer produces.
Computing over one representative message per chatter takes that case to 0.000
and leaves 86 people typing "heist" at 0.988. On 90 minutes of real chat the
correction reaches 0.345.

**Bot commands, which was the bigger problem.** 36.6% of all messages in that
sample were bang-prefixed. `!rested` alone appeared 9,801 times from 5,456
distinct chatters, and the three highest-convergence windows in the entire
sample were command sprees scoring 0.96 — higher than any real moment. A
command spree is indistinguishable from a mass reaction by every measure in
`src/features.mjs`: hundreds of distinct people, short identical text, total
agreement. Unfiltered, the model would have learned to detect channel-point
commands.

With both fixed, the top-scoring windows are 149 people typing "me" when the
streamer asked who owns a PS5, and a genuine burst of "LOL". The first of those
is a real crowd response that is not a clip-worthy moment, and no amount of
hand-tuning separates it from one. That is the argument for labels.

## 25 Nov — first signal check

7,047 windows, 186 positive. Univariate means, positive against negative:

| feature | pos | neg | ratio |
| --- | --- | --- | --- |
| chatters (4s) | 17.00 | 13.59 | 1.25 |
| message rate (4s) | 4.39 | 3.49 | 1.26 |
| crowd repetition (4s) | 0.133 | 0.106 | 1.26 |
| crowd diversity (4s) | 0.169 | 0.143 | 1.18 |
| conversational (4s) | 0.120 | 0.158 | **0.76** |
| chatters (30s) | 90.3 | 73.5 | 1.23 |

Every signal moves the way the thesis says it should, including
`conversational` moving the opposite way. The effects are modest and this is
186 positives of univariate means, not a model, so it is encouragement rather
than evidence.

**One pre-registered worry is already answered.** `docs/SCOPE.md` warned that
if performance rested on explicit "clip it" messages, the model would be
detecting chat telling itself to clip rather than detecting moments. Mean
`clipRequest` on positive windows is **0.000**. Whatever the signal is, it is
not that.

**What this does not yet rule out:** that the model is learning audience size.
Chatters and message rate both rise on positives, and bigger moments happen
when more people are watching. Per-channel normalisation and an ablation
holding rate constant come before any claim about convergence specifically.

## 25 Nov — reaction lag, preliminary

**n = 21. Everything here is provisional** and worth re-running once the
recorder has covered a few full streams. It is recorded now because the method
is settled and the direction is already informative.

`tools/measure-lag.mjs`. Chat activity is counted as distinct chatters per
second, commands excluded, smoothed over three seconds, and a peak only counts
if it clears the window's own median by 2.5 MAD-sigma. The first version took
a plain argmax over three minutes and produced a distribution 150 seconds wide
from p10 to p90, which is noise in the shape of an answer.

### The 3.5s versus 23-27s conflict is not a conflict

| distance | measured |
| --- | --- |
| chat peak to press | median **16s** (p25 11, p75 29) |
| clip start to chat peak | median **-3s** (p25 -11, p75 13) |

The second row is the quantity LIGHTOR calls c, and at -3s it says a viewer
begins their clip within a few seconds of where chat peaks. `reactionLagMs:
3500` is not contradicted. LIGHTOR's 23-27s is measuring peak to
*highlight start* on esports VODs, where a highlight is a teamfight with a
run-up, and `docs/RESEARCH.md` suspected they were different distances. They
are.

The distance `reactionLagMs` actually names, from on-screen event to chat
peak, stays unobservable, because nothing records when the event happened.

### The number worth quoting

**A detector firing at the chat peak is 16 seconds ahead of the median human
clipper**, and ahead of three quarters of them by 11 seconds. Not one of the
21 events was pressed more than 10 seconds before its own chat peak.

That is the live-clipping claim stated as a measurement rather than a promise,
and it is measured against human behaviour instead of against a competitor's
marketing page.

### A ceiling, and it is higher than feared

Of 184 clip events inside the recorded span, 157 were on channels too quiet to
measure at all. Of the 27 on channels busy enough to measure, **21 (78%) had a
chat spike** and 6 did not.

That 78% is an upper bound on recall for any chat-only detector: the other 22%
are moments a human clipped and chat did not visibly react to, and no amount
of modelling recovers them from chat alone. It is also the number that says
when vision becomes worth its compute.

The 157 quiet channels are their own finding. Most channels in the roster are
below the viewer threshold where this method works, which matches LIGHTOR's
stated limit of ~500 messages an hour and ~100 viewers.

## 25 Nov — the harness works, the data does not yet support a result

Day 3 built `src/eval.mjs`, five baselines and a LIGHTOR reimplementation.
The honest outcome is that **no baseline can be distinguished from chance
yet**, and finding that out is what the harness is for.

### The first version of the metric measured nothing

Initial run, every clustered clip treated as an event:

| scorer | precision@6/h |
| --- | --- |
| constant | **0.266** |
| velocity | 0.307 |
| currentHeuristic | 0.276 |
| convergenceOnly | 0.255 |

A scorer returning the same number for every window reached 0.266. That is
not a baseline being surprisingly good, it is the metric being broken: at 25
events an hour against a 50-second acceptance window, **35% of the timeline
counts as correct**, so random guessing scores about a third.

### The label definition was the problem

58% of clustered events are a single press, median 2 total views. That is one
person saving a URL, not a moment the audience agreed on. Scoring against them
is wrong on both counts: it inflates event density until the metric cannot
discriminate, and it asks the model to find things nobody watched.

Events now require **at least three independent presses**, which keeps 26% of
them and drops the chance rate from 35% to **7.6%**. The evaluator prints that
figure next to the table, so a result near it cannot be mistaken for a finding.

### Current standing, and it is not a result

With the stricter definition only 3 channels have qualifying events in the
recorded span, 10 events between them. Every confidence interval spans zero to
a quarter. No number from this run should be quoted, including the ones that
happen to look good.

What it does establish: the harness responds correctly to a label definition
changing, the chance rate is computed and displayed, and matching is
asymmetric so a detector firing 20 seconds before the human counts as right.
Nine tests pin that behaviour, including that an oracle scores 1.0, a blind
scorer does not, and one eruption cannot claim six hits.

### What would make it a result

Event rate on a qualifying channel is roughly 6 three-press events an hour. To
get confidence intervals worth printing, something like 200 events across 8 or
more channels, which is on the order of 30 to 40 recorded channel-hours on
channels above the viewer floor. The recorder produces that in a few days, and
only ohnepixel, elajjaz and a handful of others contribute.

## The dataset is front-loaded, and the old chance rate hid it

*2026-11-25, after the second clip harvest*

The harvest caught up with the recorder: 5,487 new clip records, 4,424 of
4,475 earlier ones already carrying a `vod_offset`, 297 still pending. The
dataset went from 7,047 windows on 3 channels to **104,282 windows on 21
channels, 3,518 positive (3.37%), 4,023 clip events**. Fourteen channels now
clear the three-press bar, up from three.

With a readable amount of data, two problems in the harness showed up.

**The chance rate was computed against the wrong denominator.** It divided
event-coverage seconds by wall-clock hours. But a scorer can only pick a
window that exists, and windows exist only where there was chat, so quiet
stretches inflated the denominator and deflated chance. It printed 2.5% while
a constant scorer reached 7.3% — which made every baseline look three times
better than nothing. Now it is the share of *pickable* windows inside an
acceptance window: **4.1%**. A seeded random scorer run through the real
harness, averaged over 20 seeds, measures **0.039**, which agrees. Two
independent routes to the same floor is the reassurance that the fix is right.

**`constant` is not a null baseline, it is a position baseline.** Every score
ties, so peak-picking falls back to row order, which is time order, so it
picks the earliest windows of each stream. That beats noise nearly 2× (0.073
vs 0.039). The reason is in the labels, not the code: **36% of qualifying
events land in the first fifth of each channel's recorded span**, against the
20% an even spread would give. ohnepixel is 18 of 37, bratishkinoff 6 of 9.
The recorder picks channels for being live and busy, so it attaches near a peak
and the stream cools afterwards.

So the bar is `constant`, not `random`. And on that bar:

| scorer | precision | 95% CI | recall |
|---|---|---|---|
| random | 0.039 | [0.03, 0.06] | 0.222 |
| constant (position) | 0.073 | [0.03, 0.12] | 0.311 |
| velocity | 0.080 | [0.04, 0.13] | 0.320 |
| chatterVelocity | 0.079 | [0.04, 0.13] | 0.435 |
| currentHeuristic | 0.072 | [0.04, 0.12] | 0.328 |
| convergenceOnly | 0.052 | [0.02, 0.09] | 0.197 |
| lightor | 0.048 | [0.02, 0.08] | 0.259 |

**Nothing beats guessing early.** The three rate-based scorers sit within noise
of the position baseline, and the two convergence-based ones sit *below* it,
barely above random. `chatterVelocity` is the only interesting row: its recall
is 0.435 against the position baseline's 0.311, so it finds more of the events
while being no more precise about which of its picks are right.

This is a negative result and it is worth having early. Had the old chance rate
survived into Day 4, a model that learned nothing but a clock would have
reported 7% against a 2.5% floor and looked like a finding.

Open, and blocking a clean Day 4: the front-loading is an artifact of how the
recorder joins streams, so it needs removing at the data level — either by
joining channels at random times rather than at peak, or by reporting precision
within fixed stream-position strata so a clock cannot win. Until then, any
trained number has to be read against `constant`.

## The front-loading was the label threshold, not the recorder

*2026-11-25, same evening*

Four hypotheses, three wrong, which is worth recording so nobody re-tests them.

**Wrong: offline chat.** The recorder stays joined when a stream ends, so the
guess was that quiet offline stretches were padding the timeline. Fetched every
channel's archive VODs (`tools/fetch-live-windows.mjs`, 180 broadcast windows
across 25 channels) and the channels were live for nearly all of it —
bratishkinoff 6.8h of 7.0h, ohnepixel 6.6h of 7.0h. Gating windows to broadcast
time is still correct and is now done, because nobody clips an offline channel,
but it moved the front-loading not at all: 38% in the first fifth, against 36%
before. Note cohhcarnage publishes no archives at all, so channels with no VOD
data are left ungated rather than dropped — it has 282 events and deleting the
best-labelled channel to tidy a denominator would be a bad trade.

**Wrong: we joined at peak and chat cooled off.** Chat is *heavier* late:
21% of volume in the first fifth and 26% in the last. Message rate cannot
explain a 36% event share.

**Wrong: label maturation.** The theory was that old moments have had longer to
accumulate presses. But presses arrive almost immediately — p90 of
clip-created-minus-moment is **4 minutes**, and only 5.7% of clips are made
more than two hours after the moment. The ≥3-press share by moment age is
17.0% / 13.2% / 9.9% / 15.3% / 18.9% across age buckets: no trend.

**Right: the three-press bar is a function of audience size.** Clip presses
scale with concurrent viewers; chat volume scales *sub*linearly with them,
because big chats are mostly lurkers and slow mode and rate limits bite. So a
fixed bar is far easier to clear in a big hour. Measured: the hour the recorder
joined carried **2.23 qualifying events per 1k windows against 1.02 in the hour
five hours later, on 20% more chat**. Same chat rate, double the events. The
bar was reading audience size.

### The fix

Define events the way the metric already asks the question. The metric is
precision@6/hour — *give me this hour's best moments* — so the labels are now
the **top 6 moments per block by press count**, where a block is an hour's
worth of pickable windows rather than a clock hour. Clock hours were tried
first and were still skewed, because the hour the recorder joins is a partial
one and giving 35 minutes a full hour's quota inflates its density by half
again. A floor of 2 presses stops a dead block manufacturing events out of
single clips.

Event density is now flat in position:

```
fifths of the recorded span (earliest -> latest)
qualifying events   16  16  21  30  16  %   (was 36 10 15 20 20)
events per 1k win  1.20 1.35 1.65 2.06 1.01 (was 2.15 .65 .88 1.37 .90)
```

### Where the baselines now stand

| scorer | precision | 95% CI | recall |
|---|---|---|---|
| random (floor) | 0.060 | [0.05, 0.08] | 0.262 |
| constant (position) | 0.084 | [0.05, 0.12] | 0.291 |
| convergenceOnly | 0.077 | [0.05, 0.11] | 0.265 |
| lightor | 0.062 | [0.03, 0.10] | 0.246 |
| velocity | 0.101 | [0.06, 0.15] | 0.358 |
| chatterVelocity | 0.105 | [0.07, 0.15] | 0.399 |
| **currentHeuristic** | **0.109** | [0.07, 0.16] | 0.412 |

The position baseline's edge over noise fell from 2.0x to 1.4x and its interval
now overlaps the floor, so position is no longer worth anything much. Three
scorers clear it: the two rate-based ones and the current heuristic, at roughly
**1.8x chance**. That is the first number here that is about chat rather than
about the clock.

Convergence alone still sits at the position baseline, which keeps the open
worry from Day 2 alive: rate may be doing the work. The rate-controlled
ablation is still owed.

No recorder change. Join timing contributed, but the bias is neutralised in the
labels, and restarting a healthy recorder to stagger joins would cost live
collection to fix something already fixed. The spans lengthen on their own as
recording continues, which only strengthens this.

## Day 4: the model works, and the thesis does not

*2026-11-25, late*

A logistic regression over channel-relative features, fit leave-one-channel-out
on 20 channels. The relative part is not a detail: the benchmark holds out
whole channels, ohnepixel sent 121k messages in the recorded span and voodoosh
5k, so a model handed raw counts learns audience size — the one thing certain
not to transfer. Every unbounded feature enters as a ratio to its own 30s
baseline, measured causally from chat before *t*. A test pins the invariance: a
3× spike must look identical in a chat of 20 and a chat of 20,000.

Found and fixed a real bug on the way in. `msgRate` is messages divided by
window length, so `msgRate_r4` is algebraically identical to `messages_r4`.
Including both put the same feature in twice — the first fit gave
`messages_r10` 0.659 and `msgRate_r10` 0.658 — quietly doubling rate's weight
against every other signal, which is the exact confound this benchmark exists
to expose.

### The ablation

The same model, the same folds, different inputs. This is what hand-written
scorers could never settle, because they differ in their weights as well as
their inputs.

| scorer | inputs | precision | 95% CI | recall | wRecall |
|---|---|---|---|---|---|
| **logregRate** | rate only | **0.116** | [0.08, 0.16] | 0.430 | 0.431 |
| logregRateConv | rate + agreement | 0.114 | [0.08, 0.16] | 0.442 | **0.452** |
| currentHeuristic | hand-written | 0.109 | [0.07, 0.16] | 0.412 | 0.411 |
| logreg | all 43 | 0.106 | [0.07, 0.15] | 0.407 | 0.415 |
| logregShares | everything but rate | 0.079 | [0.05, 0.12] | 0.328 | 0.329 |
| constant | position baseline | 0.084 | [0.05, 0.12] | 0.291 | 0.302 |
| random | floor | 0.060 | [0.05, 0.08] | 0.262 | 0.265 |

**Convergence adds nothing.** Rate alone is the best scorer in the table. Add
the crowd-agreement features and precision does not move (0.114 vs 0.116, fully
overlapping). Add all 43 features and it gets *worse* — 0.106 — which is what
43 features and 20 training channels should be expected to do. Strip rate out
and the remaining 37 features barely clear the position baseline.

This answers the worry logged on Day 2, and answers it against the thesis. The
intellectual core of this project was that clip-worthy moments are where a
crowd *converges on the same words*. On this data that is not where the signal
is. The signal is that more distinct people start talking, in shorter messages.

The one thing agreement buys is weighted recall: 0.452 against 0.431, the best
in the table. So convergence may help rank the *heavily*-clipped moments above
the thinly-clipped ones, without helping find them. That is a hint, not a
result, and the interval does not support more.

### What the model actually is

```
rate -- 6 features, bias -1.025
  chatters_r10               1.241
  messages_r10               1.060
  meanLength_r10            -0.430
  chatters_r4                0.278
```

Three things, in plain words: **more distinct people talking in the last ten
seconds than the last thirty, saying shorter things than usual.** The 10s
window dominates the 4s one, which says the reaction window is about ten
seconds — consistent with the −3s clip-start-to-chat-peak measurement, and a
useful number in its own right.

### Honest caveats

**The mean hides a lot.** Per-channel precision runs from gotaga 0.462 (7
events, 2.1h) to loya 0.000. The high scores sit on thin channels. On the three
best-labelled channels it is elajjaz **0.211** (36 events), ohnepixel **0.167**
(30), cohhcarnage **0.114** (31) — 2–3.5× chance, which is the number worth
quoting, not the 0.116 mean.

**The feature set was chosen on the reported folds.** Rate-only, rate+agreement
and all-features span 0.106–0.116, so the defensible claim is ≈0.11, not 0.116.
A clean number needs a held-out channel group that no variant was selected on.

**One day of recording.** Six hours per channel, 20 channels, 4,023 clip
events. Everything here should be re-run once the span covers whole broadcasts
across several days.

## Day 5: the detector runs, and online is not the same problem as offline

*2026-11-25, night*

`tools/evaluate.mjs` peak-picks offline — sort the hour's windows by score,
take the best six, suppress neighbours. That is a fair way to measure a scorer
and an impossible way to run one: it needs the end of the hour to rank the
beginning. So the live rule is its own code (`src/online.mjs`) and gets its own
row in the table.

The rule is **threshold, settle, fire**. Cross the threshold and you are armed,
not finished: the crossing is the start of a reaction, and firing there cuts
before the thing people are reacting to has landed. So track the maximum for up
to 8s and commit at it. Then 45s refractory, the same suppression width the
benchmark uses. Settling is nearly free because the clip is cut retroactively
from the rolling video buffer — the detector is choosing a timestamp in the
recent past, not deciding whether to start recording.

The threshold is **measured, not chosen**. Training upweights the positive
class so the model does not collapse to predicting zero, which shifts every
score up by an amount depending on the class ratio, so no fixed probability
cutoff survives a retrain. The real firing rule is replayed over the training
folds and the threshold binary-searched until it fires six times per recorded
hour — the same budget the benchmark gives itself. Calibration happens on the
training folds only; fitting it on the scored channel would be the same leak as
fitting the weights there.

### What it costs to decide in real time

| | precision | 95% CI | recall |
|---|---|---|---|
| logregRateConv (offline ranking) | 0.141 | [0.10, 0.19] | 0.432 |
| **online (decides at t)** | **0.165** | [0.11, 0.23] | 0.353 |

The mean says the live rule is *better*, which is not the expected result and
is mostly an artifact of averaging over channels. Split by how well-labelled a
channel is:

```
                      online   offline   fires/channel
>=20 events (n=5)      0.153     0.175            44.0
 <20 events (n=15)     0.168     0.129            27.8
```

On the five channels we actually trust, the causal detector costs about **13%
relative precision** — 0.153 against 0.175 — which is the honest number. The
mean is flattered by thin channels where it fires rarely. What it buys is
selectivity: it fires 5.82 times an hour rather than being forced to produce
six picks whether or not six moments existed.

### Latency, on 176,566 scored ticks of real recorded chat

```
compute per scored tick    p50 0.14ms   p90 0.41ms   p99 0.86ms   max 2.34ms
chosen moment to commit    p50 3.6s     p90 8.8s     max 18.8s
```

At p99 that is roughly **1,100 channels per core** before ticks queue. This is
the number that matters commercially: chat-only detection is cheap enough to
run on everything live simultaneously, which is not true of anything that
decodes video.

Found a real bug measuring it. Max decision latency was **2,011 seconds**. When
chat goes too quiet to build a row, `advance` returned early — so an armed
detector stayed armed until chat came back, then fired on a half-hour-old peak.
A settle-expiry check in the quiet branch fixed it; max is now 18.8s, and a
test pins it.

`watch.mjs --model` runs the trained path, and without the flag the heuristic
still runs. Both stay because the benchmark cannot separate them: 0.130 against
0.141 with intervals that overlap almost entirely. Picking a winner on that gap
would be reading noise. Where they *disagree* is the interesting comparison and
it needs both to exist.

## Day 5: first contact with a live stream

Ran both detectors against **zackrawrr** — 37.6k viewers, GTA VI, and genuinely
held out of training. Of the 25 channels the recorder follows only five were
live and only `kyedae` was English, and she is in the training set; the live
English GTA VI list supplied a held-out channel instead.

`tools/compare-live.mjs` opens one IRC connection and feeds both detectors the
same messages. Two `watch.mjs` processes would not answer the question: each
opens its own connection, so every disagreement would be confounded with a
different message set and different arrival times. That confound is not
hypothetical — see the 1.9s spread below.

### Two bugs the entire offline benchmark was blind to

**No warmup.** Seven seconds after connecting, the model fired on seven people
typing "EZ". Every feature is a ratio of a 4s window to that window's own 30s
baseline, so before 30s of chat exists the baseline is short and anything at
all scores high. `tools/build-dataset.mjs` builds rows across hours of
recording, where one cold start per session is swamped by thousands of warm
rows. Live it happens on **every reconnect**. `OnlineDetector` now refuses to
score until the buffer spans the longest feature window, which is the same
reason `SpikeDetector` has always had `warmupMs`, arrived at independently.

**Arrival-driven ticking.** `watch.mjs` ticked the model when a message
arrived. A lull then leaves it armed with no tick to expire the settle window —
the 2,011-second decision latency, reachable again through the live path even
though the detector itself had been fixed. Both paths now tick on a clock, and
on *Twitch's* clock rather than ours: feature windows are `[t - scale, t)`, so
a second of skew silently drops the newest slice of chat out of every window.
Measured skew on this stream was −0.1s, so it was not biting yet.

### 30 minutes, 3,874 messages

```
model fired        1    2.00/hour   (calibrated for 6)
heuristic fired    3    6.00/hour   (+15 rejected by the shape gate)
both agreed on     1    within 10s
model only         0
heuristic only     2
```

The one agreed moment is worth the whole run. Three independent detections:

```
20:28:38.766   model, compare process
20:28:39.113   heuristic, same process, same connection
20:28:40.647   model, separate watch.mjs process, separate IRC connection
```

The two detectors on one connection landed **0.3s** apart. The same model on a
second connection landed **1.9s** from itself — which is the confound
`compare-live.mjs` exists to remove, measured.

### The calibrated rate is a fleet average, not a per-channel rate

The live 2.0/hour against a 6/hour calibration looks like transfer failure. It
is not. The benchmark already contained the answer; nobody had read it this
way. Per-channel online fire rates across the 20 held-out channels:

```
kr1stw         19.90/h      nickmercs       4.08/h
elajjaz        11.00/h      ricfazeres      3.46/h
singsing       10.95/h      loya            3.27/h
ohnepixel       9.73/h      zerkaa          3.25/h
sasavot         7.01/h      voodoosh        3.08/h
thetremba       6.93/h      squeezie        3.01/h
bratishkinoff   6.17/h      frametamer666   2.56/h
cohhcarnage     5.14/h      kyedae          2.12/h
gotaga          4.74/h      rumathra        1.19/h
imantado        4.58/h
```

**A 17× range, and no channel actually gets 6/hour.** zackrawrr's live 2.0 sits
near the quiet end, next to kyedae (2.12) and frametamer666 (2.56) — inside the
distribution, not outside it. The global threshold is behaving exactly as the
benchmark says it does.

What drives the spread (Spearman, n=20, critical ρ ≈ 0.45 at p<0.05):

```
fires/hour vs chat volume      +0.568   significant
fires/hour vs raw press rate   +0.523   significant
fires/hour vs precision        -0.248   not significant
```

So the rate tracks **chat volume**, and the raw-press correlation is the
audience-size confound again, since presses scale with viewers. Firing more is
*not* reliably worse — kr1stw is one dramatic point (19.9/h at 0.008
precision), not a trend, and at n=20 that correlation is noise.

The sharp version: **the benchmark asks every channel for the same number of
moments per hour** — the relabelling is top-N per block of equal pickable time,
so the target is equal-rate by construction — **while a single global threshold
delivers between 1.2 and 19.9.** Precision is measured against an equal-rate
question that the detector is not answering. Channel-relative features removed
the audience confound from how the scores *rank*; they did not remove it from
where a fixed cutoff lands in each channel's score distribution.

The fix is a per-channel operating point: a rolling quantile of that channel's
own recent scores rather than one global number. Not yet implemented.

### What it clipped

One moment produced a real clip: 1080×1920, 30s, captions burned in, `p=0.7678`,
committed 3.0s after the peak. The 30 seconds are a GTA VI cutscene — a heist
briefing — and the beat chat reacted to is a scripted joke ("Any questions?"
"Yeah." "No. Not you. Anyone else?"). The detection is correct; chat really did
laugh at a real punchline.

But the punchline sits **8 seconds** into the clip, and the clip is built as
`peak − 3.5s reaction lag − 14s preroll`, which puts the estimated onset at 14s.
Chat took roughly six seconds longer to react than the lag constant predicts.
The clip is good because the preroll is generous, not because the lag estimate
was right. n=1, so this is a flag rather than a finding — but if the preroll is
ever trimmed for a tighter format, a 3.5s constant will start cutting punchlines
off the front.

Second honest note: it clipped a cutscene. Chat-only detection cannot tell
whether the funny thing was *visible* or merely audible in the streamer's
commentary. Here it happened to be on screen. Nothing in the signal guaranteed
that, and nothing in the signal ever will.

### The clip was a false positive, and checking it found the real problem

Showed the clip to Suhaan, who said it was not a clip-worthy moment. He was
right, and the clip button agrees: **zackrawrr produced zero clips during the
entire 30-minute run.** Fifteen clips over the 8.7-hour session, the last one
27 minutes before the run started, none inside it. All four fires — one model,
three heuristic — were false positives against the project's own ground truth.

That was the expected outcome of showing one fire. Measured online precision is
0.165, so roughly one fire in six is a real moment. Presenting the first clip
that came out as *the* result was the wrong way to demo a probabilistic
detector; the right unit is a reel of several fires, or the subset that hit.

Checking it properly turned up something larger. zackrawrr's viewers press clip
**1.72 times per hour**. The detector is calibrated to fire **6 times per
hour**. Pooled across the benchmark, 637 fires against 265 labelled events:

```
labelled events   265
fires             637
precision ceiling 0.416     <- a PERFECT detector cannot beat this
measured          0.165     <- 40% of what is achievable, not 16% of 1.0
```

The detector fires 2.4× more often than moments happen, so most fires cannot be
moments no matter how good the scorer is. Per channel the ceiling collapses
entirely:

```
channel         events/h   fires/h   ceiling   actual
cohhcarnage         5.31      5.14     1.000    0.133
bratishkinoff       5.57      6.17     0.902    0.293
kyedae              1.66      2.12     0.786    0.357
ohnepixel           6.10      9.73     0.627    0.068
elajjaz             6.18     11.00     0.562    0.096
squeezie            0.60      3.01     0.200    0.050
thetremba           1.21      6.93     0.174    0.022
ricfazeres          0.20      3.46     0.059    0.059   <- at its ceiling
kr1stw              0.34     19.90     0.017    0.008   <- 58 fires per moment
```

On kr1stw the benchmark is measuring almost nothing: the detector is required
to emit 58 fires for every real moment, so its precision is pinned near zero by
arithmetic before the scorer is consulted. ricfazeres sits exactly on its
ceiling — it is already as good as the fire budget permits.

And the budget is spent in the wrong places (Spearman, n=20, critical ρ≈0.45):

```
fires/hour vs chat volume        +0.568   significant
fires/hour vs real moment rate   +0.298   NOT significant
```

**The detector spends its firing budget where chat is loud, not where moments
are.** That is the one-line diagnosis, it explains the cutscene clip exactly,
and it makes the per-channel operating point the next piece of work rather than
a nicety — with a target that tracks each channel's own observed press rate
instead of a global 6/hour.

One caveat on the ground truth: Helix returns clips sorted by view count and
its time-window filtering is unreliable, so 15 clips for an 8.7-hour session by
a 37k-viewer channel may undercount. The within-run figure is a hard zero
either way, and the ceiling argument only needs the ratio to be roughly right.
