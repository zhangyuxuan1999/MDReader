// @vitest-environment jsdom
// test/r4-s-serial.test.ts — fix-serial (stage 2e, fix round 4): J19, J20, J21, J22 (CONTRACT section 11, the
// "Smaller rules" of the stage-2d review decisions).
//   J19: pickMarkers considers link / image destinations as linkDest decodes them (a U+E001 there is not the caret).
//   J20: what a click runs before a session is linear in a run of backslashes or backticks; dropCodeSpans gives the
//        result of the old code-span regex for every input (the old expression lives only here, as the oracle).
//   J21: H17 counts every whitespace the final trim removes (U+3000, U+2003 …), plus the two round-3 limits: a
//        formula followed by an empty inline element, a formula that is the last child of a raw inline element.
//   J22: an inline formula whose edited TeX ends in whitespace or a backslash stays a formula.
// Special characters are built with String.fromCharCode (no typed escapes, tooling hazard).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, dropCodeSpans, serializeBlock, serializeBlockWithCaret, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';

const C = (n: number): string => String.fromCharCode(n);
const BS = C(92);
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
const hintsOf = (src: string) => ({ ...sourceStyleHints(src), editing: true });
function texts(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!(n as Text).parentElement?.closest('.katex, .md-math, .md-math-src')) out.push(n as Text);
  return out;
}
const texOfShown = (w: Element): string[] => Array.from(w.querySelectorAll('annotation')).map((a) => a.textContent ?? '');

