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
