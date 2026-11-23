// @vitest-environment jsdom
// verify-fidelity (0.2.0 stage 2c): VARIATIONS of the r1 groups G2 G3 G4 G5 G8 G9 G18 G19 G20 G21
// (docs/FINDINGS-0.2.0-r1.md) on the real pipeline: render → mount → a DOM edit of the kind Chromium makes →
// serializeBlock with the session's hints → render again. Each case asserts that the re-render equals what the
// edited DOM shows (the U12 gate's canonicalForm; <del>/<s> equal) and, where named, a property of the source.
// Cases marked FAILS-TODAY are expected to fail on the 0.2.0 stage-2c candidate (see the verifier's report).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';

const ch = (n: number): string => String.fromCodePoint(n);
const NBSP = ch(0xa0);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
const render = (src: string, refs: References = {}): string => mdk.renderBlock(src, { references: { ...refs } }).html;
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
/** canonicalForm, plus the spellings K5 accepts: <del> = <s>; a <br> at the edge of bold / italic /
 *  strikethrough / a link / inline code moves outside it; a trailing <br> (the browser's placeholder of an
 *  emptied line) and a space before a line end render nothing. */
const canon = (n: Node): string => {
  let s = canonicalForm(n).replace(/<(\/?)del>/g, '<$1s>');
  for (let k = 0; k < 4; k++) {
    s = s.replace(/<br\/>(<\/(?:strong|em|s|a|code)>)/g, '$1<br/>').replace(/(<(?:strong|em|s|code|a [^>]*)>)<br\/>/g, '<br/>$1')
      .replace(/ ?<br\/>(<\/(?:p|li|h\d|td|th)>|<ul|<ol)/g, '$1').replace(/[ \u00a0](<\/(?:p|li|h\d|td|th)>)/g, '$1').replace(/ <br\/>/g, '<br/>');
  }
  return s;
};
function texts(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!(n as Text).parentElement?.closest('.katex, .md-math')) out.push(n as Text);
  return out;
}
type Mut = (w: HTMLElement) => void;
/** Types `s` right after the first occurrence of `needle` (inside one text node). */
const typeAfter = (needle: string, s: string): Mut => (w) => {
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  const i = t.data.indexOf(needle) + needle.length;
  t.data = t.data.slice(0, i) + s + t.data.slice(i);
};
/** Deletes the first occurrence of `needle` (inside one text node). */
const del = (needle: string): Mut => (w) => {
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  t.data = t.data.replace(needle, '');
};
/** Shift+Enter right after `needle` (a <br> splits the text node), or at the start of element `sel` / its end. */
const brAfter = (needle: string): Mut => (w) => {
  const t = texts(w).find((x) => x.data.includes(needle))!;
  const rest = t.splitText(t.data.indexOf(needle) + needle.length);
  t.parentNode!.insertBefore(w.ownerDocument.createElement('br'), rest);
};
const brIn = (sel: string, at: 'start' | 'end'): Mut => (w) => {
  const e = w.querySelector(sel)!;
  const br = w.ownerDocument.createElement('br');
  if (at === 'start') e.insertBefore(br, e.firstChild); else e.appendChild(br);
};
/** Empties the li matched by `sel` the way Chromium does (its text gone, a placeholder <br>, nested lists kept). */
const emptyLi = (sel: string): Mut => (w) => {
  const li = w.querySelector(sel)!;
  const keep = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
  const box = li.querySelector(':scope > input');
  li.replaceChildren(...(box ? [box, w.ownerDocument.createTextNode(' ')] : []), w.ownerDocument.createElement('br'), ...keep);
};
const seq = (...m: Mut[]): Mut => (w) => { for (const f of m) f(w); };

