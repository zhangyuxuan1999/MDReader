// @vitest-environment jsdom
// verify-fidelity (0.2.0 stage 2a) — repro tests for the findings FID-1 … FID-8. Every case builds the
// DOM an edit session shows (rendered from a source like the preview mounts it, then edited the way
// Chromium edits it: bench/verify/v2-fid-reach.mjs observed these DOMs with real typing), serializes it
// with the hints a session passes ({ editing: true, ...sourceStyleHints(source) }), renders the result
// again and compares what the user sees. Each case FAILS today; it defines "fixed".
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { normalizeHtml, serializeBlock, sourceStyleHints } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});
const render = (src: string): string => mdk.renderBlock(src, { references: {} }).html;
function mountHtml(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
function visible(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const m of Array.from(c.querySelectorAll('.md-math'))) {
    const err = m.querySelector('[title^="ParseError"]');
    const ann = m.querySelector('annotation');
    m.replaceWith(c.ownerDocument.createTextNode(err ? '[MATH ERROR]' : `[math:${ann?.textContent ?? m.textContent}]`));
  }
  for (const e of Array.from(c.querySelectorAll('*'))) for (const a of Array.from(e.attributes)) if (!['href', 'src', 'start'].includes(a.name)) e.removeAttribute(a.name);
  return normalizeHtml(c.innerHTML.replace(/ |&nbsp;/g, ' ')).replace(/ +/g, ' ').replace(/ <\//g, '</').replace(/<(p|li|h\d)> /g, '<$1>').replace(/<(\/?)del>/g, '<$1s>');
}
const lastText = (root: Element): Text => {
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.trim() && !(n as Text).parentElement?.closest('.md-math')) last = n as Text;
  return last!;
};
const typeAtEnd = (s: string) => (w: Element): void => { const t = lastText(w); t.data = t.data.replace(/\s*$/, '') + s; };
const firstTextWith = (root: Element, needle: string): Text => {
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(needle)) return n as Text;
  throw new Error(`no text node with ${needle}`);
};

/** A session on `src`: mount, apply `edit` to the live DOM, serialize, re-render. */
function session(src: string, edit: (w: HTMLElement) => void): { md: string; shown: string; again: string } {
  const w = mountHtml(render(src));
  const hints = { editing: true, ...sourceStyleHints(src) };
  edit(w);
  const md = serializeBlock(w, kindOf(src), hints);
  return { md, shown: visible(w), again: visible(mountHtml(render(md))) };
}
function expectSame(r: { md: string; shown: string; again: string }): void {
  expect({ md: r.md, rendered: r.again }).toEqual({ md: r.md, rendered: r.shown });
}

describe('FID-1 a bare URL / e-mail is written after a character that breaks linkify or the emphasis before it', () => {
  it('FID-1a http autolink after an ASCII letter (版本v2<https://…>): link lost', () => expectSame(session('版本v2<https://example.com/a> 说明', typeAtEnd('x'))));
  it('FID-1b e-mail autolink after an ASCII letter (编号A<a@…>): link lost / other address', () => expectSame(session('编号A<a@example.com> 说明', typeAtEnd('x'))));
  it('FID-1c e-mail autolink after CJK, space after (请联系<support@…> 获取): link lost', () => expectSame(session('请联系<support@example.com> 获取帮助', typeAtEnd('x'))));
  it('FID-1d autolink right after **…！** (bold ending in punctuation): bold lost, ** shown', () => expectSame(session('**注意！**<https://example.com/x> 详见', typeAtEnd('x'))));
  it('FID-1e autolink after a digit in a table cell: link lost', () => expectSame(session('| a | b |\n|---|---|\n| 42<https://example.com/q> | c |', typeAtEnd('x'))));
});

describe('FID-2 linkifyEndsAfter answers "ends here" for ( { " after a URL with a path: the link swallows the text', () => {
  it('FID-2a <https://example.com/docs>(英文)', () => expectSame(session('文档 <https://example.com/docs>(英文) 可参考', typeAtEnd('x'))));
  it('FID-2b <https://example.com/a>"引号"', () => expectSame(session('见 <https://example.com/a>"引号" 说明', typeAtEnd('x'))));
  it('FID-2c <https://example.com/a>{b}', () => expectSame(session('见 <https://example.com/a>{b} 说明', typeAtEnd('x'))));
});

describe('FID-3 a link whose text equals its percent-encoded URL is written bare: the shown link text is decoded', () => {
  it('FID-3a [https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87](same)', () => expectSame(session('[https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87](https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87) 词条', typeAtEnd('x'))));
  it('FID-3b [https://x.example/a%20b](same)', () => expectSame(session('[https://x.example/a%20b](https://x.example/a%20b) 说明', typeAtEnd('x'))));
  it('FID-3c a bare IDN URL is rewritten as [text](punycode href) the user never typed', () => {
    const r = session('https://例子.测试/路径 说明', typeAtEnd('x'));
    expect(r.md).toBe('https://例子.测试/路径 说明x');
  });
});

