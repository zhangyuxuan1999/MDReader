// @vitest-environment jsdom
// test/r5-fa-atoms.test.ts — fix-atoms (stage 2f, fix round 5): N1 = PTR-1 + KEYS-1, the rule P-G "atoms survive the
// browser" (CONTRACT §11, Round-4 verification decisions), at the serializer. Chromium's own join of two line containers
// re-creates the nodes it moves from markup: attributes survive, KaTeX's <annotation> (not rendered) and live properties
// do not, computed styles are baked into style attributes (bench/verify/r5-fa-recreate.mjs measured it). `recreate()`
// below does the same to a mounted block: every moved element goes through outerHTML, its annotation goes, a baked
// style is added. The session stamps the DOM first (stampAtoms) and serializes with `stamped`.
// (a) stamps: the formula's TeX is its stamp, byte for byte; a stamp found before stamping is cleared; stamps go away.
// (b) no guessing: a formula holding KaTeX output with neither stamp nor annotation is a refusal (AtomUnknownError, a
//     NoMarkersError), never its rendered text; the <code> fallback and a KaTeX error stay as they are.
// (c) presentation the browser invents is not written, on every element kind; the document's own is, as it was.
// (d) the task marker is the item's own leading box (ownTaskBox); a moved-in box is dropped, its space stays.
// (e) U23: Enter then Backspace (the paragraph split and joined again by re-creation) gives the baseline back.
// Plus the hostile document: the stamp names are reserved (sanitizer, worker flag) and never reach the output.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import {
  AtomUnknownError, NoMarkersError, clearStamps, resetListCache, serializeBlock, sourceStyleHints, stampAtoms, STAMP_SELECTOR,
} from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

