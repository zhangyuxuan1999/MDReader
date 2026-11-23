// @vitest-environment jsdom
// test/v5-rev-autolink.test.ts — verify-review (0.2.0 round 4): REV-1. A bare URL (linkify) or an autolink <url> whose
// percent-escapes decode to an invisible character (U+200B, U+FEFF, U+00A0, U+202E, U+3000, a private-use code point)
// is written back with that character RAW when the session edits anything else in the block: the escape the source
// held (visible, 9 bytes) becomes an invisible character the user did not type (the href is the same). This is the
// J19 rule's own sentence ("an invisible character the source does not hold is never written") on the other path that
// writes a destination: serialize.ts mdrLink writes '<' + text + '>' / text from data-mdr-text, the link's SHOWN text,
// which markdown-it's normalizeLinkText decoded; linkDest/decodedDest is not on that path.
// FAILS today (defines "fixed"): every case of 'REV-1 tree'. The 'snapshots' describe printed what pre-r4 / pre-r3 wrote
// (informational, always passes); since round 7 (CONTRACT §11 Checkpoint I) those snapshots are gone and both columns are
// the released 0.2.0's (test/fixtures/src-0.2.0). Special characters built with String.fromCharCode. Bounded: < 10 s.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import * as pre4 from './fixtures/src-0.2.0/preview/serialize';
import * as pre3 from './fixtures/src-0.2.0/preview/serialize';

const C = (n: number): string => String.fromCharCode(n);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return w;
}
const INVISIBLE = [0x200b, 0xfeff, 0xa0, 0x202e, 0x3000, 0xe001];
const invisibles = (s: string): string[] => Array.from(s).filter((c) => INVISIBLE.includes(c.charCodeAt(0)) || (c >= C(0xe000) && c <= C(0xf8ff))).map((c) => c.charCodeAt(0).toString(16));
const hrefs = (w: Element): string[] => Array.from(w.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
/** What the session writes after typing X after "words" in the block's second line (the URL itself untouched). */
function edit(ser: typeof pre4, src: string): string {
  const w = mount(src);
  const tw = document.createTreeWalker(w, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); break; }
  const md = ser.serializeBlock(w, BlockKind.Prose, { ...ser.sourceStyleHints(src), editing: true });
  w.remove();
  return md;
}
const ESC: [string, string][] = [['ZWSP', '%E2%80%8B'], ['BOM', '%EF%BB%BF'], ['NBSP', '%C2%A0'], ['RLO', '%E2%80%AE'], ['U+3000', '%E3%80%80'], ['U+E001', '%EE%80%81']];
const SHAPES: [string, (e: string) => string][] = [
  ['bare URL', (e) => 'See https://e.example/?q=a' + e + 'b here\nsecond line words'],
  ['autolink', (e) => 'See <https://e.example/?q=a' + e + 'b> here\nsecond line words'],
  ['bare URL in a list item', (e) => '- see https://e.example/a' + e + 'b\n  second line words'],
  ['inline link destination', (e) => 'See [x](https://e.example/a' + e + 'b) here\nsecond line words'],
  ['image source', (e) => 'See ![i](https://e.example/a' + e + 'b.png) here\nsecond line words'],
];

describe('REV-1 tree: the session writes no invisible character the source did not hold', () => {
  for (const [en, e] of ESC) for (const [sn, mk] of SHAPES) {
    it(`${sn} with ${en} (${e})`, () => {
      const src = mk(e);
      const w = mount(src);
      // the click's gates let the block in (no refusal: K4 does not apply)
      expect(unsupportedReason(w, src)).toBe(null);
      expect(baselineFaithful(w, BlockKind.Prose, serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true }))).toBe(true);
      const before = hrefs(w);
      w.remove();
      const md = edit(pre4 as unknown as typeof pre4, src) && edit({ serializeBlock, sourceStyleHints } as unknown as typeof pre4, src);
      expect(hrefs(mount(md)), 'same href').toEqual(before);
      expect(invisibles(md), JSON.stringify(md)).toEqual(invisibles(src));
    });
  }
});

describe('snapshots (informational): what the released 0.2.0 writes for the same edit', () => {
  it('prints', () => {
    for (const [en, e] of ESC) {
      const src = SHAPES[0][1](e);
      console.log(en, 'tree', JSON.stringify(edit({ serializeBlock, sourceStyleHints } as unknown as typeof pre4, src)), '0.2.0', JSON.stringify(edit(pre4, src)), '0.2.0', JSON.stringify(edit(pre3 as unknown as typeof pre4, src)));
    }
    const zh = 'See https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87 here\nsecond line words';
    console.log('visible', JSON.stringify(edit({ serializeBlock, sourceStyleHints } as unknown as typeof pre4, zh)));
  });
});
