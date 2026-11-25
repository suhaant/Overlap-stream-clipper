import { tokens, normalize, isReactionish, isScreaming, isEmojiOnly, KINDS } from './lexicon.mjs';

/**
 * WINDOW FEATURES
 *
 * One implementation, used by both the live detector and the dataset builder,
 * for the same reason src/lexicon.mjs exists: two copies of the same maths
 * drift, and then the model is trained on features the detector does not
 * actually compute.
 *
 * THE CONVERGENCE FIX.
 *
 * src/shape.mjs measures convergence per MESSAGE:
 *
 *     repetition   = 1 - uniqueTexts / messageCount
 *     lowDiversity = 1 - vocabSize / totalTokens
 *
 * Both are contaminated by a single person. The second line this project ever
 * recorded on ohnepixel was one chatter posting
 *
 *     GOLD GOLD GOLDGOLD GOLD GOLDGOLD GOLD GOLD...
 *
 * which contributes fourteen tokens and one vocabulary entry, moving
 * lowDiversity about as hard as a genuine crowd would. Convergence is supposed
 * to mean "many people said the same thing", and the message-level version
 * instead means "the same thing was said many times", which is a different
 * claim and is exactly what a spammer produces.
 *
 * The fix is to reduce each chatter to one representative message before
 * measuring anything, so agreement is counted over PEOPLE. A lone spammer then
 * contributes one vote no matter how much they type.
 *
 * The contaminated versions are still computed, as `msgRepetition` and
 * `msgLowDiversity`, so the difference can be measured on real data rather
 * than asserted. If they turn out to carry signal the crowd version misses,
 * that is worth knowing too.
 */

/** The reaction-shape gate's live threshold needs the same token list. */
const CLIP_REQUEST = KINDS.clipworthy;

/**
 * BOT COMMANDS.
 *
 * By near-universal Twitch convention a message beginning with `!` addresses a
 * chat bot rather than the room. On the first 90 minutes recorded from
 * ohnepixel, 36.6% of ALL messages were bang-prefixed, 9,801 of them `!rested`
 * typed by 5,456 distinct chatters.
 *
 * That is catastrophic for convergence, because a command spree is
 * indistinguishable from a genuine reaction by every measure this file
 * computes: hundreds of different people, short identical text, perfect
 * agreement. The three highest-convergence windows in that sample were all
 * `!rested`, scoring 0.96 -- higher than any real moment. A model trained on
 * unfiltered chat would learn to detect channel-point commands.
 *
 * So commands are excluded from every agreement measure and counted
 * separately. The share is kept as a feature in its own right: a window that
 * is mostly commands is a bot event, which is evidence AGAINST a moment.
 *
 * The prefix test deliberately catches the misfires too (`!restedd`,
 * `!reste`, `!rested.`), since those are people fumbling the same command.
 */
const isCommand = (text) => /^\s*!/.test(text);

/** Longest run of one repeated token inside a message, as a share of its length. */
function selfRepetition(tk) {
  if (tk.length < 2) return 0;
  const counts = new Map();
  for (const w of tk) counts.set(w, (counts.get(w) ?? 0) + 1);
  return Math.max(...counts.values()) / tk.length;
}

/**
 * Features for one window of messages.
 *
 * `windowMs` is passed rather than derived from the messages, because an empty
 * or one-message window still has a duration and the rates must not divide by
 * a span of zero.
 */
