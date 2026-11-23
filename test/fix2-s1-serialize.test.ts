// @vitest-environment jsdom
// test/fix2-s1-serialize.test.ts — fix-serial-1 (0.2.0 stage 2b) regression tests for the serializer:
// G4 private-use characters vs the internal markers, G3 formulas in table cells, G9 &nbsp;-only lines,
// G8 emptied first nested item, G5 line breaks at formatting edges / in inline code, G1 (U10 c, e).
// Pipeline as in test/v2-fid-repro.test.ts: render with the worker's markdown-it, mount like createPreview,
// edit the DOM like Chromium, serialize with the session's hints, render again and compare.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, normalizeHtml, serializeBlock, serializeBlockWithCaret, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});
const render = (src: string): string => mdk.renderBlock(src, { references: {} }).html;
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
const shown = (el: Element): string => normalizeHtml(el.innerHTML.replace(/ data-mdr-o=""/g, '').replace(/ contenteditable="false"/g, ''));
function textWith(root: Element, needle: string): Text {
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(needle)) return n as Text;
  throw new Error(`no text node with ${needle}`);
}
/** Session on `src`: mount, edit, serialize; `again` is the rendering of the result, `live` the session DOM. */
function session(src: string, edit: (w: HTMLElement) => void): { md: string; live: string; again: string } {
  const w = mount(render(src));
  const hints = { editing: true, ...sourceStyleHints(src) };
  edit(w);
  const md = serializeBlock(w, kindOf(src), hints);
  return { md, live: shown(w), again: shown(mount(render(md))) };
}
const append = (needle: string, s: string) => (w: HTMLElement): void => { const t = textWith(w, needle); t.data = t.data.replace(needle, needle + s); };

describe('G4: document characters that look like the internal markers survive byte for byte', () => {
  const pua = ['\uE000', '\uE001', '\uE002', '\uE003', '\uE004', '\uF8FF', '\u{F0000}', '\u{10FFFD}', '\uFDD0'];
  for (const ch of pua) {
    const cp = 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase();
    it(`${cp} in a paragraph`, () => {
      const r = session(`图标${ch}文字与说明`, append('说明', 'x'));
      expect(r.md).toBe(`图标${ch}文字与说明x`);
    });
    it(`${cp} in a table cell, inline code and a link`, () => {
      const src = `| 名 | 图${ch}标 |\n|---|---|\n| \`c${ch}d\` | [t${ch}](https://e.example/${ch}) |`;
      const r = session(src, append('名', 'x'));
      expect(r.md).toBe(src.replace('| 名 |', '| 名x |'));
      expect(r.again).toBe(r.live);
    });
  }
  it('all four default markers in one block, with soft breaks, a heading and a table', () => {
    const src = '## a\uE000b\uE001\n\uE002 c\uE003\nd *e\uE000* \uE003';
    const r = session(src, append('d ', 'x'));
    expect(r.md).toBe('## a\uE000b\uE001\n\uE002 c\uE003\nd x*e\uE000* \uE003');
  });
  it('a soft line break next to a document U+E000 stays a line break', () => {
    const r = session('a\uE000\nb', append('b', 'x'));
    expect(r.md).toBe('a\uE000\nbx');
  });
  it('serializeBlockWithCaret: CARET_MARK marks only the caret, on the right line', () => {
    const w = mount(render('one \uE001 two\nthree \uE001\nfour'));
    const t = textWith(w, 'four');
    const marked = serializeBlockWithCaret(w, BlockKind.Prose, t, t.data.indexOf('four') + 2, { editing: true })!;
    expect(marked.split(CARET_MARK).length).toBe(2);
    const at = marked.indexOf(CARET_MARK);
    expect(marked.slice(0, at).split('\n').length - 1).toBe(2);
    expect(marked).toBe('one \uFFFD two\nthree \uFFFD\nfo' + CARET_MARK + 'ur');
    expect(serializeBlock(w, BlockKind.Prose, { editing: true })).toBe('one \uE001 two\nthree \uE001\nfour');
  });
  it('serializeBlockWithCaret without document markers is unchanged', () => {
    const w = mount(render('alpha\nbeta'));
    const t = textWith(w, 'beta');
    const marked = serializeBlockWithCaret(w, BlockKind.Prose, t, t.data.indexOf('beta') + 1, { editing: true })!;
    expect(marked).toBe('alpha\nb' + CARET_MARK + 'eta');
  });
  it('a list item with U+E001 (item-wise path) keeps it, and the caret of serializeBlockWithCaret is unique', () => {
    const src = Array.from({ length: 9 }, (_, i) => `- item ${i}\uE001`).join('\n');
    const w = mount(render(src));
    expect(serializeBlock(w, BlockKind.List, { editing: true })).toBe(src);
    const t4 = textWith(w, 'item 4');
    const marked = serializeBlockWithCaret(w, BlockKind.List, t4, t4.data.indexOf('item 4') + 3, { editing: true })!;
    expect(marked.split(CARET_MARK).length).toBe(2);
    expect(marked.slice(0, marked.indexOf(CARET_MARK)).split('\n').length - 1).toBe(4);
  });
});

