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
  const uniqueTexts = seen.size;

  const signals = {
    // CONVERGENCE -- the primary signal, established empirically (see note below).
    repetition:     1 - uniqueTexts / n,
    lowDiversity:   totalTokens ? 1 - Math.min(vocab.size / totalTokens, 1) : 0,
    // Supporting signals. Weak individually.
    brevity:        shortMsgs / n,
    reactionWords:  reactionMsgs / n,
    emoteDensity:   emoteMsgs / n,
    screaming:      screams / n,
    // Disqualifying signal.
    conversational: (mentions + longMsgs + realQuestions) / n,
  };

  /**
   * WHY CONVERGENCE AND NOT VOCABULARY.
   *
   * The first version weighted `reactionWords` highest -- matching chat against a
   * lexicon of KEKW/LOL/POG. Measured against 6,095 messages of real GTA 6 chat,
   * that was simply the wrong primitive:
   *
   *   86 people typing "heist" in unison   -> reactionWords 0.008  (best moment in the run)
   *   "@M0hamdQ LOL / ciao bello / mhm"    -> reactionWords 0.500  (pure conversation)
   *
   * A lexicon only catches reactions whose words you anticipated. What actually
   * separates a mass reaction from conversation is CONVERGENCE: hundreds of people
   * typing the same short thing at the same time. What they type does not matter.
   *
   * Measured separation on that sample:
   *   real moments      repetition 0.39-0.88, lowDiversity 0.45-0.89
   *   conversation      repetition 0.21-0.28, lowDiversity 0.16-0.29
   *
   * This also makes the detector language- and game-independent: it works
   * unchanged on Spanish chat, and on a game whose slang does not exist yet.
   * The lexicon still earns its place in classification -- naming the moment --
   * just not in detecting it.
   */
  const convergence = 0.5 * signals.repetition + 0.5 * signals.lowDiversity;

  const positive =
      0.62 * convergence +
      0.12 * signals.brevity +
      0.12 * signals.reactionWords +
      0.08 * signals.emoteDensity +
      0.06 * signals.screaming;

  const shape = Math.max(0, Math.min(1, positive - 0.50 * signals.conversational));

  return {
    shape: Number(shape.toFixed(3)),
    convergence: Number(convergence.toFixed(3)),
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