export function windowFeatures(messages, { windowMs = 4000 } = {}) {
  const all = messages.filter(m => m && typeof m.text === 'string' && m.text.trim());
  const seconds = Math.max(windowMs / 1000, 0.001);
  // Commands are measured, then set aside. Everything below describes the room
  // talking to itself, not the room talking to a bot.
  const msgs = all.filter(m => !isCommand(m.text));
  const commandShare = all.length ? 1 - msgs.length / all.length : 0;

  const empty = {
    messages: 0, chatters: 0, msgRate: 0, chatterRate: 0,
    crowdRepetition: 0, crowdDiversity: 0, topTokenShare: 0,
    msgRepetition: 0, msgLowDiversity: 0, selfRepetition: 0,
    brevity: 0, reactionWords: 0, emoteDensity: 0, screaming: 0,
    conversational: 0, clipRequest: 0, meanLength: 0, commandShare: 0,
  };
  if (!msgs.length) return { ...empty, commandShare };

  // ONE REPRESENTATIVE PER CHATTER. First message, not a sampled or modal one:
  // first is causal, deterministic, and cannot be influenced by what someone
  // types later in the window.
  const firstByChatter = new Map();
  for (const m of msgs) {
    const who = m.user ?? m.login ?? '?';
    if (!firstByChatter.has(who)) firstByChatter.set(who, m);
  }
  const reps = [...firstByChatter.values()];
  const chatters = reps.length;

  // --- crowd-level agreement, computed over representatives only ---
  const repTexts = new Set();
  const repVocab = new Set();
  const tokenChatters = new Map();   // token -> how many DISTINCT chatters used it
  let repTokenTotal = 0;

  for (const m of reps) {
    const distinct = new Set(tokens(m.text));
    repTexts.add(normalize(m.text).replace(/\s+/g, ' '));
    // DISTINCT tokens per chatter, not every token. Counting every token lets
    // one person writing "GOLD GOLD GOLD" contribute five to the denominator
    // and one to the vocabulary, which is the same contamination this whole
    // function exists to remove -- just moved from repetition into diversity.
    repTokenTotal += distinct.size;
    for (const w of distinct) {
      repVocab.add(w);
      tokenChatters.set(w, (tokenChatters.get(w) ?? 0) + 1);
    }
  }

  const crowdRepetition = chatters ? 1 - repTexts.size / chatters : 0;
  const crowdDiversity = repTokenTotal ? 1 - Math.min(repVocab.size / repTokenTotal, 1) : 0;
  // The cleanest statement of "86 people typed heist": the share of distinct
  // chatters who used the single most common token. Immune to message volume.
  const topTokenShare = chatters
    ? Math.max(0, ...tokenChatters.values()) / chatters
    : 0;

  // --- the old, message-level versions, kept for comparison ---
  const msgTexts = new Set();
  const msgVocab = new Set();
  let msgTokenTotal = 0;
  let shortMsgs = 0, longMsgs = 0, reactionMsgs = 0, emoteMsgs = 0;
  let screams = 0, mentions = 0, realQuestions = 0, clipAsks = 0;
  let lengthTotal = 0, selfRepTotal = 0;

  for (const m of msgs) {
    const tk = tokens(m.text);
    const lower = normalize(m.text);
    msgTexts.add(lower.replace(/\s+/g, ' '));
    msgTokenTotal += tk.length;
    for (const w of tk) msgVocab.add(w);

    lengthTotal += tk.length;
    selfRepTotal += selfRepetition(tk);

    if (tk.length <= 4) shortMsgs++;
    if (tk.length > 8) longMsgs++;
    if (isReactionish(m.text)) reactionMsgs++;
    if ((m.emoteCount ?? 0) > 0 || isEmojiOnly(m.text)) emoteMsgs++;
    if (isScreaming(m.text)) screams++;
    if (m.text.includes('@')) mentions++;
    if (m.text.includes('?') && tk.length > 4) realQuestions++;
    // Kept apart from every other signal on purpose: if the model turns out to
    // lean on this, it is detecting chat telling itself to clip rather than
    // detecting a moment. See docs/SCOPE.md.
    if (CLIP_REQUEST.some(p => lower.includes(p))) clipAsks++;
  }

  const n = msgs.length;
  return {
    messages: n,
    chatters,
    msgRate: n / seconds,
    chatterRate: chatters / seconds,

    crowdRepetition,
    crowdDiversity,
    topTokenShare,

    msgRepetition: 1 - msgTexts.size / n,
    msgLowDiversity: msgTokenTotal ? 1 - Math.min(msgVocab.size / msgTokenTotal, 1) : 0,
    selfRepetition: selfRepTotal / n,

    brevity: shortMsgs / n,
    reactionWords: reactionMsgs / n,
    emoteDensity: emoteMsgs / n,
    screaming: screams / n,
    conversational: (mentions + longMsgs + realQuestions) / n,
    clipRequest: clipAsks / n,
    meanLength: lengthTotal / n,
    commandShare,
  };
}

/** Crowd convergence, the replacement for shape.mjs's message-level version. */
export function convergence(f) {
  return 0.5 * f.crowdRepetition + 0.5 * f.crowdDiversity;
}

/** The old message-level convergence, for measuring the difference. */
export function legacyConvergence(f) {
  return 0.5 * f.msgRepetition + 0.5 * f.msgLowDiversity;
}

export const FEATURE_NAMES = Object.keys(windowFeatures([], {}));