describe('G3: formulas in table cells keep the pipe escapes they need', () => {
  const cases: Array<[string, string]> = [
    ['| 名称 | 公式 |\n|---|---|\n| 绝对值 | $\\|x\\|$ |', '绝对值'],
    ['| 记号 | 含义 |\n|---|---|\n| $P(A\\|B)$ | 条件概率 |', '条件概率'],
    ['| 范数 | 写法 |\n|---|---|\n| 双竖线 | $\\\\|x\\\\|$ |', '双竖线'],
    ['| a | b |\n|---|---|\n| 显示 | $$\\{x \\| x>0\\}$$ |', '显示'],
    ['| $\\|a\\|$ | $\\|b\\|$ |\n|---|---|\n| 1 | 2 |', '1'],
  ];
  for (const [src, needle] of cases) {
    it(JSON.stringify(src), () => {
      const r = session(src, append(needle, 'x'));
      expect(r.md).toBe(src.replace(needle, needle + 'x'));
      expect(r.again).toBe(r.live);
    });
  }
  it('formulas outside tables are unchanged', () => {
    for (const src of ['绝对值 $|x|$ 与 $P(A|B)$', '- 列表 $|x|$', '> 引用 $$|y|$$']) {
      const needle = src.includes('绝对值') ? '绝对值' : src.includes('列表') ? '列表' : '引用';
      const r = session(src, append(needle, 'x'));
      expect(r.md).toBe(src.replace(needle, needle + 'x'));
    }
  });
});

describe('G9: a line, paragraph or cell that is only &nbsp; keeps it', () => {
  const cases: Array<[string, string]> = [
    ['> 第一段\n>\n> &nbsp;\n>\n> 第三段', '第一段'],
    ['## 标题\n&nbsp;', '标题'],
    ['- 项目一\n- &nbsp;\n- 项目三', '项目一'],
    ['| a | b |\n|---|---|\n| &nbsp; | 2 |', '2'],
    ['第一行\n&nbsp;\n第三行', '第一行'],
    ['> 甲\n>\n> &nbsp;&nbsp;', '甲'],
  ];
  for (const [src, needle] of cases) {
    it(JSON.stringify(src), () => {
      const r = session(src, append(needle, 'x'));
      expect(r.md).toBe(src.replace(needle, needle + 'x'));
      expect(r.again).toBe(r.live);
    });
  }
  it('a typed space at a line end is still dropped (no &nbsp; in a source that had none)', () => {
    const r = session('abc', append('abc', '\u00a0'));
    expect(r.md).toBe('abc');
  });
});