const ZW = String.fromCharCode(0x200b);
const BAKED = 'background-color: rgb(250, 248, 244);';
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return w;
}
/** What the session does at its start (inlineEdit begin): document elements marked, formulas frozen, atoms stamped. */
function prepareSession(w: HTMLElement): void {
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll('.md-math'))) m.setAttribute('contenteditable', 'false');
  stampAtoms(w);
}
const kindOf = (w: Element): BlockKind => (w.querySelector('ul, ol') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1, h2') ? BlockKind.Heading : BlockKind.Prose);
const ser = (w: HTMLElement, src: string, stamped = true): string => serializeBlock(w, kindOf(w), { ...sourceStyleHints(src), editing: true, stamped });
/** A node as Chromium re-creates it: through markup, annotation gone, a style baked in (`bake`). */
function recreated(n: Node, bake: boolean): Node {
  if (n.nodeType !== 1) return n.cloneNode(true);
  const t = document.createElement('template');
  t.innerHTML = (n as Element).outerHTML;
  const e = t.content.firstElementChild!;
  for (const a of Array.from(e.querySelectorAll('annotation'))) a.remove();
  if (e.tagName === 'INPUT') (e as HTMLInputElement).checked = e.hasAttribute('checked');
  if (bake && !e.classList.contains('md-math')) e.setAttribute('style', (e.getAttribute('style') ? e.getAttribute('style') + ' ' : '') + BAKED);
  return e;
}
/** Chromium's join of line container `b` into `a`: `b`'s children re-created at the end of `a` (in a style span), `b` goes. */
function join(a: Element, b: Element, bake = true): void {
  const wrap = document.createElement('span');
  wrap.setAttribute('style', BAKED);
  for (const c of Array.from(b.childNodes)) { if (c.nodeType === 1 && /^(UL|OL)$/.test((c as Element).tagName)) { a.parentElement!.appendChild(c); continue; } wrap.appendChild(recreated(c, bake)); }
  // at the end of `a`'s first line: before its nested list, when it has one
  const sub = Array.from(a.children).find((c) => /^(UL|OL)$/.test(c.tagName)) ?? null;
  a.insertBefore(wrap, sub);
  // (Chromium drops the collapsed line feed markdown-it leaves before a nested list at the junction)
  const prev = wrap.previousSibling;
  if (prev && prev.nodeType === 3) (prev as Text).data = (prev as Text).data.replace(/[ \n]+$/, '');
  b.remove();
}
const lis = (w: Element): Element[] => Array.from(w.querySelectorAll('li'));
const quotePs = (w: Element): Element[] => Array.from(w.querySelectorAll('blockquote > p'));

describe('P-G (a): a re-created formula is written from its stamp, byte for byte', () => {
  const texs = ['x', '\\frac{a}{b}', 'x^2 + y_1', '\\sqrt[3]{a}', '\\text{if } a<b \\& c', 'a\\\\b', '\\mathbb{R}^n', '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', '"q" \' & <b>'];
  for (const tex of texs) {
    for (const [form, md] of [['inline', `$${tex}$`], ['display', `$$${tex}$$`]] as const) {
      it(`${form} ${JSON.stringify(tex)} in a list item`, () => {
        const src = `- one\n- Lead ${md} two`;
        const w = mount(src);
        prepareSession(w);
        const base = ser(w, src);
        expect(baselineFaithful(w, BlockKind.List, base), base).toBe(true);
        const [a, b] = lis(w);
        join(a, b);
        expect(w.querySelector('annotation')).toBe(null);          // the re-creation took it
        const out = ser(w, src);
        expect(out, out).toBe(`- oneLead ${md} two`);
        expect(out.includes(ZW)).toBe(false);
        w.remove();
      });
    }
  }
  it('in a quote paragraph and in a loose item\'s second paragraph', () => {
    for (const [src, want, pick] of [
      ['> one\n>\n> Lead $\\frac{a}{b}$ two', '> oneLead $\\frac{a}{b}$ two', quotePs],
      ['- one\n\n  Lead $\\frac{a}{b}$ two', '- oneLead $\\frac{a}{b}$ two', (w: Element) => Array.from(w.querySelectorAll('li > p'))],
    ] as const) {
      const w = mount(src);
      prepareSession(w);
      const [a, b] = pick(w);
      join(a, b);
      expect(ser(w, src)).toBe(want);
      w.remove();
    }
  });
  it('a stamp the DOM carried before the session (never the session\'s) is cleared and the real TeX stamped', () => {
    const src = '- one\n- Lead $x$ two';
    const w = mount(src);
    w.querySelector('.md-math')!.setAttribute('data-mdr-tex', 'EVIL');
    w.querySelector('p, li')!.setAttribute('data-mdr-ps', '{"style":"color:red"}');
    prepareSession(w);
    expect(w.querySelector('.md-math')!.getAttribute('data-mdr-tex')).toBe('x');
    expect(w.querySelector('li')!.hasAttribute('data-mdr-ps')).toBe(false);
    const [a, b] = lis(w);
    join(a, b);
    expect(ser(w, src)).toBe('- oneLead $x$ two');
  });
  it('without `stamped` a stamp is not read (only a session that stamped may use it)', () => {
    const src = 'Lead $x$ two';
    const w = mount(src);
    w.querySelector('.md-math')!.setAttribute('data-mdr-tex', 'EVIL');
    expect(ser(w, src, false)).toBe('Lead $x$ two');
    // and a re-created formula without `stamped` is refused, not guessed
    w.querySelector('annotation')!.remove();
    expect(() => ser(w, src, false)).toThrow(AtomUnknownError);
  });
  it('clearStamps leaves the DOM exactly as before the stamping', () => {
    const src = '- [x] one $x$ <span style="color:red">r</span>\n- ![i](x.png) <img src="y.png" width="3"> two';
    const w = mount(src);
    const before = w.innerHTML;
    stampAtoms(w);
    expect(w.querySelectorAll(STAMP_SELECTOR).length).toBeGreaterThan(0);
    clearStamps(w);
    expect(w.innerHTML).toBe(before);
  });
});

describe('P-G (b): no guessing', () => {
  it('KaTeX output with neither stamp nor annotation: a refusal (a NoMarkersError, the existing refusal path)', () => {
    const src = 'Lead $\\frac{a}{b}$ two';
    const w = mount(src);
    w.querySelector('annotation')!.remove();
    let err: unknown = null;
    try { ser(w, src); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AtomUnknownError);
    expect(err).toBeInstanceOf(NoMarkersError);
  });
  it('a formula KaTeX has not rendered (the <code> fallback) and a KaTeX error keep their text', () => {
    const w = document.createElement('section');
    w.innerHTML = '<p data-l="0">Lead <span class="md-math"><code>a+b</code></span> and <span class="md-math"><span class="katex-error" title="ParseError" style="color:#cc0000">\\frac{</span></span> end</p>';
    document.body.appendChild(w);
    prepareSession(w);
    expect(serializeBlock(w, BlockKind.Prose, { editing: true, stamped: true })).toBe('Lead $a+b$ and $\\frac{$ end');
    for (const m of Array.from(w.querySelectorAll('.md-math'))) m.removeAttribute('data-mdr-tex');
    expect(serializeBlock(w, BlockKind.Prose, { editing: true, stamped: true })).toBe('Lead $a+b$ and $\\frac{$ end');
    w.remove();
  });
});

describe('P-G (c): presentation the browser invents is not written', () => {
  const cases: Array<[string, string, string]> = [
    ['an image', '- one\n- Lead ![i](x.png) two', '- oneLead ![i](x.png) two'],
    ['an image with a title', '- one\n- Lead ![i](x.png "t") two', '- oneLead ![i](x.png "t") two'],
    ['an image in a link', '- one\n- Lead [![i](x.png)](http://e.x/) two', '- oneLead [![i](x.png)](http://e.x/) two'],
    ['a link, code, bold', '- one\n- Lead [l](http://e.x/) `c` **b** two', '- oneLead [l](http://e.x/) `c` **b** two'],
    ['raw kbd', '- one\n- Lead <kbd>K</kbd> two', '- oneLead <kbd>K</kbd> two'],
    ['raw span with a class', '- one\n- Lead <span class="c">s</span> two', '- oneLead <span class="c">s</span> two'],
    ['raw span with the document\'s style (spelled by the browser again)', '- one\n- Lead <span style="color:red">r</span> two', '- oneLead <span style="color:red">r</span> two'],
    ['raw img with width', '- one\n- Lead <img src="x.png" width="10"> two', '- oneLead <img src="x.png" width="10"> two'],
  ];
  for (const [name, src, want] of cases) {
    it(name, () => {
      const w = mount(src);
      prepareSession(w);
      const [a, b] = lis(w);
      join(a, b);
      // the browser respells a document style too ("color:red" becomes "color: red;")
      for (const e of Array.from(w.querySelectorAll('[style*="color:red"]'))) e.setAttribute('style', 'color: red; ' + BAKED);
      const out = ser(w, src);
      expect(out, out).toBe(want);
      expect(out.includes('background-color')).toBe(false);
      w.remove();
    });
  }
  it('legacy presentation attributes and Apple- classes the browser added are ignored on every element kind', () => {
    const src = 'Lead ![i](x.png) **b** [l](http://e.x/) <kbd class="k">K</kbd> two';
    const w = mount(src);
    prepareSession(w);
    for (const e of Array.from(w.querySelectorAll('img, strong, a, kbd'))) {
      e.setAttribute('align', 'left'); e.setAttribute('color', 'red'); e.setAttribute('face', 'Arial'); e.setAttribute('size', '3'); e.setAttribute('bgcolor', '#fff');
      e.classList.add('Apple-converted-space');
    }
    expect(ser(w, src)).toBe(src);
  });
  it('the document\'s own legacy attributes stay', () => {
    const src = 'Lead <img src="x.png" align="left"> and <font color="red">c</font> two';
    const w = mount(src);
    prepareSession(w);
    expect(ser(w, src)).toBe(src);
  });
});

describe('P-G (c): table alignment is the document\'s own presentation', () => {
  it('the delimiter row comes from the cells\' recorded style; a style the browser baked into a cell or its text is not written', () => {
    const src = '| a | b | c |\n|:--|:-:|--:|\n| one | two | three |';
    const w = mount(src);
    prepareSession(w);
    for (const c of Array.from(w.querySelectorAll('th, td'))) c.setAttribute('style', (c.getAttribute('style') ?? '') + '; ' + BAKED);
    const td = w.querySelector('td')!;
    const sp = document.createElement('span'); sp.setAttribute('style', BAKED); sp.textContent = 'X'; td.appendChild(sp);
    expect(serializeBlock(w, BlockKind.Table, { ...sourceStyleHints(src), editing: true, stamped: true })).toBe('| a | b | c |\n|:--|:-:|--:|\n| oneX | two | three |');
  });
});

describe('P-G (d): the task marker is the item\'s own leading box', () => {
  const cases: Array<[string, string]> = [
    ['- [ ] task a\n- [x] task b', '- [ ] task a task b'],
    ['- [x] task a\n- [ ] task b', '- [x] task a task b'],
    ['- plain a\n- [x] task b', '- plain a task b'],
    ['- [ ] one\n- [x] two\n- [ ] three', '- [ ] one two\n- [ ] three'],
  ];
  for (const [src, want] of cases) {
    it(`${JSON.stringify(src)} joined (re-created nodes, the moved box's state from its attribute)`, () => {
      resetListCache();
      const w = mount(src);
      prepareSession(w);
      const [a, b] = lis(w);
      join(a, b);
      expect(ser(w, src)).toBe(want);
      w.remove();
    });
  }
  it('the nested item joined into its parent: "- one nested"', () => {
    const src = '- one\n  - [x] nested\n- [ ] two';
    const w = mount(src);
    prepareSession(w);
    const [one, nested] = lis(w);
    join(one, nested);
    for (const u of Array.from(w.querySelectorAll('ul ul'))) if (!u.querySelector('li')) u.remove();
    expect(ser(w, src)).toBe('- one nested\n- [ ] two');
    w.remove();
  });
  it('the own box keeps the state the user saw (a toggle in the session sets property and attribute)', () => {
    const src = '- [ ] task a\n- [x] task b';
    const w = mount(src);
    prepareSession(w);
    const own = w.querySelector('input') as HTMLInputElement;
    own.checked = true; own.setAttribute('checked', '');     // what inlineEdit's toggle does
    const [a, b] = lis(w);
    // the receiving item re-created as well (attribute survives, property re-derived from it)
    join(a, b);
    a.replaceWith(recreated(a, false));
    expect(ser(w, src)).toBe('- [x] task a task b');
  });
  it('a list of 9 items (the item-wise cache path) gives the same', () => {
    resetListCache();
    const items = ['- [ ] task a', '- [x] task b', ...Array.from({ length: 7 }, (_, i) => `- item ${i}`)];
    const src = items.join('\n');
    const w = mount(src);
    prepareSession(w);
    const once = ser(w, src);
    expect(once).toBe(src);
    const [a, b] = lis(w);
    join(a, b);
    expect(ser(w, src).split('\n')[0]).toBe('- [ ] task a task b');
    expect(serializeBlock(w, BlockKind.List, { ...sourceStyleHints(src), editing: true, stamped: true, uncached: true }).split('\n')[0]).toBe('- [ ] task a task b');
  });
});

describe('P-G (e): U23 with atoms', () => {
  for (const src of ['Lead $x$ and ![i](x.png) then $\\frac{a}{b}$ end.', '## Lead $x$ head', '> Lead $x$ quoted', '- Lead $x$ item\n- other']) {
    it(`${JSON.stringify(src)}: split at the start and joined again by re-creation`, () => {
      const w = mount(src);
      prepareSession(w);
      const base = ser(w, src);
      expect(base).toBe(src);
      // Enter at the line start: an empty line container before; Backspace: the line re-created into it
      const line = w.querySelector('li, blockquote > p, h2, p')!;
      const empty = document.createElement(line.tagName === 'H2' ? 'p' : line.tagName.toLowerCase());
      empty.appendChild(document.createElement('br'));
      line.before(empty);
      empty.firstChild!.remove();
      for (const c of Array.from(line.childNodes)) { if (c.nodeType === 1 && /^(UL|OL)$/.test((c as Element).tagName)) continue; empty.appendChild(recreated(c, true)); }
      if (line.tagName === 'H2') { const h = document.createElement('h2'); while (empty.firstChild) h.appendChild(empty.firstChild); empty.replaceWith(h); }
      line.remove();
      expect(ser(w, src)).toBe(src);
      w.remove();
    });
  }
});

describe('the stamp names in a hostile document', () => {
  const hostile = [
    'Fix <span class="md-math" data-mdr-tex="\\text{Call +1 555}">x</span> here',
    'Fix <span data-mdr-ps=\'{"style":"display:none"}\'>hidden</span> here',
    'Fix <img src="x.png" data-mdr-ps="{}"> here',
    'Fix <span data-MDR-TEX="a">a</span> here',
    'Fix <span data-mdr-tex = "a">a</span> here',
  ];
  for (const src of hostile) {
    it(JSON.stringify(src), () => {
      const r = mdk.renderBlock(src, { references: {} });
      // the worker flags the block (data-mdr-x: the session refuses it at the click, U10 c) …
      expect(r.flags & HTML_FLAG_RESERVED).toBe(HTML_FLAG_RESERVED);
      // … and the sanitizer removes the names anyway
      const w = mount(src);
      expect(w.querySelector(STAMP_SELECTOR)).toBe(null);
      expect(w.innerHTML.toLowerCase().includes('data-mdr')).toBe(false);
      w.remove();
    });
  }
});
