// @vitest-environment jsdom
// test/r3-s-currency.test.ts — fix-serial (stage 2d, fix round 3), H17 (FID-4).
//
// math.ts's currency rule: an inline formula whose TeX starts and ends with a digit is not closed by a `$` that is
// followed by whitespace or the end of the text. Decision H17: a formula the session shows stays a formula in the
// source. The serializer writes the whitespace after such a closer as a character reference (`$10$&#32;x`), or adds
// one where a line end follows (`$10$&#32;`), proven with the worker's math rule; the TeX is untouched, and every
// formula whose compact spelling reads back keeps its bytes.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
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
/** Edits the first text node holding `needle`: replaces `needle` by `by`. */
function edit(src: string, needle: string, by: string): { md: string; w: HTMLElement } {
  const w = mount(src);
  const kind = kindOf(src);
  const hints = { ...sourceStyleHints(src), editing: true };
  expect(baselineFaithful(w, kind, serializeBlock(w, kind, hints)), 'gate on the untouched block').toBe(true);
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  t.data = t.data.replace(needle, by);
  if (t.data === '') t.remove();
  return { md: serializeBlock(w, kind, hints), w };
}
function holds(src: string, needle: string, by: string, expected?: string): string {
  const { md, w } = edit(src, needle, by);
  const again = mount(md);
  const msg = `src ${JSON.stringify(src)} md ${JSON.stringify(md)}`;
  expect(formulas(again), msg).toBe(formulas(w));
  expect(canonicalForm(again), msg).toBe(canonicalForm(w));
  if (expected !== undefined) expect(md).toBe(expected);
  // the written source is stable: a session on its rendering serializes it back unchanged and passes the gate
  const kind = kindOf(md);
  const base = serializeBlock(again, kind, { ...sourceStyleHints(md), editing: true });
  expect(base, msg).toBe(md);
  expect(baselineFaithful(again, kind, base), msg).toBe(true);
  return md;
}

describe('H17: a digit…digit formula stays a formula after an edit', () => {
  it('the dot after it deleted at the paragraph end', () => { holds('面积 $3\\times4$.', '.', '', '面积 $3\\times4$&#32;'); });
  it('a space typed after it', () => { holds('和 $1+2$x', 'x', ' x', '和 $1+2$&#32;x'); });
  it('the CJK full stop after $10$ deleted', () => { holds('等于 $10$。', '。', '', '等于 $10$&#32;'); });
  it('single-digit TeX', () => { holds('值 $7$。', '。', ''); });
  it('in a list item, then the next item', () => { holds('- 面积 $3\\times4$.\n- b', '.', ''); });
  it('in a heading', () => { holds('## 面积 $10$.', '.', ''); });
  it('in a table cell', () => { holds('| a | $10$. |\n|---|---|\n| c | d |', '.', ''); });
  it('in a blockquote', () => { holds('> 面积 $3\\times4$.', '.', ''); });
  it('before a soft line break', () => { holds('面积 $10$.\n下一行', '.', ''); });
  it('before a hard line break', () => { holds('面积 $10$.  \n下一行', '.', ''); });
  it('inside bold the closer is `**`: nothing added', () => { holds('**面积 $10$.**', '.', '', '**面积 $10$**'); });
  it('a typed space before bold', () => { holds('$1+2$x**b**', 'x', ' ', '$1+2$&#32;**b**'); });
  it('a tab typed after it', () => { holds('和 $1+2$x', 'x', '\tx'); });
  it('two formulas, both affected', () => { holds('$1$a $2$b', 'a', ''); });
  it('a space typed at the start of the italic right after it (turndown writes it before the *)', () => { holds('和 $1+2$*斜体*', '斜体', ' 斜体', '和 $1+2$&#32; *斜体*'); });
  it('inline code right after it whose text starts with a space: nothing added', () => {
    const { md, w } = edit('和 $1+2$`x`', 'x', ' x');
    expect(md).not.toContain('&#32;');
    expect(formulas(mount(md))).toBe(formulas(w));
  });
});

describe('H17: every other formula keeps its bytes', () => {
  const keep = [
    '和 $x$ 结束', '面积 $3\\times4$.', '等于 $10$。', '$1+2$x', '$a+1$ b', '$1+a$ b', '公式 $x$1 个', '$1$&#49; x',
    '价格 $5 和 6$ 元', 'a $$10$$ b', '$10$**b**', '**$10$**', '[$10$](https://e.example/)', '| $10$x | b |\n|---|---|\n| c | d |',
    '和 $1+2$&#32;x', '面积 $3\\times4$&#32;', '- $10$&#32;\n- b',
  ];
  for (const src of keep) {
    it(JSON.stringify(src), () => {
      const w = mount(src);
      const kind = kindOf(src);
      const md = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
      // either the source itself, or (when the serializer normalizes something unrelated) at least no added &#32;
      expect(md.split('&#32;').length, `md ${JSON.stringify(md)}`).toBe(src.split('&#32;').length);
      expect(canonicalForm(mount(md))).toBe(canonicalForm(w));
    });
  }
  it('the sources that already have the spelling come back byte for byte', () => {
    for (const src of ['和 $1+2$&#32;x', '面积 $3\\times4$&#32;', '等于 $10$&#32;', '- $10$&#32;\n- b']) {
      const w = mount(src);
      expect(serializeBlock(w, kindOf(src), { ...sourceStyleHints(src), editing: true })).toBe(src);
    }
  });
});