/** Nesting + texts + line breaks + checkboxes, the way a reader sees a list. */
function shape(el: Element): string {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return (n as Text).data.replace(/\s+/g, '');
    if (n.nodeType !== 1) return '';
    const e = n as Element;
    const inner = Array.from(e.childNodes).map(walk).join('');
    if (/^(UL|OL)$/.test(e.tagName)) return `${e.tagName}[${inner}]`;
    if (e.tagName === 'LI') return `(${inner})`;
    if (/^H[1-6]$/.test(e.tagName)) return `${e.tagName}{${inner}}`;
    if (e.tagName === 'BR') return '⏎';
    if (e.tagName === 'INPUT') return (e as HTMLInputElement).checked ? '☑' : '☐';
    return inner;
  };
  return walk(el);
}
/** Empties the item whose own text is `item` the way Chromium does (text gone; `<br>`, or NBSP after a checkbox). */
function emptyItem(src: string, item: string): { md: string; live: string; again: string } {
  const w = mount(render(src));
  const li = Array.from(w.querySelectorAll('li')).find((l) => Array.from(l.childNodes).some((c) => c.nodeType === 3 && (c as Text).data.trim() === item))!;
  const t = Array.from(li.childNodes).find((c) => c.nodeType === 3 && (c as Text).data.trim() === item) as Text;
  if (li.querySelector('input')) t.data = '\u00a0';
  else { t.remove(); li.insertBefore(document.createElement('br'), li.firstChild); }
  const live = shape(w);
  const md = serializeBlock(w, BlockKind.List, { ...sourceStyleHints(src), editing: true });
  return { md, live, again: shape(mount(render(md))) };
}

describe('G8 + check item: an emptied item stays an item of the same list', () => {
  const cases: Array<[string, string, string]> = [
    ['- on\n  - x\n  - o', 'x', '- on\n  - <br>\n  - o'],
    ['1. on\n   1. x\n   2. o', 'x', '1. on\n   1. <br>\n   2. o'],
    ['- on\n  - x', 'x', '- on\n  - <br>'],
    ['- [ ] on\n  - x\n  - o', 'x', '- [ ] on\n  - <br>\n  - o'],
    ['- x\n- o', 'x', '- <br>\n- o'],                 // the line above the block may be paragraph text
    ['1. x\n2. o', 'x', '1. <br>\n2. o'],
    ['- a\n- x\n- o', 'x', '- a\n-\n- o'],            // a later item: a bare marker is an item
    ['- on\n  - a\n  - x', 'x', '- on\n  - a\n  -'],
    ['- on\n\n  - x\n  - o', 'x', '- on\n\n  -\n  - o'],  // loose: a blank line above the marker
    ['- [x] done\n- [ ] todo', 'done', '- [x] &nbsp;\n- [ ] todo'],   // task without text keeps its checkbox
    ['- [ ] a\n- [x] done', 'done', '- [ ] a\n- [x] &nbsp;'],
    ['- on\n  - [ ] x\n  - [ ] o', 'x', '- on\n  - [ ] &nbsp;\n  - [ ] o'],
  ];
  for (const [src, item, want] of cases) {
    it(JSON.stringify(src), () => {
      const r = emptyItem(src, item);
      expect(r.md).toBe(want);
      expect(r.again.replace(/⏎/g, '')).toBe(r.live.replace(/⏎/g, ''));
    });
  }
  it('the paragraph above the block stays a paragraph (whole document)', () => {
    const r = emptyItem('- x\n- o', 'x');
    expect(render('Items:\n' + r.md)).not.toMatch(/<h2/);
    expect(render('Items:\n1. <br>\n2. o')).toMatch(/<ol/);
  });
  it('the result is stable: serializing the rendered result again gives the same Markdown', () => {
    for (const md of ['- on\n  - <br>\n  - o', '- <br>\n- o', '- [x] &nbsp;\n- [ ] todo']) {
      expect(serializeBlock(mount(render(md)), BlockKind.List, { ...sourceStyleHints(md), editing: true })).toBe(md);
    }
  });
  it('an empty first item written in the source ("-", no browser placeholder) is serialized as it is', () => {
    for (const md of ['-\n- o', '1.\n2. o', '- a\n-\n- o']) {
      expect(serializeBlock(mount(render(md)), BlockKind.List, { ...sourceStyleHints(md), editing: true })).toBe(md);
    }
  });
  it('a list whose items are all empty is still empty (the block deletion, U9)', () => {
    const r = emptyItem('- x', 'x');
    expect(r.md).toBe('');
    const w = mount(render('- x\n- y'));
    for (const li of Array.from(w.querySelectorAll('li'))) li.replaceChildren(document.createElement('br'));
    expect(serializeBlock(w, BlockKind.List, { editing: true })).toBe('');
    expect(serializeBlock(w, BlockKind.List, { editing: true, uncached: true })).toBe('');
  });
  it('item-wise cache: the first item and a later one are not confused when items move', () => {
    const src = Array.from({ length: 9 }, (_, i) => `- item ${i}`).join('\n');
    const w = mount(render(src));
    const lis = Array.from(w.querySelectorAll('li'));
    lis[1].replaceChildren(document.createElement('br'));
    expect(serializeBlock(w, BlockKind.List, { editing: true })).toBe(src.replace('- item 1', '-'));
    lis[0].remove();                                       // the emptied item is now the first
    const a = serializeBlock(w, BlockKind.List, { editing: true });
    expect(a.split('\n')[0]).toBe('- <br>');
    expect(a).toBe(serializeBlock(w, BlockKind.List, { editing: true, uncached: true }));
  });
});

