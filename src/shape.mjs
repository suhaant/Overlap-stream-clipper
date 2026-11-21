import { tokens, normalize, isReactionish, isScreaming, isEmojiOnly, REACTION_TOKENS } from './lexicon.mjs';

/**
 * REACTION-SHAPE GATE
 *
 * A spike tells you chat got louder. It does not tell you *why*. Chat gets louder
 * for a YouTube outage, a raid, a giveaway, the streamer asking a question, or the
 * topic turning -- none of which is a clippable moment. Volume alone produced a
 * false-positive rate around 50% in our first live run.
 *
 * But a genuine mass reaction has a recognisable shape, and conversation has the
 * opposite shape:
 *
 *                    reaction          conversation
 *   message length   2-3 tokens        8-20 tokens
 *   vocabulary       tiny, repeated    broad, varied
 *   duplicates       many ("KEKW"x80)  few
 *   @mentions        almost none       common
 *   questions        "???"             "how does he have 60fps?"
 *
 * So we score the shape and gate on it. This is the difference between a clip
 * reel someone watches and one they scroll past -- and because Overlap bills on
 * delivered views and absorbs the cost of flops, it is the difference between
 * a margin-positive and margin-negative clip.
 */

export function shapeOf(window) {
  const msgs = window.filter(m => m.text && m.text.trim());
  if (msgs.length < 5) {
    return { shape: 0, reason: 'too-few-messages', n: msgs.length, signals: {} };
  }

  let shortMsgs = 0, reactionMsgs = 0, emoteMsgs = 0, screams = 0;
  let mentions = 0, longMsgs = 0, realQuestions = 0;
  const seen = new Map();
  const vocab = new Set();
  let totalTokens = 0;

  for (const m of msgs) {
    const tk = tokens(m.text);
    totalTokens += tk.length;
    for (const w of tk) vocab.add(w);

    if (tk.length <= 4) shortMsgs++;
    if (tk.length > 8) longMsgs++;
    if (isReactionish(m.text)) reactionMsgs++;
    if (m.emoteCount > 0 || isEmojiOnly(m.text)) emoteMsgs++;
    if (isScreaming(m.text)) screams++;
    if (m.text.includes('@')) mentions++;
    // "???" is a reaction. "how does he have 60fps?" is conversation.
    if (m.text.includes('?') && tk.length > 4) realQuestions++;

    const key = normalize(m.text).replace(/\s+/g, ' ');
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  const n = msgs.length;
  const signals = {
    brevity:        shortMsgs / n,
    reactionWords:  reactionMsgs / n,
    emoteDensity:   emoteMsgs / n,
    screaming:      screams / n,
    repetition:     1 - seen.size / n,
    // Type-token ratio. Reactions reuse a tiny vocabulary; conversation does not.
    lowDiversity:   totalTokens ? 1 - Math.min(vocab.size / totalTokens, 1) : 0,
    conversational: (mentions + longMsgs + realQuestions) / n,
  };

  const positive =
      0.26 * signals.brevity +
      0.28 * signals.reactionWords +
      0.14 * signals.emoteDensity +
      0.08 * signals.screaming +
      0.12 * signals.repetition +
      0.12 * signals.lowDiversity;

  // Conversation actively disqualifies: a window full of @replies and questions
  // is chat talking, not chat reacting.
  const shape = Math.max(0, Math.min(1, positive - 0.45 * signals.conversational));

  return {
    shape: Number(shape.toFixed(3)),
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, Number(v.toFixed(3))])),
    n,
    reason: shape < 0.3 ? 'conversational' : 'reaction',
  };
}

/** The handful of messages that best explain why this fired -- for captions and review UI. */
export function evidence(window, limit = 5) {
  return window
    .filter(m => m.text && isReactionish(m.text) || isScreaming(m.text || ''))
    .slice(0, limit)
    .map(m => ({ login: m.login, text: m.text }));
}
