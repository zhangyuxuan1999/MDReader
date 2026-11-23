// @vitest-environment jsdom
// test/r3-s-markers.test.ts — fix-serial (stage 2d, fix round 3), H15 (REV-4).
//
// Decision H15 (CONTRACT §11, Stage-2c review decisions): when pickMarkers() finds no free marker set, every
// serializer entry point refuses: serializeBlock and serializeBlockWithCaret throw NoMarkersError (nothing is
// serialized, so nothing can be written), unsupportedReason says 'markers'. Before round 3 both ran with the
// markers of the previous call (a document character became a line break, a table cell separator, …).
import { describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { NoMarkersError, serializeBlock, serializeBlockWithCaret, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

const mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  return w;
}
/** The marker range without the code points in `keepFree`. */
function range(keepFree: number[] = []): string {
  let s = '';
  for (const [lo, hi] of [[0xe000, 0xf8ff], [0xfdd0, 0xfdef]]) for (let c = lo; c <= hi; c++) if (!keepFree.includes(c)) s += String.fromCharCode(c);
  return s;
}
function refused(f: () => unknown): boolean {
  try { f(); return false; } catch (e) { return e instanceof NoMarkersError; }
}
const hints = (src: string) => ({ ...sourceStyleHints(src), editing: true });

describe('H15: no free marker set means nothing is serialized', () => {
  for (const [name, src, kind] of [
    ['paragraph', 'Hello world', BlockKind.Prose],
    ['heading', '# Title', BlockKind.Heading],
    ['table', '| a | b |\n| --- | --- |\n| c | d |', BlockKind.Table],
    ['list (item-wise cache path, 9 items)', Array.from({ length: 9 }, (_, i) => `- item ${i}`).join('\n'), BlockKind.List],
    ['blockquote', '> quoted', BlockKind.Quote],
  ] as const) {
    it(`${name}: after an ordinary call, a text with every marker code point is refused by both entry points`, () => {
      const w = mount(src);
      expect(unsupportedReason(w, src)).toBeNull();
      expect(typeof serializeBlock(w, kind, hints(src))).toBe('string');       // markers U+E000…U+E003 picked
      const host = w.querySelector('td, li, p, h1') as Element;
      const t = document.createTextNode(' ' + range());
      host.appendChild(t);
      expect(refused(() => serializeBlock(w, kind, hints(src)))).toBe(true);
      expect(refused(() => serializeBlock(w, kind, { ...hints(src), uncached: true }))).toBe(true);
      expect(refused(() => serializeBlockWithCaret(w, kind, t, 1, hints(src)))).toBe(true);
      expect(unsupportedReason(w, src)).toBe('markers');
      // a position outside the block is still null (not the refusal)
      expect(serializeBlockWithCaret(w, kind, document.createTextNode('x'), 0, hints(src))).toBeNull();
      // and an ordinary block right after is serialized with fresh markers
      const o = mount('plain *text*');
      expect(serializeBlock(o, BlockKind.Prose, hints('plain *text*'))).toBe('plain *text*');
    });
  }

  it('the marker code points in an attribute value count too', () => {
    const w = mount('a [link](https://e.com/) b');
    w.querySelector('a')!.setAttribute('title', range());
    expect(refused(() => serializeBlock(w, BlockKind.Prose, {}))).toBe(true);
  });

  it('exactly four free code points: serialized, every character kept', () => {
    const free = [0xe007, 0xf123, 0xfdd4, 0xfdef];
    const pua = range(free);
    const w = mount('Glyphs: end');
    w.querySelector('p')!.appendChild(document.createTextNode(pua));
    const md = serializeBlock(w, BlockKind.Prose, {});
    expect({ lines: md.split('\n').length, length: md.length, same: md === 'Glyphs: end' + pua }).toEqual({ lines: 1, length: 11 + pua.length, same: true });
    const t = w.querySelector('p')!.lastChild as Text;
    const m = serializeBlockWithCaret(w, BlockKind.Prose, t, 5, {});
    expect(m).not.toBeNull();
    expect(m!.split('\n').length).toBe(1);
  });

  it('three free code points: refused', () => {
    const w = mount('Glyphs: end');
    w.querySelector('p')!.appendChild(document.createTextNode(range([0xe100, 0xf000, 0xfdd9])));
    expect(refused(() => serializeBlock(w, BlockKind.Prose, {}))).toBe(true);
    expect(unsupportedReason(w)).toBe('markers');
  });
});