describe('G5: a line break at the edge of formatting, or in inline code', () => {
  const br = (): HTMLBRElement => document.createElement('br');
  /** What the reader sees: the text with its line breaks, and the text of every formatted run. */
  const seen = (html: string): string => {
    const t = document.createElement('template');
    t.innerHTML = html;
    let text = '';
    const runs: string[] = [];
    const walk = (n: Node, fmt: string): void => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3) { text += (c as Text).data.replace(/\s+/g, ' '); if (fmt && (c as Text).data.trim()) runs.push(`${fmt}:${(c as Text).data.trim()}`); }
        else if (c.nodeType === 1 && (c as Element).tagName === 'BR') text += '⏎';
        else if (c.nodeType === 1) walk(c, /^(STRONG|EM|DEL|S|CODE|A)$/.test((c as Element).tagName) ? `${fmt}>${(c as Element).tagName}` : fmt);
      }
    };
    walk(t.content, '');
    return text.replace(/ ?⏎ ?/g, '⏎').trim() + ' | ' + runs.join(',');
  };
  /** Puts a <br> into the first `tag` element: at its start, its end, or after the n-th character. */
  const breakIn = (tag: string, where: 'start' | 'end' | number) => (w: HTMLElement): void => {
    const e = w.querySelector(tag)!;
    if (where === 'start') e.insertBefore(br(), e.firstChild);
    else if (where === 'end') e.appendChild(br());
    else { const t = e.firstChild as Text; const rest = t.splitText(where); e.insertBefore(br(), rest); }
  };
  const cases: Array<[string, string, (w: HTMLElement) => void, string]> = [
    ['bold, end', 'abc **x**y def', breakIn('strong', 'end'), 'abc **x**  \ny def'],
    ['italic, end', 'abc *x*y def', breakIn('em', 'end'), 'abc *x*  \ny def'],
    ['strike, end', 'abc ~~x~~y def', breakIn('s', 'end'), 'abc ~~x~~  \ny def'],
    ['link, end', 'a [link](https://e.com)y z', breakIn('a', 'end'), 'a [link](https://e.com)  \ny z'],
    ['bold, start of paragraph', '**Note** text', breakIn('strong', 'start'), '\\\n**Note** text'],
    ['italic, start of paragraph', '*Note* text', breakIn('em', 'start'), '\\\n*Note* text'],
    ['bold, start mid-line', 'a **b** c', breakIn('strong', 'start'), 'a  \n**b** c'],
    ['nested ** and *, end', 'a ***x***y', breakIn('em', 'end'), 'a ***x***  \ny'],
    ['bold that only holds the break', 'a **x** b', (w) => { const s = w.querySelector('strong')!; s.replaceChildren(br()); }, 'a  \nb'],
    ['code, end', 'abc `x`y def', breakIn('code', 'end'), 'abc `x`  \ny def'],
    ['code, middle', 'a `code` z', breakIn('code', 2), 'a `co`  \n`de` z'],
    ['code, start', 'a `code` z', breakIn('code', 'start'), 'a  \n`code` z'],
    ['bold code, end', 'a **`c`** z', breakIn('code', 'end'), 'a **`c`**  \nz'],
    ['list item start', '- item one', (w) => { const li = w.querySelector('li')!; li.insertBefore(br(), li.firstChild); }, '- \\\n  item one'],
    ['two breaks in a row', 'a b', (w) => { const t = textWith(w, 'a b'); const rest = t.splitText(1); t.after(br(), br()); rest.data = rest.data.trimStart(); }, 'a  \n\\\nb'],
  ];
  for (const [name, src, edit, want] of cases) {
    it(name, () => {
      const r = session(src, edit);
      expect(r.md).toBe(want);
      expect(r.md).not.toMatch(/<\/?(strong|em|del|code|a)[\s>]/);
      expect(seen(r.again)).toBe(seen(r.live));
    });
  }
});