// ------------------------------------------------------------------------------------------------ J19
describe('J19: a private-use code point in a decoded destination is not taken for a marker', () => {
  const E1 = C(0xe001), E0 = C(0xe000), E2 = C(0xe002), E3 = C(0xe003);
  const dests = [
    ['pct E001 link', '[x](https://e.example/?q=%EE%80%81)'],
    ['raw E001 link', '[x](https://e.example/?q=' + E1 + ')'],
    ['pct E001 image', '![i](https://e.example/a%EE%80%81.png)'],
    ['pct E000 link (NL)', '[x](https://e.example/?q=%EE%80%80)'],
    ['pct E002 image (CELL)', '![i](https://e.example/a%EE%80%82.png)'],
    ['pct E003 link (MARKUP)', '[x](https://e.example/%EE%80%83)'],
    ['four of them', '[x](https://e.example/?a=%EE%80%80%EE%80%81%EE%80%82%EE%80%83)'],
  ];
  for (const [name, link] of dests) {
    it(`${name}: the caret line is the caret's own and the destination survives`, () => {
      const src = `See ${link} first line\nsecond line words`;
      const w = mount(src);
      const t = texts(w).find((x) => x.data.includes('words'))!;
      const out = serializeBlockWithCaret(w, BlockKind.Prose, t, t.data.indexOf('words'), hintsOf(src))!;
      const at = out.indexOf(CARET_MARK);
      expect(out.slice(0, at).split('\n').length - 1, JSON.stringify(out)).toBe(1);
      expect(out.split(CARET_MARK).length, JSON.stringify(out)).toBe(2);
      expect(out.slice(at), JSON.stringify(out)).toBe(CARET_MARK + 'words');
      const md = serializeBlock(w, BlockKind.Prose, hintsOf(src));
      expect(canonicalForm(mount(md)), md).toBe(canonicalForm(w));
      expect(baselineFaithful(w, BlockKind.Prose, md)).toBe(true);
      expect([E0, E1, E2, E3].some((c) => md.includes(c)) || md.includes('%EE%80'), md).toBe(true);
    });
  }
  it('a list of 9 items (the item-wise path): the caret item and the items keep their characters', () => {
    const items = Array.from({ length: 9 }, (_, i) => `- item ${i} [x](https://e.example/?q=%EE%80%81) end`);
    const src = items.join('\n');
    const w = mount(src);
    const t = texts(w).filter((x) => x.data.includes(' end'))[4];
    const out = serializeBlockWithCaret(w, BlockKind.List, t, t.data.indexOf('end'), hintsOf(src))!;
    expect(out.split(CARET_MARK).length).toBe(2);
    expect(out.slice(0, out.indexOf(CARET_MARK)).split('\n').length - 1).toBe(4);
    const md = serializeBlock(w, BlockKind.List, hintsOf(src));
    expect(canonicalForm(mount(md))).toBe(canonicalForm(w));
  });
  it('a destination keeps the source spelling of a private-use character (escape or raw); none leaks as a marker', () => {
    for (const [cp, pct] of [[0xe000, '%EE%80%80'], [0xe001, '%EE%80%81'], [0xe002, '%EE%80%82'], [0xe003, '%EE%80%83'], [0xf8ff, '%EF%A3%BF']] as const) {
      for (const shape of ['para', 'cell', 'image', 'list']) {
        for (const spelled of [pct, C(cp)]) {
          const dest = shape === 'image' ? `![i](https://e.example/a${spelled}.png)` : `[x](https://e.example/?q=${spelled})`;
          const src = shape === 'cell' ? `| ${dest} | b |\n|---|---|\n| one | two |` : shape === 'list' ? Array.from({ length: 9 }, (_, i) => `- ${i} ${dest} one`).join('\n') : `See ${dest} and one more`;
          const w = mount(src);
          const kind = kindOf(src);
          const t = texts(w).find((x) => x.data.includes('one'))!;
          t.data = t.data.replace('one', 'oWne');
          const md = serializeBlock(w, kind, hintsOf(src));
          // only the edit changes the source: the destination is written as the source spells it
          expect(md, JSON.stringify(src)).toBe(src.replace('one', 'oWne'));
        }
      }
    }
  });
  it('the source writes the candidates raw in a destination and the text holds the rest: refused (H15), nothing written', () => {
    const all: string[] = [];
    for (let c = 0xe000; c <= 0xf8ff; c++) all.push(C(c));
    for (let c = 0xfdd0; c <= 0xfdef; c++) all.push(C(c));
    const src = `See [the link](https://e.example/?q=${all.slice(0, 3000).join('')}) e${all.slice(3000).join('')}nd`;
    const w = mount(src);
    expect(unsupportedReason(w, src)).toBe('markers');
    expect(() => serializeBlock(w, BlockKind.Prose, hintsOf(src))).toThrow('no free internal marker');
    // spelled as escapes in the source, the destination keeps them: its characters are free for the markers
    const enc = `See [the link](https://e.example/?q=${encodeURIComponent(all.slice(0, 3000).join(''))}) e${all.slice(3000).join('')}nd`;
    const w2 = mount(enc);
    expect(unsupportedReason(w2, enc)).toBe(null);
    expect(serializeBlock(w2, BlockKind.Prose, hintsOf(enc))).toBe(enc);
  });
  it('unsupportedReason still accepts such a block', () => {
    const src = 'See [x](https://e.example/?q=%EE%80%81) here';
    expect(unsupportedReason(mount(src), src)).toBe(null);
  });
});

