# HypeCut

**A clip-detection node for [Overlap](https://www.overlap.ai) that uses live audience reaction instead of content analysis.**

Built against Overlap's node model: `Twitch Live → Chat Spike → Reframe → Style Video → Post to Social`.
The last three nodes already exist. This is the first two.

---

## Why

Overlap's `Find Clips` node reads a recording against a prompt you write. For a podcast that is
exactly right — the words *are* the moment. For gameplay it is structurally wrong:

- there is often no speech worth transcribing,
- the audio is engine noise, sirens and gunfire,
- and "good moment" is defined by **audience reaction**, not by content.

Overlap's own GTA 6 guide suggests the prompt *"reactions and chases only; skip story cutscenes"* —
straining to describe in English what chat hands you for free. On a 44,000-viewer stream, forty-four
thousand people are already labelling the footage in real time, for nothing.

**Why this is a margin problem, not a feature request.** Overlap bills $0.50–$2.50 CPM on *delivered
views* and explicitly absorbs the downside: "nothing charged for reach that did not land." Every clip
that flops costs GPU time and earns zero. Clip-selection precision is not a UX nicety for them — it
is gross margin. A detector with a 50% false-positive rate makes that worse. One that doesn't is a
direct margin improvement.

**And the timing gap is theirs to close.** Their streamers page says the source is "the VODs you
already keep." Their newly shipped Twitch support promises clips "in real time... no more waiting
until the stream ends." The flagship content for the biggest game launch in history still assumes the
VOD workflow. During launch week, when attention is highest, a VOD pipeline posts hours late.

---

## The three decisions that matter

### 1. Compare like with like

The first version compared unique chatters in a 4-second window against
unique-chatters-per-second over 180 seconds. That is invalid, and subtly so.

**Uniqueness saturates over long windows.** Chat is not a stream of strangers — a pool of regulars
talks repeatedly. So 200 distinct people over three minutes reads as 1.1/sec, while 15 distinct
people in four seconds reads as 3.75/sec. The ratio reports a 3.4x spike *when nothing has happened*.

On perfectly steady synthetic chat, that method reports **3.83x** against a fire threshold of 2.6 —
it fires continuously on nothing:

```
v1 ratio on steady chat: 3.83x   (fireRatio was 2.6)
v2 on steady chat:       0 spikes from 4,499 messages
```

The fix: slice the baseline into same-sized 4-second buckets and compare a bucket against the
**distribution** of buckets, using median and MAD (`1.4826 × MAD` as a consistent estimator of σ).
Median, because chat has fat tails and one earlier spike must not drag the baseline.

### 2. Count unique chatters, not messages

One person firing forty messages is not a moment. Four hundred people typing once is. Message rate is
trivially gamed by spam, bots and copypasta; unique-sender rate is not.

### 3. Chat reacts *after* the event

Encode latency, network, and human reaction time mean chat peaks roughly 3–5 seconds after the thing
happened on screen. **Clip from the chat peak and you land on the laughter and miss the joke.** The
estimated on-screen onset is `peak − reactionLag`, and the clip window is built backwards from there.
This is the most common way naive chat-clippers produce unusable clips.

---

## The reaction-shape gate

A spike says chat got louder. It does not say why. Chat gets louder for a YouTube outage, a raid, a
giveaway, the streamer asking a question, or the topic turning — none of which is clippable. In the
first live run, roughly half of all detections were conversation, not reaction:

```
ohnepixel "SHOCK":  "bye yt" / "Is youtube back up?" / "FROM THE TRAILER"
jynxzi    "FUNNY":  "find god" / "how does he have 60fps?" / "Lucia is packing"
```

But a mass reaction has a recognisable shape, and conversation has the opposite one:

|                | reaction        | conversation     |
| -------------- | --------------- | ---------------- |
| message length | 2–3 tokens      | 8–20 tokens      |
| vocabulary     | tiny, repeated  | broad, varied    |
| duplicates     | many (`KEKW`×80)| few              |
| @mentions      | almost none     | common           |
| questions      | `???`           | "how does he have 60fps?" |

So we score the shape and gate on it. Measured separation on hand-built windows:

```
reaction shape 0.751 · conversation shape 0.000
```

This gate is the defensible part. Thresholding a message counter is forty lines and is why naive
chat-clippers produce garbage. Telling "chat is loud" apart from "chat is reacting" is the real
problem.

---

## Layout

```
src/lexicon.mjs    shared chat vocabulary (classifier + gate read from one source)
src/chat.mjs       anonymous Twitch chat reader — zero credentials
src/detector.mjs   bucketed median/MAD baseline, hysteresis spike tracking, onset estimation
src/shape.mjs      reaction-shape gate
src/classify.mjs   moment type (funny/shock/hype/fail/scary) + ranking score
record.mjs         capture chat to JSONL
replay.mjs         deterministic offline replay for threshold tuning
tests/             numeric proof of the baseline fix and the gate separation
```

## Running it

```bash
npm test                                      # proves the math
node live.mjs ohnepixel,jynxzi 170            # watch it detect on live streams
node record.mjs ohnepixel,stableronaldo 9     # capture chat for tuning
node replay.mjs data/chat-*.jsonl --verbose   # deterministic replay
```

Chat is read anonymously over IRC-over-WebSocket using the undocumented `justinfan` nick: no OAuth,
no credentials, nothing to leak. Production would use EventSub `channel.chat.message`, which needs a
user token with `user:read:chat`.

## Notes on rights

Overlap's own GTA 6 guide is blunt that monetized GTA content is "tolerated, not licensed," and flags
story spoilers and in-game radio music (Content ID) as the main takedown risks. Reading public chat
is uncontroversial; capturing and reposting footage is not. A spoiler-and-music guardrail belongs in
this pipeline before anything it produces gets published, and is the next thing to build.
