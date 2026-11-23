// @vitest-environment jsdom
// test/r6-frb-rules.test.ts — fix-refs-b (0.2.0 stage 2g, fix round 6 after the challenge): CONTRACT §11 "Checkpoint H".
//  B1  HIDDEN by presence: a character the source spells as a reference outside code is HIDDEN whatever its raw count, so
//      a raw copy the session drops (both edges of a table cell, a cell of another row, text of raw HTML the sanitizer
//      removes) does not let its reference be written raw — in text, link text, an image alt, a link title.
//  B2  blockReveals: the block's Markdown holds a HIDDEN character raw no more often than the source holds it raw inside
//      code plus what the user put in.
//  B3  the alt, title and attribute writers write U+00A0 in the source's reference spelling; the text keeps K26.
//  T   sanitizerKept: one case for each kind of change the sanitizer makes (refused) and for each kind of raw HTML it
//      leaves alone (editable).
// Along the session's own path at unit level (the worker's rendering, the marks and stamps begin() sets, sourceStyleHints,
// the gate, rule T, S4, the guard and B2 at the start as startAllowed runs them, then a typed X, serializeBlock editing).
// Characters are built from code points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-frb-rules.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import * as S from '../src/preview/serialize';
import { baselineFaithful, sanitizerKept } from '../src/preview/fidelity';
import { blockReveals, writeReveals } from '../src/preview/inlineEdit';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
const IDSP = C(0x3000), EMSP = C(0x2003), SHY = C(0xad), ZWJ = C(0x200d), NBSP = C(0xa0), RLO = C(0x202e);
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

function kindOf(w: Element): BlockKind {
  const top = w.firstElementChild;
  if (!top) return BlockKind.Prose;
  if (top.tagName === 'UL' || top.tagName === 'OL') return BlockKind.List;
  if (/^H[1-6]$/.test(top.tagName)) return BlockKind.Heading;
  if (top.tagName === 'TABLE') return BlockKind.Table;
  if (top.tagName === 'BLOCKQUOTE') return BlockKind.Quote;
  return BlockKind.Prose;
}
interface Out { refused: string | null; base: string | null; out: string | null; hints: S.SerializeHints | null }
/** begin() and startAllowed() at unit level, then `typed` after the last `after` in the block's text. */
function session(src: string, typed = 'X', after = 'words', ruleT = true): Out {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = kindOf(w);
  const no = (why: string): Out => ({ refused: why, base: null, out: null, hints: null });
  if (S.unsupportedReason(w, src) !== null) return no('unsupported');
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true } as S.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, kind, hints); } catch { return no('markers'); }
  if (!baselineFaithful(w, kind, base)) return no('gate');
  if (ruleT && (src.includes('<') ? !sanitizerKept(src) : w.querySelector('a:not([href]), img:not([src])') !== null)) return no('T');
  if (hints.hidden && !baselineFaithful(w, kind, S.serializeBlock(w, kind, { ...hints, hidden: undefined }))) return no('S4');
  if (writeReveals(src, base) !== null || blockReveals(base, hints) !== null) return no('guard-start');
  const tw = document.createTreeWalker(w, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(after)) last = n as Text;
  if (!last) return no('no-text');
  const at = last.data.lastIndexOf(after) + after.length;
  last.data = last.data.slice(0, at) + typed + last.data.slice(at);
  return { refused: null, base, out: S.serializeBlock(w, kind, hints), hints };
}
const count = (s: string, sub: string): number => s.split(sub).length - 1;