interface Out { md: string; shown: string; again: string; gate: boolean }
function run(src: string, mut: Mut, refs: References = {}): Out {
  const w = mount(render(src, refs));
  const kind = kindOf(src);
  const hints = { ...sourceStyleHints(src), editing: true };
  const gate = baselineFaithful(w, kind, serializeBlock(w, kind, hints));
  mut(w);
  const md = serializeBlock(w, kind, hints);
  return { md, shown: canon(w), again: canon(mount(render(md, refs))), gate };
}
function same(src: string, mut: Mut, extra?: (md: string) => boolean, refs: References = {}): void {
  const o = run(src, mut, refs);
  const msg = `src ${JSON.stringify(src)}\nmd  ${JSON.stringify(o.md)}\nshown ${o.shown}\nagain ${o.again}`;
  expect(o.again, msg).toBe(o.shown);
  if (extra) expect(extra(o.md), msg).toBe(true);
}

describe('G2 autolinks, variations', () => {
  const cases: Array<[string, Mut]> = [
    ['版本2<https://e.example/a> 说明', typeAfter('说明', 'x')],
    ['见<https://e.example/x>，然后', typeAfter('然后', 'x')],
    ['邮箱：<a.b@e.example>。', typeAfter('。', 'x')],
    ['(see <https://en.wikipedia.org/wiki/A_(b)>) ok', typeAfter('ok', 'x')],
    ['go https://en.wikipedia.org/wiki/A_(b) ok', typeAfter('ok', 'x')],
    ['ip <http://[::1]:8080/x> ok', typeAfter('ok', 'x')],
    ['auth <https://u:p@e.example:8443/p?q=1#f> ok', typeAfter('ok', 'x')],
    ['star <https://e.example/?q=*a*> and *em*', typeAfter('em', 'x')],
    ['dot [https://e.example/a.](https://e.example/a.)x', typeAfter('x', 'y')],
    ['<https://e.example>~~del~~ tail', typeAfter('tail', 'x')],
    ['**<https://e.example/b>**中文', typeAfter('中文', 'x')],
    ['*<https://e.example/i>*y', typeAfter('y', 'x')],
    ['~~<https://e.example/s>~~z', typeAfter('z', 'x')],
    ['| <https://e.example/a_b_> | x |\n|---|---|\n| c | d |', typeAfter('d', 'x')],
    ['# 标题 <https://e.example/h>', typeAfter('标题', 'x')],
    ['- 项 <https://e.example/l>\n- 二', typeAfter('二', 'x')],
    ['<mailto:a@b.example> ok', typeAfter('ok', 'x')],
    ['pct <https://e.example/%E4%B8%AD> ok', typeAfter('ok', 'x')],
    ['idn <https://例子.example/路径> ok', typeAfter('ok', 'x')],
    ['two <https://a.example> <https://b.example>', typeAfter('two', 'x')],
    ['brk https://e.example/x  \nnext', typeAfter('next', 'x')],
    ['quote "<https://e.example/q>" ok', typeAfter('ok', 'x')],
    ['back `c`<https://e.example/c> ok', typeAfter('ok', 'x')],
    ['amp <https://e.example/?a=1&b=2> ok', typeAfter('ok', 'x')],
    ['under _<https://e.example/u>_ ok', typeAfter('ok', 'x')],
  ];
  for (const [src, m] of cases) it(src, () => same(src, m));
  // the user deletes the space between a link and the following text
  it('delete the space after a bare URL before CJK', () => same('访问 https://e.example/p 网站', (w) => { const t = texts(w).find((x) => x.data.includes(' 网站'))!; t.data = t.data.replace(' 网站', '网站'); }));
  it('delete the space after an autolink before (', () => same('访问 <https://e.example/p> (英文)', (w) => { const t = texts(w).find((x) => x.data.includes(' ('))!; t.data = t.data.replace(' (', '('); }));
});

