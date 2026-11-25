# Backlog

Worked top-down by the daily agent. Each item is a real change with a visible
outcome — something that would survive review at the company this repo is aimed at.
Tick items off, and add new ones as they surface.

## Correctness and robustness
- [ ] Twitch HLS manifest tokens expire mid-stream; detect the failure and re-resolve via yt-dlp instead of silently recording nothing
- [ ] Buffer has no disk ceiling — add a byte cap alongside `retainSec`, and a test
- [ ] Detect and drop duplicate clips when one moment opens two spikes across the refractory boundary
- [ ] `stream.online` / `stream.offline` handling: a chat socket connects happily to an offline channel and sits silent, so liveness must not be inferred from a successful join
- [ ] Reconnect hardening: exponential backoff is in place but untested against a forced disconnect
- [ ] Commit replay fixtures so the detector tests run without live data

## Detection quality
- [ ] Track precision over time: persist accepted/rejected decisions so threshold changes can be measured rather than guessed
- [ ] Auto-calibrate `reactionLagMs` per channel by correlating chat spikes against audio-energy spikes in the buffer
- [ ] Raid detection — a raid converges hard and is not a clippable moment
- [ ] Giveaway/keyword-spam detection: "ps5", "XBOX", "Hi Lacy" convergence is entry spam, not reaction

## Output quality
- [ ] Name the moment: vision or LLM pass over the clip window so captions stop falling back to `unclear`
- [ ] Auto-detect facecam position instead of a hand-set `cropAnchorX` per channel
- [ ] Thumbnail selection: pick the peak frame rather than the first
- [ ] Audio loudness normalisation to platform targets
- [ ] Export presets per platform (TikTok / Shorts / Reels differ on length and safe areas)

## Rights and safety (from Overlap's own GTA 6 guidance)
- [ ] Spoiler gate — launch-week story beats are the top takedown category
- [ ] In-game radio detection, since licensed tracks trigger Content ID
- [ ] Leaked-footage exclusion

## Platform
- [ ] Migrate chat from undocumented `justinfan` IRC to EventSub `channel.chat.message`
- [ ] Config file for per-channel layout and thresholds, replacing hardcoded maps
- [ ] CI: run the test suite on push
- [ ] Review dashboard for detected moments

## Found on first contact with real data (25 Nov)

**Within-message repetition inflates convergence.** The second line recorded on
ohnepixel was one chatter posting `GOLD` fourteen times in a single message.
Convergence is meant to measure *agreement between people*, but a type-token
ratio computed over a whole window is dragged down just as hard by one person
repeating a word as by eighty people typing the same one. The
`minUniqueChatters: 10` gate stops a lone spammer firing a clip, but the
feature itself is still contaminated, which will matter once a model is reading
the raw value rather than a thresholded one.

Fix on Day 2: compute convergence over one representative token per chatter,
not over every token in the window. That makes it a measure of crowd agreement
by construction rather than by gate.

**Copypasta is the hard negative to collect deliberately.** Twitch copypasta
spreads precisely by many people pasting identical text, which is exactly the
shape of a genuine reaction and will not be separable by convergence alone.
Worth labelling some by hand as a diagnostic set, because a model that scores
well overall but fires on every copypasta is not shippable.

**Observed rates, 25 channels, GTA 6, 25 Nov:** 38 messages/second in
aggregate, 11 MB/hour, projecting 7.6 GB/month. Disk is a non-issue.