// ---------------------------------------------------------------- B1 + B2: a dropped raw copy cannot pay for a reference
// [where the raw copy sits (the session drops it), the block source with the slot {R} for the reference context]
const IN_TABLE: Array<[string, (ctx: string) => string]> = [
  ['the start of the cell', (x) => `| h | k |\n| --- | --- |\n| ${IDSP}a ${x} words | end |`],
  ['the end of the cell', (x) => `| h | k |\n| --- | --- |\n| a ${x} words${IDSP} | end |`],
  ['both edges, an em space', (x) => `| h | k |\n| --- | --- |\n| ${EMSP}a ${x} words${EMSP} | end |`],
  ['a cell of another row', (x) => `| h | k |\n| --- | --- |\n| ${IDSP}a | b |\n| c | ${x} words |`],
  ['another cell of the same row', (x) => `| h | k |\n| --- | --- |\n| ${IDSP}a | ${x} words |`],
];
// [the reference context, its text with {r} for the reference]
const CONTEXTS: Array<[string, string]> = [
  ['text', 'y{r}z'],
  ['link text', '[l{r}k](https://e.example/p)'],
  ['an image alt', '![a{r}b](i.png)'],
  ['a link title', '[t](https://e.example/p "a{r}b")'],
  ['an image title', '![i](i.png "a{r}b")'],
];
describe('B1 + B2: the raw copy at a cell edge is dropped, the reference stays a reference', () => {
  for (const [where, block] of IN_TABLE) {
    for (const [ctx, tpl] of CONTEXTS) {
      const raw = where.includes('em space') ? EMSP : IDSP;
      for (const ref of raw === EMSP ? ['&emsp;', '&#8195;'] : ['&#x3000;', '&#12288;']) {
        it(`${where}, ${ctx}, ${ref}`, () => {
          const src = block(tpl.replace('{r}', ref));
          const r = session(src);
          expect(r.refused, show(src)).toBe(null);
          const out = r.out!;
          expect(count(out, ref), show(out)).toBe(count(src, ref));
          expect(count(out, raw), show(out)).toBe(0);
          expect(r.hints!.hidden?.get(raw), show(out)).toBe(ref);
          expect(blockReveals(out, r.hints!, new Map([['X', 1]]))).toBe(null);
          expect(writeReveals(src, out, new Map([['X', 1]]))).toBe(null);
        });
      }
    }
  }
});

// The raw copy inside raw HTML the sanitizer removes: rule T refuses such a block at the start; with rule T switched
// off in this harness, B1 alone already keeps the reference.
const IN_HTML: Array<[string, (ctx: string) => string]> = [
  ['an attribute the sanitizer removes', (x) => `Para <span onclick="c${SHY}d">s</span> ${x} words`],
  ['an element the sanitizer removes', (x) => `Para <script>c${SHY}d</script> ${x} words`],
  ['an href the sanitizer removes', (x) => `Para <a href="javascript:c${SHY}d">s</a> ${x} words`],
  ['an inline frame', (x) => `Para <iframe src="x${SHY}y"></iframe> ${x} words`],
];
describe('B1 + rule T: the raw copy inside sanitized raw HTML', () => {
  for (const [where, block] of IN_HTML) {
    for (const [ctx, tpl] of CONTEXTS) {
      it(`${where}, ${ctx}`, () => {
        const src = block(tpl.replace('{r}', '&shy;'));
        expect(session(src).refused, show(src)).toBe('T');
        const r = session(src, 'X', 'words', false);
        expect(r.refused, show(src)).toBe(null);
        expect(count(r.out!, '&shy;'), show(r.out)).toBe(1);
        expect(count(r.out!, SHY), show(r.out)).toBe(0);
        expect(blockReveals(r.out!, r.hints!, new Map([['X', 1]]))).toBe(null);
      });
    }
  }
});

describe('B1: other spellings that hide a character', () => {
  it('a bare URL escape shown decoded, a raw copy at a cell edge', () => {
    const src = `| h | k |\n| --- | --- |\n| ${ZWJ}a | https://e.example/a%E2%80%8Db words |`;
    const r = session(src);
    expect(r.hints?.hidden?.get(ZWJ), show(src)).toBe('&#x200D;');
  });
  it('a reference of a character the source holds raw as well, both shown: both are references (S2)', () => {
    const r = session(`Lead a${SHY}b and c&shy;d words`);
    expect(r.out).toBe('Lead a&shy;b and c&shy;d wordsX');
  });
  it('a reference inside code only does not hide a raw copy in text', () => {
    const r = session(`Lead \`a&shy;b\` and c${SHY}d words`);
    expect(r.hints?.hidden).toBe(undefined);
    expect(r.out).toBe(`Lead \`a&shy;b\` and c${SHY}d wordsX`);
  });
  it('a raw copy inside code is counted for B2 (hiddenCode) and written raw there', () => {
    const src = `Lead \`c${ZWJ}d\` y&zwj;z words`;
    const r = session(src);
    expect(r.hints?.hiddenCode?.get(ZWJ)).toBe(1);
    expect(r.out).toBe(`Lead \`c${ZWJ}d\` y&zwj;z wordsX`);
  });
  it('a raw copy inside formula TeX is counted for B2', () => {
    const src = `Lead $a${ZWJ}b$ and y&zwj;z words`;
    const r = session(src);
    expect(r.hints?.hiddenCode?.get(ZWJ)).toBe(1);
    expect(r.refused).toBe(null);
    expect(count(r.out!, ZWJ)).toBe(1);
  });
});

