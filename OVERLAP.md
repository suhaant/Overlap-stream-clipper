# Proposal: a `Chat Spike` detection node for Overlap

This is not a new product. It is **one new detection modality** inside the node graph
Overlap already has, plus the trigger it needs to run on.

```
  Twitch Live  →  Chat Spike  →  Reframe  →  Style Video  →  Post to Social
  ╰─── new ───╯   ╰── new ──╯    ╰────── already shipped ──────────╯
```

---

## 1. Why this is a margin problem, not a feature request

Overlap bills **$0.50–$2.50 CPM on delivered views** and explicitly absorbs the downside:
*"nothing charged for reach that did not land"*, *"a clip that was never posted is never
billed."*

Read as an engineer, that means **clip-selection precision is gross margin.** Every clip
that flops costs GPU time, storage and a posting slot, and earns exactly zero. For most
clipping tools, selection quality is a user complaint. For Overlap it is on the P&L.

That reframes what a detector is worth. A detector that fires on conversation instead of
reaction does not merely annoy anyone — it bills nothing and costs render. Our first
version did exactly that about half the time; the shipped gate removes 75% of candidates
and keeps only genuine mass reactions, deliberately trading recall for precision. On a
six-hour stream there is no shortage of candidates, only of good ones.

## 2. Why `Find Clips` is the wrong tool for gameplay

`Find Clips` reads a recording against a prompt. For a podcast that is exactly right —
the words *are* the moment. For gameplay it is structurally wrong:

- there is frequently no speech worth transcribing,
- the audio is engine noise, sirens and gunfire,
- and "good moment" is defined by **audience reaction**, not by content.

Overlap's own GTA 6 guide suggests the prompt *"reactions and chases only; skip story
cutscenes"* — straining to describe in English what chat hands you for free. On a
44,000-viewer stream, 44,000 people are already labelling the footage in real time.

## 3. The signal is convergence, not vocabulary

The obvious implementation — match chat against KEKW / LOL / POG — is wrong, and
measurably so. Against 6,095 messages of real GTA 6 chat:

| window | repetition | lexicon match | truth |
| ------ | ---------: | ------------: | ----- |
| 86 people typing `heist` | **0.877** | 0.008 | real moment |
| `NOOO / SAJ / SAJ` | **0.521** | 0.125 | real moment |
| `@M0hamdQ LOL / ciao bello / mhm` | 0.250 | **0.500** | conversation |

A lexicon only catches reactions whose words you anticipated, and it ranked pure
conversation above the best moment in the run. What separates them is **convergence**:
hundreds of people typing the same short thing at once, regardless of what it is.

This matters commercially for three reasons:

1. **No per-game tuning.** GTA 6 slang, Valorant slang and whatever ships in 2027 all
   work the same way.
2. **Language independent.** It works unchanged on `auronplay`'s Spanish chat — relevant
   given Twitch's largest channels are frequently non-English.
3. **Unspoofable by one actor.** The gate counts *unique chatters* converging, so a
   spammer or a bot farm moves nothing.

## 4. Why live needs infrastructure that VOD does not

**You cannot seek backwards on a live HLS manifest.** By the time chat has spiked,
reacted and been measured, the moment is 20–30 seconds in the past, and Twitch's live
playlist holds only a short sliding window.

So the stream has to be continuously recorded into a ring of short segments (stream-copy,
no re-encode) and the moment cut out of that ring afterwards. That is the structural
reason *"clip it from the VOD later"* and *"clip it live"* are different products rather
than the same product with a different trigger — and it is worth saying plainly, because
Overlap's own streamers page still describes the source as **"the VODs you already
keep"**, while the Twitch launch promises clips *"in real time... no more waiting until
the stream ends."* This is the gap between those two sentences.

There is also a timing subtlety worth getting right: **chat reacts 3–5s after the event**
(encode + network + human reaction). Clip from the chat peak and you land on the laughter
and miss the joke. The estimated on-screen onset is `peak − reactionLag`, and the clip
window is built backwards from there.

## 5. Proposed node configuration

Matching the shape of the existing `nodeConfigs` keys (`find_clips`, `convert_to_vertical`,
`add_subtitles`, …):

```jsonc
{
  "chat_spike": {
    "min_z": 3.2,                 // robust z-score vs the bucket distribution
    "sustain_z": 1.5,             // hysteresis: follow the spike to its peak
    "shape_gate": 0.30,           // reject conversation; raise for more precision
    "min_unique_chatters": 10,    // floor for small channels
    "reaction_lag_ms": 3500,      // chat reacts after the event
    "pre_roll_ms": 14000,
    "post_roll_ms": 16000,
    "refractory_ms": 25000,       // one moment, one clip
    "overlay_chat": true          // render the reaction under the video
  }
}
```

The framing belongs with `convert_to_vertical`, whose `style` and `zoom` settings already
cover this ground:

```jsonc
{
  "convert_to_vertical": {
    "style": "gaussian_blur",
    "zoom": 1.63,              // 163% of canvas width; 1.0 wastes most of the frame
    "y_offset": 0.125,         // clear a band at the top for the headline
    "crop_anchor_x": 0.12      // per channel: which side survives the crop
  }
}
```

`crop_anchor_x` is the one that needs saying out loud. Scaling past canvas width crops the
sides, and a facecam in a bottom corner is the most valuable pixels in a reaction clip. A
centred crop silently deletes it. This is per-streamer, not per-game.

And the trigger, alongside `New YouTube Video` / `RSS` / `Audio Livestream`:

```jsonc
{ "twitch_live": { "channels": ["stableronaldo"], "buffer_seconds": 900 } }
```

Everything downstream is unchanged: `Reframe` → `Style Video` → `Post to Social`, with
the existing approval and brand-kit behaviour.

## 6. What the overlay gives you for free

Reframing 16:9 to 9:16 leaves blurred bands over ~40% of the frame. Putting the chat
reaction there is not a space-filling trick — **chat losing it is the native format for
gaming clips**, and it is the one overlay this detector can produce honestly, because the
chat reaction is literally the evidence that selected the clip. Every other tool has to
invent a caption. This one already has the crowd's.

It also partly answers the captioning problem for silent gameplay, where there is no
speech to transcribe and `Style Video`'s subtitles have nothing to work with.

## 7. Rights, which Overlap's own guide takes seriously

Their GTA 6 post is blunt that monetized GTA content is *"tolerated, not licensed"*, and
flags story spoilers and in-game radio (Content ID) as the main takedown risks. Reading
public chat is uncontroversial; capturing and reposting footage is not. Before this is
pointed at a paying campaign it needs:

- a **spoiler gate** — launch-week story beats are the top takedown category,
- **radio/music detection**, since licensed in-game tracks trigger Content ID,
- and a leaked-footage exclusion.

Chat is actually a useful signal for the first of these too: spoiler discussion converges
the same way a reaction does, and is recognisable in the window text.

## 8. Honest limitations

- **Precision over recall by design.** Two borderline moments per sixteen candidates are
  dropped at the current gate. That is the right trade under CPM billing, but it is a
  trade.
- **`unclear` is common and correct.** The top detection in our run — 86 people typing
  "heist" — cannot be named from vocabulary alone. Detection is language-independent;
  *captioning* is not, and still wants an LLM or vision pass before `Style Video` can
  title it.
- **Buffer cost is real.** Continuous stream-copy recording per channel is cheap in CPU
  but not free in bandwidth or disk, and it scales linearly with monitored channels.
- **Stream-delay calibration.** Our ingest latency and the average viewer's player
  latency are close but not identical; the offset is a per-channel calibration, not a
  constant.