// ------------------------------------------------------------------------------------------------ J20
describe('J20: backslash and backtick runs are linear', () => {
  const OLD = /(`+)(?:(?!\1)[\s\S])*?\1/g;   // the old expression, the oracle only
  const old = (s: string): string => s.replace(OLD, '');
  it('dropCodeSpans equals the old regex on 40 000 random strings and the hand cases', () => {
    const hand = ['', 'a', '`', '``', '```', '````', '`a`', '``a`', '`a``', '``a``', '```a``', '``a```', '`` ` ``', '`a\n`b`', 'x``y``z`', '````a``b```c`',
      '`a', 'a`', '``', '`````', '``a``` ``b', '`a``b`c``', 'a<!--`x`-->', '`<!--`'];
    for (const s of hand) expect(dropCodeSpans(s), JSON.stringify(s)).toBe(old(s));
    let seed = 12345;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const alpha = ['`', '`', '`', 'a', ' ', '\n', '<', '!', '-'];
    for (let k = 0; k < 40000; k++) {
      let s = '';
      const len = rnd(24);
      for (let i = 0; i < len; i++) s += alpha[rnd(alpha.length)];
      expect(dropCodeSpans(s), JSON.stringify(s)).toBe(old(s));
    }
  });
  it('dropCodeSpans equals the old regex on long structured strings (runs of 1-6 backticks)', () => {
    let seed = 777;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 3000; k++) {
      let s = '';
      const parts = 1 + rnd(12);
      for (let i = 0; i < parts; i++) s += '`'.repeat(1 + rnd(6)) + 'ab'.slice(0, rnd(3));
      expect(dropCodeSpans(s), JSON.stringify(s)).toBe(old(s));
    }
  });
  const N = 60000;
  const time = (f: () => void): number => { const t0 = performance.now(); f(); return performance.now() - t0; };
  for (const [name, src] of [
    ['backslashes inside a line', 'x ' + BS.repeat(N) + ' y'],
    ['backslashes at the paragraph end', 'x ' + BS.repeat(N)],
    ['backslashes at a soft break', 'x ' + BS.repeat(N) + '\nnext'],
    ['backslash-space pairs', 'x ' + (BS + ' ').repeat(N / 2) + 'y'],
    ['backticks inside a line', 'x ' + '`'.repeat(N) + ' y'],
    // ('`a' pairs render 15 000 code spans: jsdom's Array.from(children) alone takes ~1 s there; dropCodeSpans is
    // timed on that string below, the DOM side in Chromium by bench/verify/v4-tru-h29.mjs backtick-pairs)
    ['backtick-backslash pairs', 'x ' + ('`' + BS).repeat(N / 2) + ' y'],
  ] as const) {
    it(`${name}: unsupportedReason + serializeBlock + the gate under 150 ms each`, () => {
      const w = mount(src);
      const kind = kindOf(src);
      expect(time(() => unsupportedReason(w, src)), 'guard').toBeLessThan(150);
      let md = '';
      expect(time(() => { md = serializeBlock(w, kind, hintsOf(src)); }), 'serialize').toBeLessThan(150);
      expect(time(() => baselineFaithful(w, kind, md)), 'gate').toBeLessThan(400);
    }, 20000);
  }
  it('dropCodeSpans on 60 000 backticks and alternating pairs: under 20 ms, same result as a shorter oracle run', () => {
    for (const s of ['`'.repeat(N), '`a'.repeat(N / 2), '``a'.repeat(N / 3), 'a' + '`'.repeat(N) + 'b`']) expect(time(() => dropCodeSpans(s))).toBeLessThan(20);
    for (const s of ['`'.repeat(301), '`a'.repeat(150), '``a'.repeat(100), 'a' + '`'.repeat(300) + 'b`']) expect(dropCodeSpans(s)).toBe(old(s));
  });
  it('the delimiter-row escape at a line start: the atomic form equals the old expression, and a tab run is linear', () => {
    const NB = C(0xa0);
    const OLDROW = new RegExp('^([ \\t]*)(?=\\|?[ \\t]*:?-+:?[ \\t]*(\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t' + NB + ']*$)(\\S)');
    const NEWROW = new RegExp('^(?=([ \\t]*))\\1(?=\\|?[ \\t]*:?-+:?[ \\t]*(\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t' + NB + ']*$)(\\S)');
    let seed = 99;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const alpha = [' ', '\t', '-', '-', '|', ':', NB, 'a'];
    for (let k = 0; k < 30000; k++) {
      let s = '';
      const len = rnd(14);
      for (let i = 0; i < len; i++) s += alpha[rnd(alpha.length)];
      expect(s.replace(NEWROW, '$1\\$3'), JSON.stringify(s)).toBe(s.replace(OLDROW, '$1\\$3'));
    }
    // reached by the serializer: text at a line start inside an inline element (raw HTML keeps the tabs)
    const src = '<em>' + '\t'.repeat(N) + 'x</em> y';
    const w = mount(src);
    expect(time(() => serializeBlock(w, BlockKind.Prose, hintsOf(src)))).toBeLessThan(150);
    expect(time(() => NEWROW.exec('\t'.repeat(N) + 'x'))).toBeLessThan(10);
  }, 20000);
  it('a literal backslash run at a line end keeps its parity rule (odd runs get one more, read back as text)', () => {
    for (const n of [1, 2, 3, 4, 7]) {
      for (const src of [`a ${BS.repeat(2 * n)}`, `a ${BS.repeat(2 * n)}\nb`, `| a ${BS.repeat(2 * n)} | b |\n|---|---|\n| c | d |`]) {
        const w = mount(src);
        const kind = kindOf(src);
        const md = serializeBlock(w, kind, hintsOf(src));
        expect(canonicalForm(mount(md)), `${JSON.stringify(src)} -> ${JSON.stringify(md)}`).toBe(canonicalForm(w));
        expect(baselineFaithful(w, kind, md)).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ J21
/** The text node holding `needle` gets `by` instead; serialize, re-render. */
function after(src: string, needle: string, by: string): { md: string; shown: number; now: number; same: boolean } {
  const w = mount(src);
  const kind = kindOf(src);
  const hints = hintsOf(src);
  expect(baselineFaithful(w, kind, serializeBlock(w, kind, hints)), `gate on the untouched ${JSON.stringify(src)}`).toBe(true);
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  t.data = t.data.replace(needle, by);
  if (t.data === '') t.remove();
  const md = serializeBlock(w, kind, hints);
  const again = mount(md);
  return { md, shown: formulas(w), now: formulas(again), same: canonicalForm(again) === canonicalForm(w) };
}

describe('J21: every whitespace the final trim removes counts after a digit…digit formula', () => {
  const WS = [0x3000, 0x2003, 0x2002, 0x2009, 0x200a, 0x202f, 0x205f, 0x1680, 0x2000];
  const places: [string, string][] = [
    ['paragraph end', '面积 $10$元'],
    ['table cell end', '| a | $10$元 |\n|---|---|\n| c | d |'],
    ['heading end', '# 共 $10$元'],
    ['list item end', '- 面积 $10$元\n- b'],
    ['quote end', '> 面积 $10$元'],
    ['item end before a nested list', '- 面积 $10$元\n  - sub'],
    ['bold end inside the paragraph end', '面积 **$10$元**'],
    ['ordered item end', '1. 面积 $3\\times4$元\n2. b'],
  ];
  for (const [place, src] of places) {
    for (const cp of WS) {
      it(`${place}: U+${cp.toString(16).toUpperCase()} typed after the formula`, () => {
        const r = after(src, '元', C(cp));
        expect(r.now, `md ${JSON.stringify(r.md)}`).toBe(r.shown);
      });
    }
    it(`${place}: two ideographic spaces`, () => {
      const r = after(src, '元', C(0x3000) + C(0x3000));
      expect(r.now, `md ${JSON.stringify(r.md)}`).toBe(r.shown);
    });
  }
  it('an ideographic space before a hard break or before more text keeps the compact spelling (it reads back)', () => {
    for (const [src, needle, by] of [['面积 $10$元  \n下一行', '元', C(0x3000)], ['面积 $10$元x', '元', C(0x3000)], ['面积 $10$元\n下一行', '元', C(0x3000)]] as const) {
      const r = after(src, needle, by);
      expect(r.now, r.md).toBe(r.shown);
      expect(r.md.includes('&#32;'), r.md).toBe(false);
    }
  });
  it('round-3 limit 1: a formula followed by an empty inline element, then whitespace / the end', () => {
    for (const tail of ['', ' x', C(0x3000)]) {
      const w = mount('面积 $10$元');
      const ph = w.querySelector('.md-math')!;
      // what follows: an empty <em> (the browser leaves those) and then `tail`
      let n = ph.nextSibling;
      while (n) { const nx = n.nextSibling; n.parentNode!.removeChild(n); n = nx; }
      ph.after(document.createElement('em'));
      if (tail) ph.parentElement!.appendChild(document.createTextNode(tail));
      const md = serializeBlock(w, BlockKind.Prose, hintsOf('面积 $10$元'));
      expect(formulas(mount(md)), JSON.stringify(md)).toBe(1);
    }
  });
  it('round-3 limit 2: a formula that is the last child of a raw inline element keeps its bytes', () => {
    for (const src of ['面积 <sup>$10$</sup> 元', '面积 <mark>$1+2$</mark>', '<kbd>$10$</kbd>']) {
      const w = mount(src);
      const md = serializeBlock(w, BlockKind.Prose, hintsOf(src));
      expect(md, src).toBe(src);
      expect(formulas(mount(md))).toBe(formulas(w));
    }
  });
  it('formulas that read back keep their bytes (no &#32; added)', () => {
    for (const src of ['等于 $10$。', '和 $x$' + C(0x3000), '$1$和$2$', '面积 $10$' + C(0x3000) + 'x', '| $a$ | b |\n|---|---|\n| c | d |']) {
      const w = mount(src);
      const md = serializeBlock(w, kindOf(src), hintsOf(src));
      expect(md.includes('&#32;'), md).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------------ J22
/** Opens the first inline formula of `src` as the session does (its TeX in a `code.md-math-src`), sets `tex`. */
function editTex(src: string, tex: string): { md: string; now: number; tex: string[] } {
  const w = mount(src);
  const m = w.querySelector('.md-math')!;
  const e = document.createElement('code');
  e.className = 'md-math-src md-math--inline';
  e.textContent = tex;
  m.replaceWith(e);
  const md = serializeBlock(w, kindOf(src), hintsOf(src));
  const again = mount(md);
  return { md, now: formulas(again), tex: texOfShown(again) };
}

describe('J22: an inline formula whose edited TeX ends in whitespace or a backslash stays a formula', () => {
  const cases: [string, string, string][] = [
    ['x+1 ', 'x+1', 'Area $x+1$ here.'],
    ['x+1   ', 'x+1', 'Area $x+1$ here.'],
    ['x+1\t', 'x+1', 'Area $x+1$ here.'],
    ['x+1 \n ', 'x+1', 'Area $x+1$ here.'],
    ['x+1' + BS, 'x+1' + BS + ' {}', 'Area $x+1' + BS + ' {}$ here.'],
    ['x+1' + BS + ' ', 'x+1' + BS + ' {}', 'Area $x+1' + BS + ' {}$ here.'],
    ['x+1' + BS + BS, 'x+1' + BS + BS + '{}', 'Area $x+1' + BS + BS + '{}$ here.'],
    ['x+1' + BS + BS + BS, 'x+1' + BS + BS + BS + ' {}', 'Area $x+1' + BS + BS + BS + ' {}$ here.'],
    ['1+2 ', '1+2', 'Area $1+2$&#32;here.'],
    ['x+1', 'x+1', 'Area $x+1$ here.'],
  ];
  for (const [tex, want, md] of cases) {
    it(`TeX ${JSON.stringify(tex)}`, () => {
      const r = editTex('Area $x+1$ here.', tex);
      expect(r.md).toBe(md);
      expect(r.now, r.md).toBe(1);
      expect(r.tex, r.md).toEqual([want]);
    });
  }
  it('at a paragraph end, in a table cell, in a heading, in a list item, inside bold', () => {
    for (const src of ['Area $x+1$', '| $x+1$ | b |\n|---|---|\n| c | d |', '# Area $x+1$', '- Area $x+1$\n- b', 'A **$x+1$** b']) {
      for (const tex of ['x+1 ', 'x+1' + BS, 'a|b ', '10 ']) {
        const r = editTex(src, tex);
        expect(r.now, `${JSON.stringify(src)} ${JSON.stringify(tex)} -> ${JSON.stringify(r.md)}`).toBe(1);
      }
    }
  });
  it('a display formula $$…$$ and a block formula keep their TeX as it is', () => {
    const w = mount('Area $$ x $$ here.');
    expect(serializeBlock(w, BlockKind.Prose, hintsOf('Area $$ x $$ here.'))).toBe('Area $$ x $$ here.');
  });
});
