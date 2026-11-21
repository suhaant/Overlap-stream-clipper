import { KINDS, normalize, tokens } from './lexicon.mjs';

/**
 * What KIND of moment was it? The spike says something happened; the shape gate
 * says it was a reaction; this says what sort of reaction, which decides caption
 * tone, thumbnail frame and destination account downstream.
 *
 * `clipworthy` is special: chat typing "clip it" is not a proxy for value, it is a
 * human explicitly labelling the moment. We surface it separately and weight it.
 */
export function classify(window) {
  const hits = Object.fromEntries(Object.keys(KINDS).map(k => [k, 0]));
  const chatters = new Set();

  for (const m of window) {
    if (!m.text) continue;
    chatters.add(m.login);
    const t = normalize(m.text);
    const words = tokens(m.text);
    for (const [kind, terms] of Object.entries(KINDS)) {
      for (const term of terms) {
        const hit = term.includes(' ') ? t.includes(term) : words.includes(term);
        if (hit) { hits[kind]++; break; }
      }
    }
  }

  const ranked = Object.entries(hits)
    .filter(([k]) => k !== 'clipworthy')
    .sort((a, b) => b[1] - a[1]);
  const [topKind, topCount] = ranked[0];
  const total = ranked.reduce((n, [, v]) => n + v, 0);

  /**
   * Don't let one message name the moment. On real data, 86 people typing "heist"
   * in unison got labelled `funny` because a single chatter wrote "lol" -- the
   * lexicon's only hit in a 120-message window. A label needs real support, and
   * `unclear` is an honest and useful answer: the moment is still clippable, we
   * just don't get to caption it from vocabulary alone.
   */
  const supported = topCount >= 3 && topCount / Math.max(window.length, 1) >= 0.04;

  return {
    kind: supported ? topKind : 'unclear',
    confidence: total ? Number((topCount / total).toFixed(2)) : 0,
    clipRequests: hits.clipworthy,
    breakdown: hits,
    uniqueChatters: chatters.size,
  };
}

/**
 * One number for ranking. Overlap bills on delivered views and absorbs the cost of
 * flops, so ranking decides what gets rendered and posted at all -- it is the
 * commercially load-bearing part of this pipeline.
 */
export function score(spike, cls) {
  const intensity = Math.min(spike.peakZ / 8, 1) * 40;                 // how far outside normal
  const breadth   = Math.min(spike.peakUniqueChatters / 150, 1) * 22;  // how many people
  const quality   = (spike.shape?.shape ?? 0) * 20;                    // how reaction-shaped
  const explicit  = Math.min(cls.clipRequests / 4, 1) * 13;            // chat asked for it
  const clarity   = cls.confidence * 5;                                // legible moment type
  return Math.round(intensity + breadth + quality + explicit + clarity);
}