describe('FID-4 a typed line of dashes with inner spaces is not escaped: it becomes a thematic break', () => {
  const setText = (needle: string, to: string) => (w: Element): void => { const t = firstTextWith(w, needle); t.data = t.data.replace(needle, to); };
  it('FID-4a paragraph replaced by "-- -"', () => expectSame(session('原来的文字', setText('原来的文字', '-- -'))));
  it('FID-4b list item replaced by "--- ---"', () => expectSame(session('- 第一项\n- 第二项', setText('第二项', '--- ---'))));
  it('FID-4c quote paragraph "-- -"', () => expectSame(session('> 引用', setText('引用', '-- -'))));
  it('FID-4d second line of a soft-wrapped paragraph "- - -" is escaped but "-- -" is not', () => expectSame(session('第一行\n第二行', setText('第二行', '-- -'))));
});

describe('FID-5 a heading ending in " #" plus a trailing NBSP (Chromium: typing " # " at the end) loses the "#"', () => {
  it('FID-5a "Learn C #\\u00a0" (observed in Chromium)', () => expectSame(session('## Learn C', typeAtEnd(' # '))));
  it('FID-5b "foo \\u00a0#" (NBSP between the space and #)', () => expectSame(session('## foo', typeAtEnd('  #'))));
});

describe('FID-6 a paragraph that is only &nbsp; (a spacer) is deleted when another part of its block is edited', () => {
  it('FID-6a quote with a &nbsp; spacer paragraph', () => {
    const r = session('> 第一段\n>\n> &nbsp;\n>\n> 第三段', (w) => { const t = firstTextWith(w, '第一段'); t.data += 'x'; });
    expect(r.md).toContain('&nbsp;');
    expectSame(r);
  });
  it('FID-6b tight heading with a &nbsp; line under it', () => {
    const r = session('## 标题\n&nbsp;', (w) => { const t = firstTextWith(w, '标题'); t.data += 'x'; });
    expect(r.md).toContain('&nbsp;');
    expectSame(r);
  });
});

describe('FID-7 an inline formula directly followed by a digit is written as $x$1: the formula no longer closes', () => {
  it('FID-7a "$x$ 1 个" with the space deleted', () => expectSame(session('公式 $x$ 1 个与 $y$ 结尾', (w) => { const t = firstTextWith(w, ' 1 个'); t.data = t.data.replace(' 1 个', '1 个'); })));
});

describe('FID-8 adjacent formatting of different kinds is written as raw HTML (<del>/<strong>) the user did not type', () => {
  it('FID-8a **粗体**~~删除~~ stays Markdown', () => {
    const r = session('**粗体**~~删除~~ 文本', typeAtEnd('x'));
    expect(r.md).not.toMatch(/<\/?(del|strong|em)>/);
  });
  it('FID-8b ~~删除~~**粗体** stays Markdown', () => {
    const r = session('~~删除~~**粗体** 文本', typeAtEnd('x'));
    expect(r.md).not.toMatch(/<\/?(del|strong|em)>/);
  });
});

describe('FID-9 private-use characters U+E000 / U+E002 in the document are taken for the serializer\'s own markers', () => {
  it('FID-9a U+E000 in a paragraph becomes a line break (the character is lost)', () => {
    const r = session('图标\uE000文字与说明', typeAtEnd('x'));
    expect(r.md).toBe('图标\uE000文字与说明x');
  });
  it('FID-9b U+E002 in a table cell splits the cell (a third column appears)', () => {
    const r = session('| 名 | 图\uE002标 |\n|---|---|\n| 1 | 2 |', typeAtEnd('x'));
    expect(r.md).toContain('图\uE002标');
    expectSame(r);
  });
});

describe('FID-10 a formula with an escaped pipe in a table cell is written back without the escape: the row splits', () => {
  it('FID-10a | 绝对值 | $\\|x\\|$ | — edit the first cell', () => {
    const r = session('| 名称 | 公式 |\n|---|---|\n| 绝对值 | $\\|x\\|$ |', (w) => { const t = firstTextWith(w, '绝对值'); t.data += 'x'; });
    expect(r.md).toContain('$\\|x\\|$');
    expectSame(r);
  });
  it('FID-10b | P | $P(A\\|B)$ | — conditional probability', () => {
    const r = session('| 记号 | 含义 |\n|---|---|\n| $P(A\\|B)$ | 条件概率 |', (w) => { const t = firstTextWith(w, '条件概率'); t.data += 'x'; });
    expectSame(r);
  });
});

describe('controls (pass today: the harness itself is sound)', () => {
  it('autolink after a space, space after', () => expectSame(session('普通 <https://example.com/a> 说明', typeAtEnd('x'))));
  it('heading with " #" typed without a trailing NBSP', () => expectSame(session('## Learn C', typeAtEnd(' #'))));
  it('"---" alone is escaped', () => expectSame(session('原来', (w) => { const t = firstTextWith(w, '原来'); t.data = '---'; })));
  it('formula followed by a space and a digit', () => expectSame(session('公式 $x$ 1 个与 $y$ 结尾', typeAtEnd('x'))));
});
