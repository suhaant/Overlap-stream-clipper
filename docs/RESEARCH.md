# Prior work

Read before writing model code, because three of the design choices already
in `src/` turn out to be published results. Knowing that changes what is worth
building: the parts that are solved become baselines to beat, and the effort
moves to the parts nobody has done.

Everything below was read from the paper or the repo, not from memory. Where a
source does not state something, it says so.

## The closest work: LIGHTOR (2019)

Jiang, Qu, Wang, Wang, Zheng. *Towards Extracting Highlights From Recorded Live
Videos: An Implicit Crowdsourcing Approach.* arXiv:1910.12201.

This is the paper this project should be measured against. Its chat component
is close to `src/detector.mjs` and `src/shape.mjs`, arrived at independently:

| LIGHTOR | this repo |
| --- | --- |
| 25s sliding windows over chat | `shortWindowMs: 4000` over a rolling baseline |
| Message Number | unique chatters per window |
| Message Length | `brevity` in `shape.mjs` |
| Message Similarity: bag-of-words, one-cluster k-means, mean similarity to the centre | `convergence` = repetition + low type-token diversity |
| `time_start = time_peak - c`, with c learned at 23-27s | `reactionLagMs: 3500` |
| Precision@K as the metric | precision@6 per stream-hour (proposed) |
| logistic regression over three normalised features | hand-tuned weights |

So "convergence beats lexicon matching" is not a new claim, and neither is
subtracting a reaction lag, nor evaluating with precision@K. All three are
2019 results. The honest position is that this repo rediscovered them.

Two things in that table are worth staring at:

**The reaction lag is off by an order of magnitude.** LIGHTOR learns c = 23-27
seconds from labelled data. `detector.mjs` assumes 3.5 seconds. Both cannot be
right. LIGHTOR measures peak-to-*highlight-start* on esports VODs where a
highlight is a teamfight with a run-up, while `reactionLagMs` is meant to be
peak-to-*reaction-trigger*. They may be measuring different distances. This is
the first thing the labelled data can settle, and it is worth settling, because
if 3.5s is wrong then every clip this repo has ever cut starts in the wrong
place.

**Their similarity measure is cruder than ours.** Bag-of-words plus one-cluster
k-means throws away word order and treats "KEKW KEKW KEKW" and "KEKW" as near
identical. A type-token ratio over the window is cheap and better behaved. That
is a small, real improvement, and it is measurable.

Reported numbers, for the baseline table:

- Chat Precision@10 of **0.82** trained on a single labelled video.
- Dota 2, top-5, start boundary **0.906**; end boundary **0.719**.
- An LSTM baseline reached about 0.629 start / 0.600 end.
- Claimed "123x fewer training examples and over 100000x less training time"
  than the deep baseline.

Stated limitations, which matter for us: it needs more than ~500 chat messages
per hour and more than ~100 viewers, and excited viewers can make an ordinary
segment look like a highlight. Tested on Dota 2 and LoL only.

## Fu et al. (2017), the original

Fu, Lee, Bansal, Berg. *Video Highlight Prediction Using Audience Chat
Reactions.* EMNLP 2017. aclanthology.org/D17-1102

300 League of Legends broadcasts, 30-50 minute games, roughly 7k chat messages
each, English and traditional Chinese. Character-level CNN-RNN over chat plus
visual features. Ground truth is highlight videos cut by esports journalists
and fans, not viewer clips.

Relevant mainly as the paper that established chat is a usable signal at all.
Code at github.com/chengyangfu/Pytorch-Twitch-LOL; the repo notes the video data
needs around 378 GB, which is why nobody re-runs it.

## MINT / "Finding epic moments" (2021)

github.com/dscig/twitch-highlight-detection, code for a paper submitted to EPJ
Data Science. The article itself is paywalled and was not read, so this comes
from the repo README only.

The README claims **0.8261 accuracy** "detect[ing] popular clips", by
"classifying popular and ordinary moments", using emote embeddings (gensim
KeyedVectors over the top 1000 emotes) plus video features, and says the
"combined usage of multimodal features (i.e., chat and video content) is
critical".

What the README does **not** state, and what therefore cannot be compared
against: the train/test split, the class balance or chance level, how "popular"
was defined, or whether the clips are viewer-created Twitch clips. The file
names (`clip_ids_0-3.csv`) suggest Twitch clips but it never says so. A bare
accuracy figure with unknown class balance is not a number we can beat or lose
to, so it goes in the review and not in the results table.

It does release pretrained emote embeddings, which may be worth using as
features rather than retraining.

## Live-streaming highlight prediction, industrial scale

Kuaishou + CAS. *A Multimodal Transformer for Live Streaming Highlight
Prediction.* arXiv:2407.12002, ICME 2024.

Not Twitch, and not chat-only, but it is the current shape of the problem at
scale, so it is useful for framing. KLive: 17,897 live rooms, 19,334 hours.
Labels are **LVTR** (long-view-through-rate from recommendation impressions),
not clips. 30-second segments, 20-segment look-back windows, causal attention so
only past context is used. Swin transformer on frames, BERT over concatenated
ASR and comments, plus a streamer ID embedding.

Kendall's tau 0.5961 against 0.5848 for PR-Net and 0.5818 for AntPivot; on the
public PHD set, mAP 21.89 against 18.66. Single run per configuration, no
variance reported. Ablations: dropping visual costs 4.72%, dropping text 2.01%.

Three things to take from it: a **streamer ID embedding** is a cheap way to
handle per-channel baselines; **causal attention** is the right framing for live;
and a **pairwise ranking loss** alongside pointwise loss suits a task where you
only ship the top few.

AntPivot (arXiv:2206.04888) is the other live benchmark, built from 3,655 Alipay
livestream records. Chinese-language, not transferable, but its authors make the
same complaint that drives this project: livestream highlight detection has no
proper public benchmark.

## What nobody has done

Taken together, the gaps are narrower than they first looked, but they are real.

1. **Online detection.** Every chat-based method above peak-picks over a
   finished video. LIGHTOR is explicit about it: *Recorded* Live Videos, and its
   refinement step uses viewer play and seek behaviour, which only exists after
   the VOD is published. Live means deciding now, with no future samples and no
   playback telemetry. That is a different problem, not the same problem with a
   faster loop.
2. **Clip-button labels at scale.** `vod_offset` on `GET /helix/clips` is a
   free, timestamped, human-pressed label, and no public work clearly uses it as
   the primary supervision signal. LIGHTOR paid ~$750 of Mechanical Turk for
   expert annotations on 60 videos. The clip button is unlimited and already
   collected.
3. **Open-world gameplay.** Everything above is esports (LoL, Dota 2), where
   highlights are structured events with a run-up. GTA 6 and variety streaming
   have no event schema at all.
4. **A public Twitch benchmark.** Fu's needs 378 GB. MINT's is on request.
   KLive is approval-gated. There is nothing a third party can download and
   score against, which is why no vendor publishes precision numbers.
5. **A learned, per-channel reaction lag** instead of a single constant c.

Items 1 and 2 are the project. Item 4 is the asset.
