import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatHighlights, captionFilters, layoutHeadline } from '../src/caption.mjs';
import { StreamBuffer } from '../src/buffer.mjs';

test('chat highlights deduplicate but keep the count', () => {
  const window = [
    { text: 'KEKW' }, { text: 'kekw' }, { text: 'KEKW ' },
    { text: 'heist' }, { text: 'heist' },
    { text: 'that was actually the funniest thing i have seen all week honestly' },
    { text: 'LETS GO' },
  ];
  const out = chatHighlights(window);
  assert.ok(out[0].startsWith('KEKW'), `expected KEKW first, got ${out[0]}`);
  assert.match(out[0], /x3/, 'should report the count, which is the point');
  assert.ok(out.some(l => l.startsWith('heist')));
  // Long sentences are conversation, not a chant: they do not belong on the overlay.
  assert.ok(!out.some(l => l.includes('funniest thing')));
});

test('emoji are stripped so Arial does not render tofu boxes', () => {
  const out = chatHighlights([{ text: 'LOL 😂😂' }, { text: 'LOL 😂😂' }]);
  assert.strictEqual(out[0].replace(/\s+x\d+$/, ''), 'LOL');
});

test('caption text goes through textfile, never inline text=', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  try {
    // Chat full of ffmpeg filter delimiters. Inlining this would break the filter
    // graph at best, and allow injection into it at worst.
    const { filters } = captionFilters({
      hook: 'chat lost it',
      chatLines: ["it's 3:30, drawtext=evil:x=0,y=0 [a];[b]"],
      tmpDir: dir,
      font: '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      videoTop: 705, videoBottom: 1695,
    });
    assert.ok(filters.length >= 2);
    for (const f of filters) {
      assert.match(f, /textfile='/, 'must pass text by file');
      assert.ok(!/(^|:)text=/.test(f), `inline text= found in: ${f}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buffer maps strftime segment names back to wall-clock windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buf-'));
  try {
    for (const n of ['seg_20261121-190000.ts', 'seg_20261121-190004.ts', 'seg_20261121-190008.ts']) {
      writeFileSync(join(dir, n), 'x'.repeat(4096));
    }
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');

    const segs = new StreamBuffer('ch', { dir }).segments();
    assert.strictEqual(segs.length, 3, 'non-.ts files must be ignored');

    const t0 = new Date(2026, 10, 21, 19, 0, 0).getTime();
    assert.strictEqual(segs[0].startMs, t0);
    // Each segment ends where the next begins...
    assert.strictEqual(segs[0].endMs, t0 + 4000);
    assert.strictEqual(segs[1].endMs, t0 + 8000);
    // ...except the last, which is still being written, so it runs to now.
    assert.ok(segs[2].endMs > segs[2].startMs);
    assert.ok(segs.every((s, i, a) => i === 0 || s.startMs >= a[i - 1].startMs), 'must be sorted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('headline wraps without breaking words, and refuses impossible ones', () => {
  const fit = layoutHeadline('CHAT LOST IT AT THIS GTA 6 MOMENT', { maxWidth: 960 });
  assert.ok(fit.lines.length <= 3);
  // No line may end mid-word: every line is whole words from the original.
  const rejoined = fit.lines.join(' ').replace(/\s+/g, ' ');
  assert.strictEqual(rejoined, 'CHAT LOST IT AT THIS GTA 6 MOMENT');

  // A word wider than the canvas cannot be wrapped OR shrunk into legibility.
  // The headline has to be rewritten, so the caller is told rather than shipped
  // a frame with the word sliced in half.
  const bad = layoutHeadline('supercalifragilisticexpialidociousness happened', { maxWidth: 300 });
  assert.ok(bad.error, 'expected an error for an unfittable word');
  assert.match(bad.error, /too long/);
});
