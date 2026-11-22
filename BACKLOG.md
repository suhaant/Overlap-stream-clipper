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