describe('G3 formula with a pipe in a table cell, variations', () => {
  it('header cell', () => same('| $a\\|b$ | h |\n|---|---|\n| 1 | 2 |', typeAfter('2', 'x')));
  it('display-inline formula in a cell', () => same('| a | $$\\|x\\|$$ |\n|---|---|\n| 1 | 2 |', typeAfter('1', 'x')));
  it('TeX norm \\| in a cell', () => same('| a | $\\\\\\|x\\\\\\|$ |\n|---|---|\n| 1 | 2 |', typeAfter('1', 'x')));
  it('code and formula with pipes in one cell', () => same('| `a\\|b` $c\\|d$ | e |\n|---|---|\n| 1 | 2 |', typeAfter('e', 'x')));
  it('formula in the edited cell itself', () => same('| 名 | 值 $P(A\\|B)$ |\n|---|---|\n| 1 | 2 |', typeAfter('值', 'x')));
});

describe('G4 private-use and noncharacters, variations', () => {
  it('E000..E003 all in one paragraph', () => same(`a${ch(0xe000)}b${ch(0xe001)}c${ch(0xe002)}d${ch(0xe003)}e`, typeAfter('e', 'x')));
  it('E000..E003 in a link destination and title', () => same(`[t](https://e.example/${ch(0xe000)} "${ch(0xe002)}") x`, typeAfter(' x', 'y')));
  it('E002 in inline code in a cell', () => same(`| \`a${ch(0xe002)}b\` | c |\n|---|---|\n| 1 | 2 |`, typeAfter('2', 'x')));
  it('E000 in a formula', () => same(`f $\\text{${ch(0xe000)}}$ g`, typeAfter('g', 'x')));
  it('noncharacter FDD0 and F8FF', () => same(`a${ch(0xfdd0)}b${ch(0xf8ff)}c`, typeAfter('c', 'x')));
  it('astral private use U+F0000', () => same(`a${ch(0xf0000)}b`, typeAfter('b', 'x')));
  it('all of E000..E0FF in one block', () => {
    let s = 'x';
    for (let c = 0xe000; c <= 0xe0ff; c++) s += ch(c);
    same(s + ' y', typeAfter('y', 'z'));
  });
});

describe('G5 line breaks at edges, variations', () => {
  it('br at the start of a link in bold', () => same('**[l](https://e.example) b** c', brIn('a', 'start')));
  it('br at the end of nested bold italic', () => same('***x*** y', brAfter('x')));
  it('br at the start of inline code', () => same('a `code` b', brIn('code', 'start')));
  it('br at the end of inline code', () => same('a `code` b', brIn('code', 'end')));
  it('br at the start of a heading', () => same('## 标题', brIn('h2', 'start')));
  it('br at the end of a cell', () => same('| a | b |\n|---|---|\n| c | d |', typeAfter('c', 'x')));
  it('br at the start of a quote paragraph', () => same('> quote text', brIn('p', 'start')));
  it('br after strikethrough at a list item end', () => same('- ~~s~~ t\n- u', brAfter('t')));
  it('br at the start of a strikethrough', () => same('a ~~s~~ b', brIn('s', 'start')));
  it('br at the end of a link at the paragraph end', () => same('a [l](https://e.example)', seq(brIn('a', 'end'), typeAfter('a ', 'x'))));
});

