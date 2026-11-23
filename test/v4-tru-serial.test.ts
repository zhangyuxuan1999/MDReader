// @vitest-environment jsdom
// test/v4-tru-serial.test.ts — verify-trust (stage 2d re-verification, round 3): serializer variations of H15, H17 and
// H29 (CONTRACT §11, smaller rules) that the fixers' tests do not cover. A case that FAILS today defines "fixed":
//   - 'TRU caret marker: …'  (serializeBlockWithCaret finds a CARET_MARK decoded from a link destination)
//   - 'TRU H29: …'           (two quadratic regexes on a click before a session starts)
// Everything else is expected to pass (variations that hold). Bounded: each case well under 20 s.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, serializeBlock, serializeBlockWithCaret, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  document.body.appendChild(w);
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
const formulas = (w: Element): number => w.querySelectorAll('.md-math').length;
function texts(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!(n as Text).parentElement?.closest('.katex, .md-math')) out.push(n as Text);
  return out;
}
/** Edits the DOM like a session would (the text node holding `needle` gets `by` instead), serializes, re-renders. */
function after(src: string, needle: string, by: string): { md: string; shown: number; now: number; same: boolean } {
  const w = mount(src);
  const kind = kindOf(src);
  const hints = { ...sourceStyleHints(src), editing: true };
  expect(baselineFaithful(w, kind, serializeBlock(w, kind, hints)), `gate on the untouched ${JSON.stringify(src)}`).toBe(true);
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  t.data = t.data.replace(needle, by);
  if (t.data === '') t.remove();
  const md = serializeBlock(w, kind, hints);
  const again = mount(md);
  return { md, shown: formulas(w), now: formulas(again), same: canonicalForm(again) === canonicalForm(w) };
}

describe('H17 variations: a digit…digit formula stays a formula after an edit (expected to hold)', () => {
  const cases: [string, string, string][] = [
    ['等于 $10$元。', '元。', ''],                          // CJK text after it deleted
    ['| a | $10$元 |\n|---|---|\n| c | d |', '元', ''],     // the end of a table cell
    ['# 共 $10$个', '个', ''],                               // the end of a heading
    ['- 面积 $10$.\n  - sub', '.', ''],                      // before a nested list
    ['$1$和$2$。', '。', ''],                                // the second of two, the first unaffected
    ['$1$和$2$。', '和', ' '],                               // a space between two formulas
    ['和 $1+2$[x](https://e.example/)', 'x', ' x'],          // a link whose text now starts with a space
    ['> 面积 $10$元\n> 下一行', '元', ''],                   // before a soft break inside a quote
    ['面积 $10$元', '元', String.fromCharCode(0x3000)], // TRU H17: an ideographic space typed at the paragraph end
    ['面积 $10$元', '元', String.fromCharCode(0xa0)],   // TRU H17: a no-break space at the paragraph end
    ['面积 $10$元', '元', String.fromCharCode(0x2003)], // TRU H17: an em space at the paragraph end
    ['- 面积 $10$元\n- b', '元', String.fromCharCode(0x3000)], // TRU H17: the same at a list item end
    ['面积 $10$元x', '元', String.fromCharCode(0x3000)], // control: an ideographic space before more text
    ['面积 $10$元', '元', '  x'],                            // two spaces after it
    ['面积 $10$元', '元', '\n'],                             // a line feed typed after it
  ];
  for (const [src, needle, by] of cases) {
    it(`${JSON.stringify(src)}: ${JSON.stringify(needle)} -> ${JSON.stringify(by)}`, () => {
      const r = after(src, needle, by);
      expect(r.now, `md ${JSON.stringify(r.md)}`).toBe(r.shown);
    });
  }
  it('sources that already use the spelling keep it and pass the gate (list item end, cell end, heading end, tab)', () => {
    for (const src of ['- a $10$&#32;\n- b', '| $10$&#32; | b |\n|---|---|\n| c | d |', '# 共 $10$&#32;', '和 $1+2$&#9;x']) {
      const w = mount(src);
      const kind = kindOf(src);
      const md = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
      expect(md, src).toBe(src);
      expect(baselineFaithful(w, kind, md), src).toBe(true);
    }
  });
});

describe('H15 variation: the caret marker and decoded link destinations', () => {
  // pickMarkers() picks among code points absent from innerHTML; an href is percent-encoded there, but linkDest()
  // writes the decoded code point into the Markdown. With U+E001 (= CARET_MARK) in a link destination,
  // serializeBlockWithCaret() finds that character first: splitTarget() puts the resume on the link's line.
  for (const dest of ['https://e.example/?q=%EE%80%81', 'https://e.example/?q=' + String.fromCharCode(0xe001)]) {
    it(`TRU caret marker: the first CARET_MARK is the caret's own (${JSON.stringify(dest.slice(-9))})`, () => {
      const src = `See [x](${dest}) first line\nsecond line words`;
      const w = mount(src);
      const t = texts(w).find((x) => x.data.includes('words'))!;
      const out = serializeBlockWithCaret(w, BlockKind.Prose, t, t.data.indexOf('words'))!;
      const at = out.indexOf(CARET_MARK);
      expect(out.slice(0, at).split('\n').length - 1, JSON.stringify(out)).toBe(1);   // the caret is on line 2
    });
  }
  it('control: no private-use code point in the destination', () => {
    const src = 'See [x](https://e.example/?q=abc) first line\nsecond line words';
    const w = mount(src);
    const t = texts(w).find((x) => x.data.includes('words'))!;
    const out = serializeBlockWithCaret(w, BlockKind.Prose, t, t.data.indexOf('words'))!;
    expect(out.slice(0, out.indexOf(CARET_MARK)).split('\n').length - 1).toBe(1);
  });
});

describe('H29 variations: what a click runs before a session starts is linear', () => {
  const N = 58000;
  it('TRU H29: serializeBlock on a run of backslashes (serialize.ts `/\\\\+$/.exec(seg)`)', () => {
    const src = 'x ' + '\\'.repeat(N) + ' y';
    const w = mount(src);
    const t0 = performance.now();
    serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
    const ms = performance.now() - t0;
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(100);
  }, 20000);
  it('TRU H29: unsupportedReason on a run of backticks (stripCode `/(`+)(?:(?!\\1)[\\s\\S])*?\\1/g`)', () => {
    const src = 'x ' + '`'.repeat(N) + ' y';
    const w = mount(src);
    const t0 = performance.now();
    unsupportedReason(w, src);
    const ms = performance.now() - t0;
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(100);
  }, 20000);
  it('control: a run of spaces inside emphasis (H29 itself) stays fast', () => {
    const src = 'a *x' + ' '.repeat(N) + 'y* b';
    const w = mount(src);
    const t0 = performance.now();
    const md = serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
    baselineFaithful(w, BlockKind.Prose, md);
    expect(performance.now() - t0).toBeLessThan(300);
  }, 20000);
});