describe('B2: blockReveals', () => {
  const hints = (code = 0): S.SerializeHints => ({ hidden: new Map([[SHY, '&shy;']]), hiddenCode: new Map(code ? [[SHY, code]] : []) });
  it('a HIDDEN character raw in the Markdown is refused, whatever the source holds raw outside code', () => {
    expect(blockReveals(`a${SHY}b`, hints())).toBe(SHY);
    expect(blockReveals('a&shy;b', hints())).toBe(null);
  });
  it('as many as the source holds raw inside code pass, one more does not', () => {
    expect(blockReveals(`\`a${SHY}b\``, hints(1))).toBe(null);
    expect(blockReveals(`\`a${SHY}b\` c${SHY}d`, hints(1))).toBe(SHY);
  });
  it('what the user put in passes', () => {
    expect(blockReveals(`\`a${SHY}b\``, hints(), new Map([[SHY, 1]]))).toBe(null);
    expect(blockReveals(`\`a${SHY}${SHY}b\``, hints(), new Map([[SHY, 1]]))).toBe(SHY);
  });
  it('a character not in HIDDEN is left to the count rule', () => {
    expect(blockReveals(`a${RLO}b`, hints())).toBe(null);
    expect(blockReveals(`a${SHY}b`, {})).toBe(null);
  });
  it('the swap of the challenge (a cell-edge copy dropped, the reference written raw) is refused, the count rule passes it', () => {
    const src = `| h |\n| --- |\n| ${IDSP}a y&#x3000;z words |`;
    const forged = `| h |\n| --- |\n| a y${IDSP}z wordsX |`;
    expect(writeReveals(src, forged, new Map([['X', 1]]))).toBe(null);
    const r = session(src);
    expect(blockReveals(forged, r.hints!, new Map([['X', 1]]))).toBe(IDSP);
  });
  it('a raw HIDDEN character in a link destination the source writes raw: refused at the start (accepted, R6CR-3)', () => {
    expect(session(`Lead y&zwj;z [x](https://e.example/a${ZWJ}b) words`).refused).toBe('guard-start');
  });
});

// ---------------------------------------------------------------- B3
describe('B3: U+00A0 in the alt, title and attribute writers', () => {
  const cases: Array<[string, string, string?]> = [
    ['an image alt', 'Lead ![a&nbsp;b](i.png) words'],
    ['a link title', 'Lead [t](https://e.example/p "a&nbsp;b") words'],
    ['an image title', 'Lead ![i](i.png "a&nbsp;b") words'],
    ['a raw attribute', 'Lead <span title="a&nbsp;b">t</span> words'],
    ['a raw image alt (written as Markdown, an existing normalisation)', 'Lead <img src="i.png" alt="a&nbsp;b"> words', 'Lead ![a&nbsp;b](i.png) wordsX'],
    ['an alt, decimal', 'Lead ![a&#160;b](i.png) words'],
    ['an alt, hex', 'Lead ![a&#xA0;b](i.png) words'],
  ];
  for (const [name, src, want] of cases) {
    it(`${name}: editable, the reference kept`, () => {
      const r = session(src);
      expect(r.refused, show(src)).toBe(null);
      expect(r.out, show(r.out)).toBe(want ?? src + 'X');
    });
  }
  it('the swap of a raw U+00A0 in text and the reference in an alt is gone', () => {
    const r = session(`Lead x${NBSP}y ![a&nbsp;b](i.png) words`);
    expect(r.out).toBe('Lead x&nbsp;y ![a&nbsp;b](i.png) wordsX');   // (the text one by K26, as before)
  });
  it('the text writer keeps K26', () => {
    expect(session('Lead a&nbsp;b words').out).toBe('Lead a&nbsp;b wordsX');
  });
  it('a raw U+00A0 in an alt with no reference in the source stays raw (as before)', () => {
    expect(session(`Lead ![a${NBSP}b](i.png) words`).out).toBe(`Lead ![a${NBSP}b](i.png) wordsX`);
  });
  it('a reference of U+00A0 inside code only is not the source spelling', () => {
    const r = session(`Lead \`a&nbsp;b\` ![c${NBSP}d](i.png) words`);
    expect(r.hints?.nbspRef).toBe(undefined);
    expect(r.out).toBe(`Lead \`a&nbsp;b\` ![c${NBSP}d](i.png) wordsX`);
  });
});