describe('G8 emptied items, variations', () => {
  it('first item of a nested ordered list under a task item', () => same('- [ ] task\n  1. one\n  2. two', emptyLi('ol > li')));
  it('first nested item inside a quote', () => same('> - on\n>   - a\n>   - b', emptyLi('ul ul > li')));
  it('the only item of a nested list', () => same('- on\n  - a\n- two', emptyLi('ul ul > li')));
  it('first item of a list block (the list follows a paragraph line in the PREVIOUS block)', () => {
    const o = run('- a\n- b', emptyLi('li'));
    // the written list goes right under "para" (no blank line between the two blocks)
    const doc = 'para\n' + o.md;
    const again = canon(mount(render(doc)));
    expect(again, `md ${JSON.stringify(o.md)}`).toBe('<p>para</p>' + canon(mount(render('- a\n- b'))).replace('<li>a</li>', '<li></li>'));
  });
  it('first top-level ordered item', () => same('1. a\n2. b', emptyLi('li')));
  it('task item emptied, then typed into again', () => same('- [ ] a\n- [x] b', seq(emptyLi('li:nth-child(2)'), (w) => { const li = w.querySelectorAll('li')[1]; li.querySelector('br')!.replaceWith(w.ownerDocument.createTextNode('Z')); })));
  it('second serialization of an emptied nested item is stable', () => {
    const o = run('- on\n  - a\n  - b', emptyLi('ul ul > li'));
    const o2 = run(o.md, () => {});
    expect(o2.md).toBe(o.md);
    expect(o2.gate).toBe(true);
  });
  it('the "- <br>" item is editable (gate) and typing replaces the placeholder', () => {
    const o = run('- on\n  - a\n  - b', emptyLi('ul ul > li'));
    const o2 = run(o.md, (w) => { const li = w.querySelector('ul ul > li')!; li.replaceChildren(w.ownerDocument.createTextNode('Q')); });
    expect(o2.gate).toBe(true);
    expect(o2.md.includes('<br>')).toBe(false);
    expect(o2.again).toBe(o2.shown);
  });
  it('"[x] &nbsp;" item: gate passes, second serialization stable', () => {
    const o = run('- [ ] a\n- [x] b', emptyLi('li:nth-child(2)'));
    const o2 = run(o.md, () => {});
    expect(o2.gate).toBe(true);
    expect(o2.md).toBe(o.md);
  });
});

describe('G9 NBSP-only spacers, variations', () => {
  it('NBSP-only cell', () => same('| &nbsp; | b |\n|---|---|\n| c | d |', typeAfter('d', 'x')));
  it('NBSP-only list item', () => same('- a\n- &nbsp;\n- c', typeAfter('c', 'x')));
  it('NBSP-only line between hard breaks', () => same('a  \n&nbsp;  \nb', typeAfter('b', 'x')));
  it('literal U+00A0 spacer paragraph in a quote', () => same(`> a\n>\n> ${NBSP}\n>\n> b`, typeAfter('b', 'x')));
  it('&#160; spelled spacer under a tight heading', () => same('## h\n&#160;', typeAfter('h', 'x')));
});

describe('G18 thematic-break look-alikes, variations', () => {
  for (const t of ['* * *', '_ _ _', '-  -  -', ' - - -', '*\t*\t*', '- - - -', '***', '___', '---']) {
    it(`typed "${t}" as a whole paragraph`, () => same('abc', (w) => { texts(w)[0].data = t; }));
    it(`typed "${t}" after a Shift+Enter`, () => same('abc', seq(brAfter('abc'), (w) => { w.querySelector('p')!.appendChild(w.ownerDocument.createTextNode(t)); })));
    it(`typed "${t}" as a list item`, () => same('- a\n- b', (w) => { texts(w)[1].data = t; }));
    it(`typed "${t}" in a quote`, () => same('> abc', (w) => { texts(w).find((x) => x.data === 'abc')!.data = t; }));
  }
});

describe('G19 heading closing # variations', () => {
  for (const end of [' #', NBSP + '#', ' #' + NBSP, ' ##', '\t#', ' # #', ' \\#']) {
    it(`heading text ending ${JSON.stringify(end)}`, () => same('## Learn C', typeAfter('C', end)));
  }
  it('heading that is only "#"', () => same('## x', (w) => { texts(w)[0].data = '#'; }));
});

describe('G20 digit after an inline formula, variations', () => {
  it('space deleted between formula and digit', () => same('公式 $x$ 1 个', (w) => { const t = texts(w).find((x) => x.data.startsWith(' 1'))!; t.data = t.data.slice(1); }));
  it('formula in a table cell followed by a digit', () => same('| $x$a | b |\n|---|---|\n| c | d |', (w) => { const t = texts(w).find((x) => x.data === 'a')!; t.data = '1'; }));
  it('display-inline formula followed by a digit', () => same('a $$x$$b', (w) => { const t = texts(w).find((x) => x.data === 'b')!; t.data = '1'; }));
  it('formula whose TeX starts and ends with a digit, then the following comma deleted (FAILS-TODAY)', () => same('面积 $3\\times4$，完', del('，')));
  it('formula whose TeX starts and ends with a digit, at the paragraph end after an edit (FAILS-TODAY)', () => same('面积 $3\\times4$.', del('.')));
  it('formula 1+2 followed by a typed space (FAILS-TODAY)', () => same('和 $1+2$x', (w) => { const t = texts(w).find((x) => x.data === 'x')!; t.data = ' x'; }));
});