describe('G1 (U10 c, e): the serializer does not take document attributes for its own', () => {
  it('a wrapper with data-mdr-x is refused', () => {
    const w = mount(render('plain text'));
    expect(unsupportedReason(w, 'plain text')).toBeNull();
    w.setAttribute('data-mdr-x', '');
    expect(unsupportedReason(w, 'plain text')).toBe('reserved');
  });
  it('a raw <a> whose href / title holds line breaks stays on its line and renders the same', () => {
    for (const src of [
      'See <a href="https://ok.example/&#10;&#10;# Injected">the site</a> now',
      'See <a href="https://ok.example/" title="t&#10;&#10;# Injected">the site</a> now',
      'See <img src="https://ok.example/a&#10;b.png" alt="x"> now',
    ]) {
      const r = session(src, append('now', '!'));
      expect(r.md.split('\n').length).toBe(1);
      expect(r.again).toBe(r.live);
    }
  });
  it('a Markdown link title with a line break keeps the Markdown form and renders the same', () => {
    const src = '[a](https://e.example "line one\nline two") tail';
    const r = session(src, append('tail', 'x'));
    expect(r.md).toBe('[a](https://e.example "line one&#10;line two") tailx');
    expect(r.again).toBe(r.live);
  });
  it('a raw attribute value with a line break is written as a character reference', () => {
    const src = 'Text <abbr title="a\n\n# b">x</abbr> end';
    const w = mount(render(src));
    expect(w.querySelector('abbr')).toBeNull();            // a blank line ends the paragraph: no element
    const one = 'Text <abbr title="a&#10;&#10;# b">x</abbr> end';
    const r = session(one, append('end', '!'));
    expect(r.md).toBe('Text <abbr title="a&#10;&#10;# b">x</abbr> end!');
  });
  it('a data-md / data-md-block / data-mdr-task attribute already in the DOM is not honoured', () => {
    const w = document.createElement('section');
    w.innerHTML = '<p>Hi <span data-md="[x](https://evil.example)">there</span> <span data-md="# H" data-md-block="">you</span></p>'
      + '<ul><li data-mdr-task="x] [evil](https://evil.example)">item</li></ul>';
    const md = serializeBlock(w, BlockKind.Prose, { editing: true });
    expect(md).not.toContain('evil');
    expect(md).not.toMatch(/^# H/m);
    expect(md).toContain('there');
    expect(md).toContain('you');
    expect(md).toContain('- item');
  });
  it('a code language with a line break never leaves the fence line', () => {
    const w = document.createElement('section');
    w.innerHTML = '<pre class="md-code" data-lang="js\n\n# Injected"><code>x\n</code></pre>';
    expect(unsupportedReason(w)).toBe('lang');
    const md = serializeBlock(w, BlockKind.Code, {});
    expect(md).toBe('```js\nx\n```');
    w.querySelector('pre')!.setAttribute('data-lang', 'a`b');
    expect(unsupportedReason(w)).toBeNull();               // a backtick: written with a ~~~ fence
    expect(serializeBlock(w, BlockKind.Code, {})).toBe('~~~a`b\nx\n~~~');
  });
  it('an element with class md-math that is not a rendered formula stays HTML; real formulas are formulas', () => {
    const r = session('Price <span class="md-math md-math--inline">E</span> today', append('today', '!'));
    expect(r.md).toBe('Price <span class="md-math md-math--inline">E</span> today!');
    const f = session('Price $E=mc^2$ and $$x$$ today', append('today', '!'));
    expect(f.md).toBe('Price $E=mc^2$ and $$x$$ today!');
  });
});
