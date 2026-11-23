// @vitest-environment jsdom
// test/fix2-g-fidelity.test.ts — fix-gate (stage 2b): the baseline fidelity gate (CONTRACT §11, U12).
// Blocks are rendered by the project's real pipeline (md.ts with KaTeX and highlight.js, the preview's
// sanitizer, wrapCodeFences) into a section.md-block wrapper, as createPreview mounts them. The gate must
// refuse deliberately wrong baselines of the kinds the r1 verifiers found (none of these tests depends on the
// serializer being broken) and accept the block's own source and the serializer's output for every kind.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wrapCodeFences } from '../src/preview/createPreview';
import { baselineFaithful, canonicalForm, FIDELITY_GATE, fidelityStats } from '../src/preview/fidelity';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

/** A block as createPreview mounts it. */
function mount(src: string): HTMLElement {
  const r = mdk.renderBlock(src, { references: {} });
  const w = document.createElement('section');
  w.className = 'md-block';
  w.dataset.id = '1';
  if (r.flags & HTML_FLAG_TRUSTED) w.innerHTML = r.html;
  else w.replaceChildren(sanitizeToFragment(r.html));
  wrapCodeFences(w);
  if (r.flags & HTML_FLAG_RESERVED) w.setAttribute('data-mdr-x', '');
  document.body.appendChild(w);
  return w;
}

/** The serializer's baseline as begin() computes it (style hints, editing). */
const baselineOf = (w: Element, kind: BlockKind, src: string): string =>
  serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });

interface Case { name: string; kind: BlockKind; src: string; wrong: string[] }

// ---- the r1 kinds: a right and a wrong baseline for the same block
const R1: Case[] = [
  {
    name: 'G3: a formula in a table cell lost its pipe escapes', kind: BlockKind.Table,
    src: '| 名称 | 公式 |\n|---|---|\n| 绝对值 | $\\|x\\|$ |',
    wrong: ['| 名称 | 公式 |\n|---|---|\n| 绝对值 | $|x|$ |', '| 名称 | 公式 |\n|---|---|\n| 绝对值 | x$|x|$ |'],
  },
  {
    name: 'G2: an autolink written bare after a letter', kind: BlockKind.Prose,
    src: 'word<https://e.com> tail',
    wrong: ['wordhttps://e.com tail'],
  },
  {
    name: 'G2: a mail autolink written bare after CJK text', kind: BlockKind.Prose,
    src: '请联系<support@example.com> 获取帮助。',
    wrong: ['请联系support@example.com 获取帮助。'],
  },
  {
    name: 'G2: a bare URL that swallows the text after it', kind: BlockKind.Prose,
    src: '文档 <https://example.com/docs>(英文) 可参考',
    wrong: ['文档 https://example.com/docs(英文) 可参考'],
  },
  {
    name: 'G2: bold next to an autolink exposes its asterisks', kind: BlockKind.Prose,
    src: '**注意！**<https://example.com/x>',
    wrong: ['**注意！**https://example.com/x'],
  },
  {
    name: 'G9: a dropped &nbsp; line in a quote', kind: BlockKind.Quote,
    src: '> 第一段\n>\n> &nbsp;\n>\n> 第三段',
    wrong: ['> 第一段\n>\n> 第三段'],
  },
  {
    name: 'G9: a dropped &nbsp; paragraph under a tight heading', kind: BlockKind.Heading,
    src: '## 标题\n&nbsp;',
    wrong: ['## 标题'],
  },
  {
    name: 'G4: a private-use character replaced by a line break', kind: BlockKind.Prose,
    src: '图标\uE000文字与说明',
    wrong: ['图标\n文字与说明', '图标文字与说明'],
  },
  {
    name: 'G4: a private-use character that split a table cell', kind: BlockKind.Table,
    src: '| 名 | 图\uE002标 |\n|---|---|\n| a | b |',
    wrong: ['| 名 | 图 | 标 |\n|---|---|---|\n| a | b | |'],
  },
  {
    name: 'G1: hidden text in a display:none span written as visible text', kind: BlockKind.Prose,
    src: 'a <span style="display:none">secret</span> b',
    wrong: ['a secret b', 'a  b'],
  },
  {
    name: 'a link whose destination changed', kind: BlockKind.Prose,
    src: '见[文档](https://example.com/docs "说明")。',
    wrong: ['见[文档](https://example.com/doc "说明")。', '见[文档](https://example.com/docs)。', '见[文档](https://example.com/docs "说")。'],
  },
  {
    name: 'a task state flipped', kind: BlockKind.List,
    src: '- [x] 完成\n- [ ] 未完成',
    wrong: ['- [ ] 完成\n- [ ] 未完成', '- [x] 完成\n- [x] 未完成', '- 完成\n- [ ] 未完成'],
  },
  {
    name: 'a table alignment lost', kind: BlockKind.Table,
    src: '| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |',
    wrong: ['| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |', '| a | b | c |\n|:---|---:|:---:|\n| 1 | 2 | 3 |'],
  },
];