describe('G21 adjacent formatting, variations', () => {
  const noHtml = (md: string): boolean => !/<\/?(strong|em|del|s|b|i)>/.test(md);
  it('*em*~~del~~', () => same('*斜*~~删~~ 文', typeAfter('文', 'x'), noHtml));
  it('~~del~~**bold** CJK', () => same('~~删~~**粗**文', typeAfter('文', 'x'), noHtml));
  it('**bold**`code`*em*', () => same('**粗**`c`*斜*文', typeAfter('文', 'x'), noHtml));
  it('in a table cell', () => same('| **粗**~~删~~ | b |\n|---|---|\n| c | d |', typeAfter('d', 'x'), noHtml));
  it('in a heading', () => same('## **粗**~~删~~', typeAfter('删', 'x'), noHtml));
  it('after a split: line starting with ~~del~~**bold**', () => same('a\n~~删~~**粗**', typeAfter('粗', 'x'), noHtml));
  it('bold in bold', () => same('**a __b__ c**', typeAfter('c', 'x')));
  it('em in em', () => same('*a _b_ c*', typeAfter('c', 'x')));
});

describe('I5: the gate and reference definitions elsewhere in the document', () => {
  const refs = (): References => { const env: { references: References } = { references: {} }; mdk.md.parse('[x]: https://ref.example/x\n[X2]: https://ref.example/x2\n', env); return env.references; };
  // K22 (H19): accepted for 0.2.0 (CONTRACT §11, Stage-2c review decisions): a task list in a document that defines
  // a reference named x is refused for editing. Marked known by fix-serial (round 3); the assertion is unchanged.
  it.fails('a task item "[x]" in a document that defines [x] is editable: the gate does not refuse it (FAILS-TODAY)', () => {
    const r = refs();
    const w = mount(render('- [x] done\n- [ ] open', r));
    const base = serializeBlock(w, BlockKind.List, { ...sourceStyleHints('- [x] done\n- [ ] open'), editing: true });
    expect(baselineFaithful(w, BlockKind.List, base), `baseline ${JSON.stringify(base)}`).toBe(true);
  });
  it('the gate never passes that block while its baseline renders differently in the document (no false pass)', () => {
    const w = mount(render('- [x] done', refs()));
    const base = serializeBlock(w, BlockKind.List, { ...sourceStyleHints('- [x] done'), editing: true });
    const gate = baselineFaithful(w, BlockKind.List, base);
    const inDoc = canon(mount(render(base, refs())));
    expect(gate && inDoc !== canon(w), `base ${JSON.stringify(base)}`).toBe(false);
  });
});

describe('I5: three adjacent lists in one List block are refused by the gate (ordinary Markdown)', () => {
  for (const src of ['- a\n\n* b\n\n+ c', '- a\n\n* b\n\n- [ ] c', '1. a\n\n7) b\n\n3. c', '* a\n* b\n\n+ c\n+ d\n\n- e']) {
    // K22 (H18): accepted for 0.2.0 (CONTRACT §11, Stage-2c review decisions): one List block holding three or more
    // adjacent lists of the same type is refused for editing. Marked known by fix-serial (round 3); assertion unchanged.
    it.fails(`${JSON.stringify(src)} (FAILS-TODAY)`, () => {
      const w = mount(render(src));
      const base = serializeBlock(w, BlockKind.List, { ...sourceStyleHints(src), editing: true });
      expect(baselineFaithful(w, BlockKind.List, base), `baseline ${JSON.stringify(base)}`).toBe(true);
    });
  }
});
