// @vitest-environment jsdom
// Acceptance gate for the in-preview editing serializer (CONTRACT §11): for every block of the test
// documents and of a tricky corpus, render → mount (exactly like the preview: DOMPurify + code-fence
// wrapper) → serializeBlock → render again must give the same HTML after normalisation. A second suite
// pins the exact source produced for canonical Markdown, and the accepted normalisations explicitly.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { blockSource, segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { normalizeHtml, serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

const render = (src: string, refs: References = {}): string => mdk.renderBlock(src, { references: { ...refs } }).html;

/** Mounts worker HTML the way createPreview.mountItem does. */
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  return w;
}

function kindOf(src: string): BlockKind {
  const segs = segmentAll(src.split('\n'));
  return segs.length > 0 ? segs[0].kind : BlockKind.Prose;
}

/** render(serialize(render(src))) vs render(src); returns the serialization for further checks.
 *  `styled`: with the block's own source-style hints (sourceStyleHints, as an edit session passes them). */
function roundTrip(src: string, refs: References = {}, styled = false): { md: string; a: string; b: string } {
  const html = render(src, refs);
  const md = serializeBlock(mount(html), kindOf(src), styled ? sourceStyleHints(src) : {});
  const again = render(md, refs);
  // Compare what the user sees: both sides through the same sanitizer.
  const a = normalizeHtml(mount(html).innerHTML);
  const b = normalizeHtml(mount(again).innerHTML);
  return { md, a, b };
}

function docBlocks(path: string): Array<{ src: string; kind: BlockKind; line: number }> {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  return segmentAll(lines).map((s) => ({
    src: blockSource(lines, { startLine: s.start + 1, lineCount: s.count }).replace(/\n+$/, ''),
    kind: s.kind,
    line: s.start + 1,
  }));
}

function referencesOf(text: string): References {
  const env: { references: References } = { references: {} };
  mdk.md.parse(text, env);
  return env.references;
}

describe('normalizeHtml', () => {
  it('ignores attribute order, data-l and inter-block whitespace; keeps pre whitespace', () => {
    expect(normalizeHtml('<p data-l="3" class="a" id="b">x  \n y</p>\n<ul>\n<li>a</li>\n</ul>'))
      .toBe(normalizeHtml('<p id="b" class="a">x y</p><ul><li>a</li></ul>'));
    expect(normalizeHtml('<pre><code>a  b\n</code></pre>')).not.toBe(normalizeHtml('<pre><code>a b\n</code></pre>'));
    expect(normalizeHtml('<p>a <em>b</em></p>')).not.toBe(normalizeHtml('<p>a<em>b</em></p>'));
  });
});