// ---- every kind the session can edit
const KINDS: Case[] = [
  {
    name: 'paragraph with inline formatting', kind: BlockKind.Prose,
    src: '中文段落含**粗体**、*斜体*、`代码`、~~删除~~、[链接](https://example.com/a "标题")与 $E=mc^2$ 公式。',
    wrong: [
      '中文段落含**粗体**、*斜体*、`代码`、~~删除~~、[链接](https://example.com/a "标题")与 $E=mc^3$ 公式。',
      '中文段落含*粗体*、*斜体*、`代码`、~~删除~~、[链接](https://example.com/a "标题")与 $E=mc^2$ 公式。',
      '中文段落含**粗体**、*斜体*、代码、~~删除~~、[链接](https://example.com/a "标题")与 $E=mc^2$ 公式。',
      '中文段落含**粗体**、*斜体*、`代码`、删除、[链接](https://example.com/a "标题")与 $E=mc^2$ 公式。',
      '中文段落含**粗体**、*斜体*、`代码`、~~删除~~、[链接](https://example.com/a "标题")与 $$E=mc^2$$ 公式。',
    ],
  },
  {
    name: 'paragraph with a hard break and raw inline HTML', kind: BlockKind.Prose,
    src: 'Inline <kbd>Ctrl</kbd>+<kbd>K</kbd> and <sup>sup</sup>  \nsecond line',
    wrong: ['Inline <kbd>Ctrl</kbd>+<kbd>K</kbd> and <sup>sup</sup>\nsecond line', 'Inline <kbd>Ctrl</kbd>+<kbd>K</kbd> and <sub>sup</sub>  \nsecond line', 'Inline <kbd class="x">Ctrl</kbd>+<kbd>K</kbd> and <sup>sup</sup>  \nsecond line'],
  },
  {
    name: 'paragraph with an image', kind: BlockKind.Prose,
    src: '图 ![替代文字](img/a.png "图题") 后',
    wrong: ['图 ![替代](img/a.png "图题") 后', '图 ![替代文字](img/b.png "图题") 后', '图 ![替代文字](img/a.png) 后'],
  },
  {
    name: 'heading', kind: BlockKind.Heading,
    src: '## 标题 **粗**',
    wrong: ['### 标题 **粗**', '## 标题 粗', '标题 **粗**'],
  },
  {
    name: 'nested list', kind: BlockKind.List,
    src: '- 一级\n  - 二级\n    - 三级 **粗**\n      1. 四级有序\n- 一级二',
    wrong: ['- 一级\n- 二级\n    - 三级 **粗**\n      1. 四级有序\n- 一级二', '- 一级\n  - 二级\n    - 三级 **粗**\n      - 四级有序\n- 一级二', '- 一级\n\n  - 二级\n    - 三级 **粗**\n      1. 四级有序\n- 一级二'],
  },
  {
    name: 'ordered list with a start number', kind: BlockKind.List,
    src: '7. 七\n8. 八',
    wrong: ['1. 七\n2. 八', '7. 七\n\n8. 八', '- 七\n- 八'],
  },
  {
    name: 'task list', kind: BlockKind.List,
    src: '- [ ] 任务 A\n- [x] 任务 B\n- 普通项',
    wrong: ['- [ ] 任务 A\n- [ ] 任务 B\n- 普通项', '- [ ] 任务 A\n- [x] 任务 B\n- [ ] 普通项', '- [ ] 任务 A\n- [x] 任务B\n- 普通项'],
  },
  {
    name: 'quote with a nested quote and a list', kind: BlockKind.Quote,
    src: '> 引用一层\n> > 嵌套引用\n> > - 引用里的列表',
    wrong: ['> 引用一层\n> 嵌套引用\n> > - 引用里的列表', '> 引用一层\n> > 嵌套引用\n> > 引用里的列表', '引用一层\n> > 嵌套引用\n> > - 引用里的列表'],
  },
  {
    name: 'fenced code with a language (highlighted)', kind: BlockKind.Code,
    src: '```python\nprint("code")\nx = 1  # c\n```',
    wrong: ['```py\nprint("code")\nx = 1  # c\n```', '```python\nprint("code")\nx = 1 # c\n```', '```python\nprint("code")\nx = 1  # c\n\n```', '```\nprint("code")\nx = 1  # c\n```'],
  },
  {
    name: 'indented code', kind: BlockKind.Code,
    src: '    const a = 1;\n    <b>x</b>',
    wrong: ['    const a = 1;\n     <b>x</b>', '    const a = 1;'],
  },
  {
    name: 'table with inline code and an escaped pipe', kind: BlockKind.Table,
    src: '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| `a\\|b` | **x** | [l](https://e.example) |',
    wrong: ['| 左 | 中 | 右 |\n|:---|:---:|---:|\n| `a|b` | **x** | [l](https://e.example) |', '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| `a\\|b` | x | [l](https://e.example) |'],
  },
  {
    name: 'math block', kind: BlockKind.Math,
    src: '$$\n\\int_0^1 x\\,dx\n$$',
    wrong: ['$$\n\\int_0^1 x\\, dx\n$$', '$\\int_0^1 x\\,dx$', '\\int_0^1 x\\,dx'],
  },
];

