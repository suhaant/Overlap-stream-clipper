/**
 * Shared chat vocabulary. Both the moment classifier and the reaction-shape gate
 * read from here so they can never drift apart.
 *
 * Most of these are third-party (7TV/BTTV) emotes, which arrive as plain text --
 * they are NOT in Twitch's `emotes` tag. Text matching is the primary signal.
 */
export const KINDS = {
  funny:      ['kekw','kekwait','lulw','lul','omegalul','lmao','lmfao','lol','lmaoo','icant','i cant','pepelaugh','haha','hahaha','ahaha','im dead','deadass','crying','💀','😂','🤣'],
  shock:      ['what','whaat','whattt','wtf','huh','omg','omfg','no way','noway','woah','whoa','bruh','holy','sheesh','wait what','excuse me','???','??'],
  hype:       ['pog','poggers','pogu','pogchamp','letsgo','lets go','lesgo','gigachad','clutch','insane','goated','cracked','actual w','dub','🔥','w'],
  fail:       ['sadge','copium','pepehands','rip','noooo','nooo','unlucky','painful','oof','widepeepohappy','l','aware'],
  scary:      ['monkas','monkaw','aaaa','aaah','scary','jumpscare','terrifying','spooked'],
  clipworthy: ['clip it','clip that','!clip','clipped','someone clip','clip this','clipper','clip clip'],
};

/** Flat set of every single-token reaction term, for shape scoring. */
export const REACTION_TOKENS = new Set(
  Object.values(KINDS).flat().filter(t => !t.includes(' '))
);

/** Multi-word reaction phrases, checked as substrings. */
export const REACTION_PHRASES = Object.values(KINDS).flat().filter(t => t.includes(' '));

export const normalize = (s) =>
  s.toLowerCase().replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').replace(/[.,!]+$/g, '').trim();

export const tokens = (s) => normalize(s).split(/\s+/).filter(Boolean);

/** Does this message read as a reaction rather than a sentence? */
export function isReactionish(text) {
  const t = normalize(text);
  if (REACTION_PHRASES.some(p => t.includes(p))) return true;
  const tk = tokens(text);
  if (!tk.length) return false;
  // A message made *mostly* of reaction tokens, e.g. "KEKW KEKW", "W lets go".
  const hits = tk.filter(w => REACTION_TOKENS.has(w)).length;
  return hits / tk.length >= 0.5;
}

/** Repeated-character screaming: "AAAAA", "noooooo", "LMAOOOO". */
export const isScreaming = (text) => /(.)\1{3,}/.test(text);

export const isEmojiOnly = (text) =>
  Boolean(text.trim()) && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(text);
