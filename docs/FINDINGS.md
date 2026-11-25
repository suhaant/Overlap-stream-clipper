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