describe('fix-gate: true positives of the r1 kinds (wrong baseline → false, right baseline → true)', () => {
  for (const c of [...R1, ...KINDS]) {
    it(c.name, () => {
      const w = mount(c.src);
      expect(baselineFaithful(w, c.kind, c.src), 'own source').toBe(true);
      for (const bad of c.wrong) expect(baselineFaithful(w, c.kind, bad), JSON.stringify(bad)).toBe(false);
      w.remove();
    });
  }
});

describe('fix-gate: G1, a block whose raw HTML carries a name the app reserves', () => {
  it('hidden data-md text in the baseline is refused, and so is any baseline that carries the name again', () => {
    const src = 'Fix the typo here <span data-md="[bank login](https://evil.example/phish)" style="display:none">.</span> please';
    const w = mount(src);
    expect(w.hasAttribute('data-mdr-x'), 'the worker marks it (U10 a/b); unsupportedReason refuses it first').toBe(true);
    expect(baselineFaithful(w, BlockKind.Prose, 'Fix the typo here [bank login](https://evil.example/phish) please')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, 'Fix the typo here . please')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, src), 'the worker would mark the written block: not faithful').toBe(false);
    // The sanitizer dropped data-md from the shown block; written without it, the block renders the same.
    expect(baselineFaithful(w, BlockKind.Prose, 'Fix the typo here <span style="display:none">.</span> please')).toBe(true);
    w.remove();
  });
});

describe('fix-gate: the serializer baseline of ordinary blocks passes', () => {
  // Blocks the serializer reproduces (rendering-equivalent, K5); a refusal here is a false refusal.
  const ORDINARY: Array<[BlockKind, string]> = [
    [BlockKind.Prose, 'Line one\nLine two soft-wrapped\nLine three'],
    [BlockKind.Prose, 'Entities &copy; &amp; &lt;tag&gt; &#169; &#x41; and a&nbsp;b non-breaking.'],
    [BlockKind.Prose, 'Hard break with two spaces  \nsecond line\\\nthird line after backslash break'],
    [BlockKind.Prose, 'Price $5 and $10, currency 5$ each, a * b, snake_case, C:\\path\\file.'],
    [BlockKind.Prose, 'Inline <kbd>Ctrl</kbd>+<kbd>K</kbd> and <sup>sup</sup> <sub>sub</sub> <mark>mark</mark>.'],
    [BlockKind.Heading, '# 对抗文档 Adversarial'],
    [BlockKind.List, '- [ ] 任务 A\n- [x] 任务 B'],
    [BlockKind.List, '1. 一\n2. 二\n   - 子项\n3. 三'],
    [BlockKind.Quote, '> 引用一层\n> > 嵌套引用'],
    [BlockKind.Code, '```js\nconst x = 1;\n```'],
    [BlockKind.Table, '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| 1 | **2** | `3` |'],
    [BlockKind.Math, '$$\n\\int_0^1 x\\,dx\n$$'],
  ];
  for (const [kind, src] of ORDINARY) {
    it(`${BlockKind[kind]}: ${JSON.stringify(src.slice(0, 40))}`, () => {
      const w = mount(src);
      const base = baselineOf(w, kind, src);
      const ok = baselineFaithful(w, kind, base);
      if (!ok) {
        const m = fidelityStats().last!;
        throw new Error(`refused: baseline ${JSON.stringify(base)}\nshown    ${m.shown.slice(Math.max(0, m.at - 60), m.at + 60)}\nrendered ${m.rendered.slice(Math.max(0, m.at - 60), m.at + 60)}`);
      }
      w.remove();
    });
  }
});