// Test strategy (CONTRACT §11 decision T1): medium.md is checked on a deterministic SAMPLE by default —
// every 10th of its distinct blocks — and in full only with MDR_FULL_FUZZ=1. The explicit timeouts are
// generous for a loaded machine; a timed-out synchronous case keeps running while vitest tears the
// environment down, which used to turn the whole suite into an hour-long run.
const FULL = process.env.MDR_FULL_FUZZ === '1';
describe.each([
  ['test-data/small.md', 1, 200, 20],
  ['test-data/medium.md', FULL ? 1 : 10, 5000, FULL ? 20 : 10],
])('round trip of every block: %s (every %i. distinct block)', (path, every, minBlocks, minChecked) => {
  it('render(serialize(render(src))) === render(src)', () => {
    const text = readFileSync(path, 'utf8');
    const refs = referencesOf(text);
    const blocks = docBlocks(path);
    expect(blocks.length).toBeGreaterThan(minBlocks);
    let checked = 0;
    let distinct = 0;
    const seen = new Set<string>();
    for (const b of blocks) {
      if (b.kind === BlockKind.Html) continue;
      if (seen.has(b.src)) continue;       // medium.md repeats its sections; each distinct block once
      seen.add(b.src);
      if (distinct++ % every !== 0) continue;
      const r = roundTrip(b.src, refs);
      if (r.a !== r.b) throw new Error(`block at line ${b.line} does not round-trip\nsource:\n${b.src}\nserialized:\n${r.md}\n${r.a}\n${r.b}`);
      const st = sourceStyleHints(b.src);
      if (st.tableDelim !== undefined || st.tightHeadings || st.keepNbsp) {
        const rs = roundTrip(b.src, refs, true);
        if (rs.a !== rs.b) throw new Error(`block at line ${b.line} does not round-trip with its source-style hints\nsource:\n${b.src}\nserialized:\n${rs.md}\n${rs.a}\n${rs.b}`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(minChecked);
  }, FULL ? 900_000 : 90_000);
});

/** Every entry is one block (or a few blocks that the serializer must keep equivalent). */
const TRICKY: string[] = [
  // nested lists with code and quotes; loose vs tight
  '- a\n  - b\n    - c\n- d',
  '1. one\n2. two\n   1. nested\n   2. nested two\n3. three',
  '- item\n\n  ```js\n  const x = 1;\n\n  const y = 2;\n  ```\n\n- next',
  '- quote inside\n\n  > q1\n  > q2\n\n- after',
  '- loose one\n\n- loose two\n\n  second paragraph\n\n- loose three',
  '- tight\n- tight two',
  '3. starts at three\n4. four',
  '- [ ] todo\n- [x] done\n  - [ ] nested todo',
  '- [ ] loose todo\n\n- [x] loose done',
  '- a\n\n* b',
  '1. a\n\n1) b',
  '10. ten\n11. eleven\n    - nested under ten-width',
  // tables
  '| a | b | c |\n|:--|:-:|--:|\n| `x\\|y` | p \\| q | **b** |\n| | empty | [l](http://x.y) |',
  '| 列1 | 列2 |\n|-----|-----|\n| 中文 | $x^2$ |',
  // links, images
  '[text](http://example.com "the title") and [paren](http://x.com/a_(b)) and <https://x.com/a_b>',
  '![alt *x*](http://img.example/a.png "img title") ![](b.png)',
  '[![img](i.png)](http://link)',
  '[中文链接](http://例子.com/路径)',
  'mail z@x.com and http://bare.example/path ok',
  '[a](<url with spaces>) [b](url\\(x)',
  // math
  'inline $a_b + \\\\ c$ and display $$\\frac{1}{2}$$ in text',
  '$$\n\\int_0^1 x^2 \\, dx\n\\\\ a_{b}\n$$',
  'price $5 and 5$ each; \\$escaped\\$ dollars; $$',
  // strikethrough, hard breaks, emphasis
  '~~struck~~ and ~single~ tilde and a~~b',
  'line one  \nline two\\\nline three\nsoft four',
  '**bold** *em* ***both*** **a *b*** *a **b***',
  '中文**加粗**、*斜体*，**「引号」**测试',
  'snake_case and _em_ and __strong__ and 2*3*4 and a * b',
  // headings with inline markup
  '# Heading with `code` and **bold** #',
  '## C # sharp ##',
  '###### six',
  'Setext one\n===',
  'Setext two\n---',
  // code fences
  '```\nplain\n\n\nwith blank lines\n```',
  '~~~python\ndef f():\n    return "```"\n~~~',
  '````md\n```js\ninner\n```\n````',
  '```\n```',
  '    indented code\n    block',
  // text with markdown-significant characters
  '\\* not a list\n\\# not a heading\n\\> not a quote\n1\\. not ordered\n\\+ not plus\n\\- not dash',
  'asterisk \\* underscore \\_ backtick \\` hash # gt > dash - plus + [brackets] \\[x\\] $ dollar < lt & amp &amp; &copy;',
  'a <kbd>Ctrl</kbd>+<kbd>C</kbd> and <sup>2</sup> and <span class="x">span</span>',
  'emoji 😀🎉 and CJK punctuation：，。！？「」『』（）【】',
  'escaped \\\\ backslash and C:\\dir\\file and trailing \\',
  'ends with two spaces then text  \nnext',
  '<not-a-tag and a < b > c and 1 < 2',
  '&#35; not heading entity and &lt;b&gt; literal',
  // quotes
  '> quote\n> > nested\n>\n> back',
  '> - list in quote\n> - two\n>\n> ```\n> code in quote\n> ```',
  // horizontal rule inside list
  '- a\n\n  ---\n\n- b',
];

describe('round trip: tricky corpus', () => {
  it.each(TRICKY.map((s, i) => [i, s]))('#%i', (_i, src) => {
    const r = roundTrip(src as string);
    expect(r.b, `serialized:\n${r.md}`).toBe(r.a);
    const rs = roundTrip(src as string, {}, true);
    expect(rs.b, `serialized with source-style hints:\n${rs.md}`).toBe(rs.a);
    // idempotent: serializing the re-rendered block gives the same Markdown again
    expect(serializeBlock(mount(render(r.md)), kindOf(r.md))).toBe(r.md);
  });
});

/** Canonical Markdown comes back byte-identical. */
const CANONICAL: string[] = [
  'plain paragraph',
  'soft\nline\nbreaks',
  'hard  \nbreak',
  '**bold** and *em* and `code` and ~~del~~',
  '# H1',
  '### H3 with *em*',
  '- a\n- b\n  - c',
  '1. a\n2. b\n3. c',
  '- a\n\n- b',
  '- [ ] todo\n- [x] done',
  '> quote\n>\n> more',
  '```ts\nconst x = 1;\n```',
  '| a | b |\n| :-- | --: |\n| 1 | 2 |',
  '[link](https://example.com "title")',
  '![alt](a.png)',
  'math $x^2$ and $$y$$',
  '$$\n\\int x\n$$',
  'snake_case_name and a * b and 5 $ each',
  'https://example.com/path and me@example.com',
  '<https://x.com/a_b>',
  '中文段落，带标点。',
  '\\# literal hash',
  'a \\*literal\\* star',
  // fix round C3: a non-breaking space from the source stays one; characters that need no escaping
  // in their place stay unescaped
  'a&nbsp;b and 中&nbsp;文',
  'price $5 each',
  'a lone [ bracket',
  'a ~~~ b',
  'x ~ y',
];

describe('canonical source is reproduced exactly', () => {
  it.each(CANONICAL.map((s) => [s]))('%j', (src) => {
    expect(serializeBlock(mount(render(src)), kindOf(src))).toBe(src);
  });
});

describe('accepted normalisations (documented in serialize.ts)', () => {
  const norm = (src: string): string => serializeBlock(mount(render(src)), kindOf(src));
  it.each([
    ['_em_', '*em*'],
    ['__strong__', '**strong**'],
    ['+ a\n+ b', '- a\n- b'],
    ['* a\n* b', '- a\n- b'],
    ['1) a\n2) b', '1. a\n2. b'],
    ['1. a\n1. b\n1. c', '1. a\n2. b\n3. c'],
    ['Title\n=====', '# Title'],
    ['Title\n-----', '## Title'],
    ['line<br>next', 'line  \nnext'],
    ['|a|b|\n|-|-|\n|1|2|', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['    code', '```\ncode\n```'],
    ['<b>x</b> <i>y</i> <s>z</s>', '**x** *y* ~~z~~'],
  ])('%j → %j', (src, want) => {
    expect(norm(src)).toBe(want);
  });
  it.each([
    ['see [1] and arr[0]', 'see \\[1] and arr\\[0]'],
    ['$5 and $6', '\\$5 and \\$6'],
    ['a $x$ b $', 'a $x$ b $'],
    ['~~a~~ and ~~~', '~~a~~ and \\~\\~\\~'],
    ['[a](http://x.y) and ]', '[a](http://x.y) and ]'],
    ['[a\\]b](http://x.y)', '[a\\]b](http://x.y)'],
  ])('escaping in context: %j → %j', (src, want) => {
    expect(norm(src)).toBe(want);
  });
  it('a table keeps its own delimiter row while columns and alignment are unchanged', () => {
    const src = '|a|b|c|\n|-|:-:|---:|\n|1|2|3|';
    const el = mount(render(src));
    expect(serializeBlock(el, BlockKind.Table, sourceStyleHints(src))).toBe('| a | b | c |\n|-|:-:|---:|\n| 1 | 2 | 3 |');
    // alignment changed in the DOM: the canonical row
    (el.querySelector('th') as HTMLElement).setAttribute('style', 'text-align:right');
    expect(serializeBlock(el, BlockKind.Table, sourceStyleHints(src)).split('\n')[1]).toBe('| --: | :-: | --: |');
    // a column added: the canonical row
    const el2 = mount(render(src));
    for (const tr of Array.from(el2.querySelectorAll('tr'))) tr.appendChild(document.createElement(tr.parentElement!.tagName === 'THEAD' ? 'th' : 'td'));
    expect(serializeBlock(el2, BlockKind.Table, sourceStyleHints(src)).split('\n')[1]).toBe('| --- | :-: | --: | --- |');
    // inside a list item the serialized indentation is kept
    const li = '- item\n\n  |a|b|\n  |-|-|\n  |1|2|';
    const md = serializeBlock(mount(render(li)), BlockKind.List, sourceStyleHints(li));
    expect(md.split('\n')[3]).toBe('  |-|-|');
    expect(normalizeHtml(mount(render(md)).innerHTML)).toBe(normalizeHtml(mount(render(li)).innerHTML));
  });
  it('non-breaking spaces: kept between characters; with the keepNbsp hint (source has &nbsp;) in runs too', () => {
    const src = 'HTML 实体 以及 &nbsp;不换行 a&nbsp;b';
    expect(sourceStyleHints(src).keepNbsp).toBe(true);
    const el = mount(render(src));
    const kept = serializeBlock(el, BlockKind.Prose, { editing: true, ...sourceStyleHints(src) });
    expect(kept).toBe(src);
    expect(serializeBlock(el, BlockKind.Prose, { editing: true })).toBe('HTML 实体 以及 不换行 a&nbsp;b');
    // browser-made NBSPs (typed spaces at a node edge / line end) still become spaces with the hint
    const typed = document.createElement('section');
    typed.innerHTML = '<p>a\u00a0<b>bold</b>\u00a0<span style="font-size: 16px">x</span>\u00a0</p>';
    expect(serializeBlock(typed, BlockKind.Prose, { editing: true, keepNbsp: true })).toBe('a **bold** x');
    // the keepNbsp key is part of the list cache key
    const list = Array.from({ length: 9 }, (_, i) => `- i${i} \u00a0x`).join('\n');
    const lel = mount(render(list));
    expect(serializeBlock(lel, BlockKind.List, { keepNbsp: true }).split('\n')[0]).toBe('- i0 &nbsp;x');
    expect(serializeBlock(lel, BlockKind.List).split('\n')[0]).toBe('- i0 x');
  });
  it('a heading directly followed by content stays tight with the hint', () => {
    const src = '# T\npara\n\n## U\n- x';
    const el = mount(render(src));
    expect(serializeBlock(el, BlockKind.Prose, sourceStyleHints(src))).toBe('# T\npara\n\n## U\n- x');
    expect(serializeBlock(el, BlockKind.Prose)).toBe('# T\n\npara\n\n## U\n\n- x');
  });
  it('reference links become inline links', () => {
    const refs = referencesOf('[r]: http://ref.example "T"');
    const md = serializeBlock(mount(render('see [x][r]', refs)), BlockKind.Prose);
    expect(md).toBe('see [x](http://ref.example "T")');
  });
});

describe('serializer details', () => {
  it('keeps a code block\'s own fence when given the hint', () => {
    const el = mount(render('~~~ts {1,3}\nx\n~~~'));
    expect(serializeBlock(el, BlockKind.Code, { fence: { open: '~~~ts {1,3}', close: '~~~' } })).toBe('~~~ts {1,3}\nx\n~~~');
    expect(serializeBlock(mount(render('    a\n    b')), BlockKind.Code, { fence: { indent: '    ' } })).toBe('    a\n    b');
  });
  it('escalates the fence when the content contains one', () => {
    const el = mount(render('```\nx\n```'));
    el.querySelector('code')!.textContent = 'a\n```\nb\n';
    expect(serializeBlock(el, BlockKind.Code)).toBe('````\na\n```\nb\n````');
  });
  it('ignores UI-only elements and reads edited task state', () => {
    const el = mount(render('- [ ] a'));
    const note = document.createElement('div');
    note.className = 'md-plain__note';
    note.textContent = 'ui';
    el.prepend(note);
    (el.querySelector('input') as HTMLInputElement).checked = true;
    expect(serializeBlock(el, BlockKind.List)).toBe('- [x] a');
  });
  it('turns browser editing artefacts into Markdown', () => {
    const el = document.createElement('section');
    el.innerHTML = '<p>a\u00a0<b>bold</b>\u00a0<span style="font-size: 16px">x</span><br><br></p><div>next</div>';
    expect(serializeBlock(el, BlockKind.Prose, { editing: true })).toBe('a **bold** x\n\nnext');
    const p = document.createElement('section');
    p.innerHTML = '<p>one<br>two\u00a0\u00a0</p>';
    expect(serializeBlock(p, BlockKind.Prose, { editing: true })).toBe('one  \ntwo');
  });
  it('typed Markdown syntax stays literal text', () => {
    const el = document.createElement('section');
    el.innerHTML = '<p># not heading **not bold** `not code` [not](link) $x$</p>';
    const md = serializeBlock(el, BlockKind.Prose);
    expect(md).toBe('\\# not heading \\*\\*not bold\\*\\* \\`not code\\` \\[not](link) \\$x$');
    expect(normalizeHtml(render(md))).toBe(normalizeHtml('<p># not heading **not bold** `not code` [not](link) $x$</p>'));
  });
  it('a bare URL is written bare only where linkify stops at its end (integrator, fixer-B request)', () => {
    const p = (html: string): string => {
      const el = document.createElement('section');
      el.innerHTML = `<p>${html}</p>`;
      return serializeBlock(el, BlockKind.Prose, { editing: true });
    };
    // ⌘K at a collapsed caret, then typing 后 right after the link
    expect(p('合并。<a href="https://c.example/">https://c.example/</a>后')).toBe('合并。<https://c.example/>后');
    expect(normalizeHtml(render('合并。<https://c.example/>后'))).toContain('href="https://c.example/"');
    expect(p('<a href="https://c.example/">https://c.example/</a>x')).toBe('<https://c.example/>x');
    expect(p('<a href="https://c.example/">https://c.example/</a>.b')).toBe('<https://c.example/>.b');
    expect(p('<em><a href="https://c.example/">https://c.example/</a></em>后')).not.toContain('https://c.example/后');
    expect(p('<a href="mailto:a@b.cn">a@b.cn</a>后')).toBe('<a@b.cn>后');
    // linkify ends the link there: stays bare, as the canonical corpus expects
    for (const tail of ['', ' 后', '。', '，后', '）', '.', '. x', ')', '!']) {
      expect(p(`<a href="https://c.example/">https://c.example/</a>${tail}`)).toBe(`https://c.example/${tail}`);
    }
    expect(p('<strong><a href="https://c.example/">https://c.example/</a></strong> y')).toBe('**https://c.example/** y');
    for (const tail of ['后', 'x', '.b', ' 后', '。']) {
      const md = p(`<a href="https://c.example/">https://c.example/</a>${tail}`);
      expect(normalizeHtml(render(md))).toContain('<a href="https://c.example/">https://c.example/</a>');
    }
  });
  it('unsupportedReason: html blocks, plain fallbacks, comments, reference definitions', () => {
    expect(unsupportedReason(mount(render('para')))).toBeNull();
    expect(unsupportedReason(mount(render('<details>\n<summary>s</summary>\n\nx\n\n</details>')))).toMatch(/element/);
    const plain = document.createElement('section');
    plain.innerHTML = '<div class="md-plain__note">n</div><p class="md-plain">x</p>';
    expect(unsupportedReason(plain)).toBe('plain');
    expect(unsupportedReason(mount(render('a <!-- c --> b')), 'a <!-- c --> b')).toBe('comment');
    expect(unsupportedReason(mount(render('[r]: http://x')), '[r]: http://x')).toBe('reference');
  });
});

describe('escaping property: literal text typed in the preview stays literal', () => {
  // Deterministic PRNG (mulberry32) so a failure is reproducible.
  const rng = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ALPHABET = ['*', '_', '`', '#', '>', '-', '+', '1.', '2)', '[', ']', '(', ')', '$', '<', '&', '|', '!', '~', '\\', '=', ':', 'a', 'b', 'x_y', '中', '，', '。', '😀', ' ', ' ', ' ', '\n', 'x.y/', '&amp;', '<b>', '$$', '```', '~~~', '    ', ' '];
  const TAGS = ['strong', 'em', 'code', 'del', 'a'];
  const visible = (el: Element): string => (el.textContent ?? '').replace(/[\s ]+/g, ' ').trim();

  it('random paragraphs (text + inline markup) keep their visible text and markup', () => {
    const r = rng(Number(process.env.MDR_FUZZ_SEED ?? 20260926));
    const N = Number(process.env.MDR_FUZZ_N ?? 2000);
    for (let n = 0; n < N; n++) {
      const p = document.createElement('p');
      const parts = 1 + Math.floor(r() * 4);
      for (let k = 0; k < parts; k++) {
        let s = '';
        const len = 1 + Math.floor(r() * 8);
        for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
        if (r() < 0.35) {
          const tag = TAGS[Math.floor(r() * TAGS.length)];
          const e = document.createElement(tag);
          const inner = s.replace(/\n/g, ' ').trim() || 'w';
          e.textContent = inner;
          if (tag === 'a') e.setAttribute('href', 'http://example.com/p');
          // sometimes nest a second, different formatting element inside
          if (tag !== 'code' && r() < 0.3) {
            const t2 = ['strong', 'em', 'code', 'del'].filter((t) => t !== tag)[Math.floor(r() * 3)];
            const inner2 = document.createElement(t2);
            inner2.textContent = ALPHABET[Math.floor(r() * 20)] + 'z';
            e.append(inner2);
          }
          p.append(e);
        } else p.append(s);
      }
      // Back-to-back runs of the same formatting are one run in Markdown (the serializer merges them).
      for (const e of Array.from(p.children)) {
        const prev = e.previousSibling;
        if (prev && prev.nodeType === 1 && (prev as Element).tagName === e.tagName && e.tagName !== 'CODE' && e.tagName !== 'A') {
          while (e.firstChild) prev.appendChild(e.firstChild);
          e.remove();
        }
      }
      const section = document.createElement('section');
      section.append(p);
      if (visible(p) === '') continue;
      const md = serializeBlock(section, BlockKind.Prose);
      const back = mount(render(md));
      const want = visible(section);
      const got = visible(back);
      if (got !== want) throw new Error(`#${n}: text differs\nDOM: ${JSON.stringify(p.innerHTML)}\nmd: ${JSON.stringify(md)}\nwant: ${JSON.stringify(want)}\ngot:  ${JSON.stringify(got)}`);
      // The same inline elements, in the same order (a trailing / leading space may move out of them).
      const tags = (el: Element) => Array.from(el.querySelectorAll('strong,em,code,del,s,a')).map((e) => (e.tagName === 'S' ? 'DEL' : e.tagName) + ':' + visible(e)).join('|');
      if (tags(back) !== tags(section)) throw new Error(`#${n}: markup differs\nDOM: ${JSON.stringify(p.innerHTML)}\nmd: ${JSON.stringify(md)}\nwant: ${tags(section)}\ngot:  ${tags(back)}`);
    }
  });
});