// ---------------------------------------------------------------- rule T
describe('rule T: sanitizerKept', () => {
  const changed: Array<[string, string]> = [
    ['an element removed (inline frame)', 'See <iframe src="https://player.example/v"></iframe> words'],
    ['an element removed (script)', 'See <script>f()</script> words'],
    ['an element removed, its content kept (form)', 'See <form>a</form> words'],
    ['an element removed (an input that is not a checkbox)', 'See <input type="text" value="v"> words'],
    ['an attribute removed (event handler)', 'See <span onclick="f()">x</span> words'],
    ['an attribute removed (javascript: href)', 'See <a href="javascript:f()">x</a> words'],
    ['an attribute removed (a reserved name)', 'See <span data-mdr-o="1">x</span> words'],
    ['an attribute removed (a Markdown destination with a scheme it does not allow, next to raw HTML)', 'See [x](obsidian://open) <kbd>k</kbd> words'],
    ['a value changed (rel)', 'See <a href="https://e.example/" rel="nofollow">l</a> words'],
    ['a value changed (trimmed)', 'See <span title=" a ">x</span> words'],
    ['a processing instruction', 'a <?x y?> b words'],
    ['a processing instruction block', '<?form>\n\nx'],
  ];
  for (const [name, src] of changed) it(`refused: ${name}`, () => { expect(sanitizerKept(src)).toBe(false); });
  const kept: Array<[string, string]> = [
    ['kbd', 'See <kbd>k</kbd> words'],
    ['sub and sup', 'H<sub>2</sub>O and x<sup>2</sup> words'],
    ['br', 'a<br>b words'],
    ['mark', 'a <mark>m</mark> words'],
    ['abbr with a title', '<abbr title="t">a</abbr> words'],
    ['a span with a class', '<span class="note">x</span> words'],
    ['a span with a style', '<span style="color:red">x</span> words'],
    ['an img with a width', '<img src="i.png" width="300"> words'],
    ['a link with a title (target and rel added)', '<a href="https://e.example/" title="t">l</a> words'],
    ['a link with target _blank', 'See <a href="https://e.example/" target="_blank">link</a> words'],
    ['details and summary', '<details>\n<summary>s</summary>\n\nbody\n\n</details>'],
    ['a div with align', '<div align="center">\n\nx\n\n</div>'],
    ['font face', 'See <font face="serif">x</font> words'],
    ['a task list with raw HTML', '- [ ] task <kbd>k</kbd>\n- [x] two'],
    ['a table with raw HTML (cell alignment)', '| a | b |\n| :-- | --: |\n| <kbd>x</kbd> | y |'],
    ['an image (loading added) with raw HTML', '![i](i.png) and <kbd>k</kbd>'],
    ['an autolink (target and rel added)', 'a < b and <https://e.example/x> words'],
    ['a formula with a <', '$a<b$ and <kbd>k</kbd>'],
    ['a fence with a <', '```js\nlet a = 1 < 2;\n```'],
  ];
  for (const [name, src] of kept) it(`editable: ${name}`, () => { expect(sanitizerKept(src)).toBe(true); });
  it('a Markdown link whose scheme the sanitizer does not allow, without raw HTML: refused at the start (its URL is gone from the DOM)', () => {
    expect(session('See [x](obsidian://open) words').refused).toBe('T');
    expect(session('See ![i](zotero://x.png) words').refused).toBe('T');
    expect(session('See [x](https://e.example/) words').refused).toBe(null);
  });
  it('the kept kinds start a session along the whole path', () => {
    for (const src of ['See <kbd>k</kbd> words', 'H<sub>2</sub>O and words', '<abbr title="t">a</abbr> words', '<span class="note">x</span> words', '<img src="i.png" width="300"> words']) {
      const r = session(src);
      expect(r.refused, show(src)).toBe(null);
      expect(r.out, show(src)).toBe(src + 'X');
    }
  });
});