describe('fix-gate: what the comparison ignores and keeps', () => {
  it('session marks (data-mdr-o, contenteditable=false on formulas), data-mdr-x, focus tint, UI elements are ignored', () => {
    const src = 'a <span class="x" style="color:red">red</span> $x^2$ b';
    const w = mount(src);
    for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
    for (const m of Array.from(w.querySelectorAll('.md-math'))) m.setAttribute('contenteditable', 'false');
    w.setAttribute('data-mdr-x', '');
    w.setAttribute('contenteditable', 'true');
    w.querySelector('p')!.classList.add('is-focus');
    const ui = document.createElement('div');
    ui.setAttribute('data-mdr-ui', '');
    ui.textContent = 'hint';
    w.appendChild(ui);
    const before = w.outerHTML;
    expect(baselineFaithful(w, BlockKind.Prose, src)).toBe(true);
    expect(w.outerHTML, 'the block is not modified').toBe(before);
  });

  it('whitespace that does not render is ignored; NBSP and spaces between words are not', () => {
    const w = mount('a b\nc');
    expect(baselineFaithful(w, BlockKind.Prose, 'a  b c')).toBe(true);
    expect(baselineFaithful(w, BlockKind.Prose, 'a b\n\nc')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, 'a&nbsp;b c')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, 'ab c')).toBe(false);
  });

  it('highlighted code compares by its text; md-codewrap is transparent', () => {
    const w = mount('```ts\nconst x: number = 1;\n```');
    expect(w.querySelector('.md-codewrap')).not.toBeNull();
    expect(w.querySelector('.hljs-keyword')).not.toBeNull();
    expect(baselineFaithful(w, BlockKind.Code, '~~~ts\nconst x: number = 1;\n~~~')).toBe(true);
    expect(baselineFaithful(w, BlockKind.Code, '```ts\nconst x: number = 2;\n```')).toBe(false);
  });

  it('a checkbox compares by the state it shows', () => {
    const w = mount('- [x] a');
    expect(baselineFaithful(w, BlockKind.List, '- [x] a')).toBe(true);
    (w.querySelector('input') as HTMLInputElement).checked = false;
    expect(baselineFaithful(w, BlockKind.List, '- [x] a')).toBe(false);
    expect(baselineFaithful(w, BlockKind.List, '- [ ] a')).toBe(true);
  });

  it('a formula compares by kind and TeX (KaTeX annotation against the stub)', () => {
    const w = mount('x $a+b$ y');
    expect(w.querySelector('annotation')).not.toBeNull();
    expect(baselineFaithful(w, BlockKind.Prose, 'x $a+b$ y')).toBe(true);
    expect(baselineFaithful(w, BlockKind.Prose, 'x $$a+b$$ y')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, 'x $a-b$ y')).toBe(false);
    expect(baselineFaithful(w, BlockKind.Prose, 'x \\$a+b\\$ y')).toBe(false);
    const m = mount('$$\n\n\\frac{1}{2}\n\n$$');
    expect(baselineFaithful(m, BlockKind.Math, '$$\n\\frac{1}{2}\n$$'), 'whitespace at the TeX edges').toBe(true);
  });

  it('a link rendered from a reference definition passes as an inline link', () => {
    const r = mdk.renderBlock('see [the docs][d] now', { references: { D: { href: 'https://example.com/d', title: 'T' } } });
    const w = document.createElement('section');
    w.replaceChildren(sanitizeToFragment(r.html));
    expect(w.querySelector('a')).not.toBeNull();
    expect(baselineFaithful(w, BlockKind.Prose, 'see [the docs](https://example.com/d "T") now')).toBe(true);
    expect(baselineFaithful(w, BlockKind.Prose, 'see [the docs][d] now'), 'no definition on the main thread').toBe(false);
  });

  it('fix-serial-1: an item written as "- <br>" (html_block with data-l) and "- [x] &nbsp;" are stable', () => {
    const a = '- a\n- <br>\n- c';
    const w = mount(a);
    expect(w.querySelector('br[data-l]')).not.toBeNull();
    expect(baselineFaithful(w, BlockKind.List, a)).toBe(true);
    const b = '- [x] &nbsp;\n- b';
    const v = mount(b);
    expect(baselineFaithful(v, BlockKind.List, b)).toBe(true);
    expect(baselineFaithful(v, BlockKind.List, '- [x]\n- b')).toBe(false);
  });

  it('a baseline the worker would render as PLAIN or mark as reserved is refused', () => {
    const w = mount('text');
    expect(baselineFaithful(w, BlockKind.Prose, 'text <span class="md-math">x</span>')).toBe(false);
    expect(fidelityStats().last!.rendered).toContain('not rendered');
  });

  it('equal renderings: an edge space of em/strong moved outside; empty bare copies the HTML parser leaves behind', () => {
    const w = mount('raw <strong>/<em> HTML; dropped</em></strong> tail');
    expect(baselineFaithful(w, BlockKind.Prose, 'raw **/ *HTML; dropped*** tail')).toBe(true);
    // a space at the edge of a struck-through or linked run is drawn: not the same
    const d = mount('a<del> x</del> b');
    expect(baselineFaithful(d, BlockKind.Prose, 'a ~~x~~ b')).toBe(false);
    // an unclosed <strong> in a heading: the parser re-opens an empty <strong> after the heading
    const h = sanitizeToFragment('<h3>t <strong>x</strong></h3><strong></strong>');
    expect(canonicalForm(h)).toBe('<h3>t <strong>x</strong></h3>');
    // kept: an empty element with attributes (an anchor), an empty q (quotation marks), an empty code box
    expect(canonicalForm(sanitizeToFragment('<p>a<a id="x"></a><q></q><code></code></p>'))).toBe('<p>a<a id="x"></a><q></q><code></code></p>');
  });

  it('canonical form keeps raw inline HTML attributes, ignores data-l and app classes', () => {
    const f = sanitizeToFragment('<p data-l="3" class="md-x is-focus">a <abbr title="t" class="k">b</abbr></p>');
    expect(canonicalForm(f)).toBe('<p>a <abbr class="k" title="t">b</abbr></p>');
  });
});

