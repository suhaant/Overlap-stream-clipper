import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowFeatures, convergence, legacyConvergence } from '../src/features.mjs';

const people = (n, textFor) =>
  Array.from({ length: n }, (_, i) => ({ user: `p${i}`, text: textFor(i), emoteCount: 0 }));

const oneChatter = (n, text) =>
  Array.from({ length: n }, () => ({ user: 'spammer', text, emoteCount: 0 }));

test('a crowd saying the same word converges, a spammer does not', () => {
  const crowd = windowFeatures(people(86, () => 'heist'));
  const spam = windowFeatures(oneChatter(86, 'heist'));

  assert.ok(convergence(crowd) > 0.95, `crowd was ${convergence(crowd)}`);
  assert.equal(convergence(spam), 0, 'one person cannot agree with themselves');
  assert.equal(crowd.chatters, 86);
  assert.equal(spam.chatters, 1);
});

test('repetition inside a single message does not inflate convergence', () => {
  // The actual message that exposed this, recorded on ohnepixel.
  const gold = oneChatter(14, 'GOLD GOLD GOLDGOLD GOLD GOLDGOLD GOLD GOLD');
  const f = windowFeatures(gold);

  assert.equal(convergence(f), 0);
  // The old measure is kept precisely so the difference can be shown.
  assert.ok(legacyConvergence(f) > 0.9, `legacy was ${legacyConvergence(f)}`);
});

test('the fix leaves a genuine crowd untouched', () => {
  const f = windowFeatures(people(40, () => 'KEKW'));
  assert.ok(Math.abs(convergence(f) - legacyConvergence(f)) < 0.05);
});

test('varied conversation scores low even from many people', () => {
  // Built so every chatter says something DIFFERENT. An earlier version of
  // this fixture cycled eight sentences across forty people, which means five
  // people typed each sentence verbatim -- that is real convergence, and the
  // feature was right to score it high. A fixture that repeats itself cannot
  // test a measure of repetition.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const subj = ['he', 'she', 'they', 'the driver', 'that guy', 'my game', 'the server'];
  const verb = ['broke', 'fixed', 'reloaded', 'missed', 'patched', 'crashed on', 'ruined'];
  const obj = ['the physics', 'that corner', 'my framerate', 'the whole lobby', 'textures',
               'the handling', 'everything honestly'];
  const tail = ['after the update', 'again for some reason', 'on ps5 at least',
                'since tuesday apparently', 'and nobody seems to have noticed',
                'which is honestly wild to me', 'but only in the city centre'];
  const because = ['because the patch changed the tyre model', 'and i cannot work out why',
                   'so i rolled back to the old build', 'which the devs still deny',
                   'though it might just be my hardware', 'and support were no help at all',
                   'even after a clean reinstall of everything'];

  const f = windowFeatures(people(40, () =>
    `${subj[rnd(subj.length)]} ${verb[rnd(verb.length)]} ${obj[rnd(obj.length)]} ` +
    `${tail[rnd(tail.length)]} ${because[rnd(because.length)]}`));

  assert.ok(f.chatters === 40);
  assert.ok(convergence(f) < 0.5, `conversation scored ${convergence(f)}`);
  assert.ok(f.conversational > 0.2, 'long messages should register as conversational');
});

test('a handful of people typing one sentence verbatim is convergence', () => {
  // Stated as a test because it is a design decision, not an accident: if
  // twenty distinct people post the exact same sentence, that is a crowd
  // agreeing, whatever the sentence is.
  const f = windowFeatures(people(20, () => 'i think the update broke physics'));
  assert.ok(convergence(f) > 0.9, `got ${convergence(f)}`);
});

test('bot commands are excluded from agreement and counted separately', () => {
  // The real pattern: hundreds of distinct chatters, one command.
  const f = windowFeatures(people(60, () => '!rested'));

  assert.equal(f.commandShare, 1, 'every message was a command');
  assert.equal(f.chatters, 0, 'no non-command chatters remain');
  assert.equal(convergence(f), 0, 'a command spree must not look like a reaction');
});

test('command misfires are still commands', () => {
  // People fumble the command; the prefix test has to catch all of these.
  const variants = ['!rested', '!restedd', '!reste', '!rested.', ' !rested'];
  const f = windowFeatures(people(50, i => variants[i % variants.length]));
  assert.equal(f.commandShare, 1);
});

test('commands mixed with a real reaction leave the reaction measurable', () => {
  const mixed = [
    ...people(30, () => '!rested'),
    ...people(30, i => 'LOL').map((m, i) => ({ ...m, user: `r${i}` })),
  ];
  const f = windowFeatures(mixed);

  assert.ok(Math.abs(f.commandShare - 0.5) < 0.01, `commandShare ${f.commandShare}`);
  assert.equal(f.chatters, 30, 'only the non-command chatters count');
  assert.ok(convergence(f) > 0.9, 'the reaction underneath should still read');
});

test('topTokenShare is the share of chatters, not of messages', () => {
  const mixed = [
    ...people(30, () => 'heist'),
    ...people(10, i => `unrelated${i}`).map((m, i) => ({ ...m, user: `u${i}` })),
  ];
  const f = windowFeatures(mixed);
  assert.ok(Math.abs(f.topTokenShare - 0.75) < 0.01, `got ${f.topTokenShare}`);
});

test('clipRequest is tracked apart from every other signal', () => {
  const f = windowFeatures(people(20, i => (i < 5 ? 'clip it' : 'haha')));
  assert.ok(f.clipRequest > 0.2 && f.clipRequest < 0.3, `got ${f.clipRequest}`);
});

test('rates use the stated window, not the message span', () => {
  const f = windowFeatures(people(40, () => 'x'), { windowMs: 4000 });
  assert.equal(f.msgRate, 10);
  assert.equal(f.chatterRate, 10);
});

test('an empty window is all zeros rather than NaN', () => {
  const f = windowFeatures([], { windowMs: 4000 });
  for (const [k, v] of Object.entries(f)) {
    assert.ok(Number.isFinite(v), `${k} was ${v}`);
    assert.equal(v, 0);
  }
});

test('a window of only commands reports the share and nothing else', () => {
  const f = windowFeatures(people(10, () => '!drop'), { windowMs: 4000 });
  assert.equal(f.commandShare, 1);
  assert.equal(f.messages, 0);
  for (const [k, v] of Object.entries(f)) assert.ok(Number.isFinite(v), `${k} was ${v}`);
});

test('blank and malformed messages do not break anything', () => {
  const f = windowFeatures([
    { user: 'a', text: '   ' }, { user: 'b', text: '' },
    null, { user: 'c' }, { user: 'd', text: 'real message here' },
  ], { windowMs: 4000 });
  assert.equal(f.messages, 1);
  assert.ok(Number.isFinite(convergence(f)));
});