describe('fix-gate: switch and cost', () => {
  it('the gate is on in this build', () => {
    expect(FIDELITY_GATE).toBe(true);
  });

  it('FIDELITY_GATE = false returns true before anything is read or rendered', () => {
    // The flag is a constant (switched in the source), so this checks the guard where it stands: the first
    // statement of baselineFaithful, before the counters, the block and the renderer are touched.
    const src = readFileSync(resolve(__dirname, '../src/preview/fidelity.ts'), 'utf8');
    expect(src).toMatch(/^export const FIDELITY_GATE = (true|false);$/m);
    const body = /export function baselineFaithful\([^)]*\): boolean \{\n([^\n]*)\n/.exec(src);
    expect(body?.[1].trim()).toBe('if (!FIDELITY_GATE) return true;');
  });

  it('cost in jsdom (info; Chromium numbers come from bench/verify/fix2-g-walk.mjs)', () => {
    const list = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 项 **粗** 与 [链接](https://e.example/${i}) 文字`).join('\n');
    const para = ('这是一段很长的中文文字，含 **粗体** 与 `code` 以及 [链接](https://example.com)。').repeat(1200).slice(0, 60000);
    const table = ['| a | b | c |', '|:--|:-:|--:|', ...Array.from({ length: 20 }, (_, i) => `| ${i} | **${i}** | \`${i}\` |`)].join('\n');
    const out: string[] = [];
    const rawEdges = Array.from({ length: 2500 }, (_, i) => `<b> x${i} </b>`).join('').slice(0, 60000);   // every run hoists two spaces
    for (const [name, kind, src] of [['list300', BlockKind.List, list], ['para60k', BlockKind.Prose, para], ['table20', BlockKind.Table, table], ['rawEdges', BlockKind.Prose, rawEdges]] as const) {
      const w = mount(src);
      baselineFaithful(w, kind, src);
      const t0 = performance.now();
      const ok = baselineFaithful(w, kind, src);
      out.push(`${name} ${src.length} chars: ${(performance.now() - t0).toFixed(1)} ms`);
      expect(ok, name).toBe(true);
      w.remove();
    }
    process.stdout.write('[fix-gate cost, jsdom] ' + out.join('; ') + '\n');
  });
});

afterAll(() => { document.body.replaceChildren(); });
