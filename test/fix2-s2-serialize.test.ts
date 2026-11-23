// @vitest-environment jsdom
// fix-serial-2 (0.2.0 stage 2b): regression tests for the serializer items G2 (U11: the spelling of a link whose
// text is its URL), G6 (linear time), G18 (dash lines), G19 (heading ending in " #" + NBSP), G20 (formula followed
// by a digit), G21 (adjacent formatting of different kinds) and the check items. The oracle is the project's own
// markdown-it (src/worker/md.ts with the math rules on): a block is rendered, mounted like the preview mounts it,
// serialized with the hints a session passes, rendered again, and what the user sees must be the same.
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
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
/** What the user sees: elements, text, href / src / start; formulas as their TeX. */
function visible(el: Element): string {
  const c = el.cloneNode(true) as Element;
  for (const m of Array.from(c.querySelectorAll('.md-math'))) {
    const err = m.querySelector('[title^="ParseError"], .katex-error');
    const ann = m.querySelector('annotation');
    m.replaceWith(c.ownerDocument.createTextNode(err ? '[MATH ERROR]' : `[math:${ann?.textContent ?? m.textContent}]`));
  }
  // whitespace at the inside edge of an inline element renders like whitespace just outside it (turndown moves it)
  for (const e of Array.from(c.querySelectorAll('strong, em, s, del, a, kbd'))) {
    const f = e.firstChild, l = e.lastChild;
    if (f && f.nodeType === 3 && /^[ \u00a0]/.test((f as Text).data)) { (f as Text).data = (f as Text).data.replace(/^[ \u00a0]+/, ''); e.before(' '); }
    if (l && l.nodeType === 3 && /[ \u00a0]$/.test((l as Text).data)) { (l as Text).data = (l as Text).data.replace(/[ \u00a0]+$/, ''); e.after(' '); }
  }
  for (const e of Array.from(c.querySelectorAll('*'))) for (const a of Array.from(e.attributes)) if (!['href', 'src', 'start'].includes(a.name)) e.removeAttribute(a.name);
  return normalizeHtml(c.innerHTML.replace(/\u00a0|&nbsp;/g, ' ')).replace(/ +/g, ' ').replace(/<br><\/br> /g, '<br></br>').replace(/ <\//g, '</').replace(/<(p|li|h\d|td|th)> /g, '<$1>').replace(/<(\/?)del>/g, '<$1s>');
}
const lastText = (root: Element): Text => {
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.trim() && !(n as Text).parentElement?.closest('.md-math, a')) last = n as Text;
  return last!;
};
/** A session on `src`: mount, edit the live DOM, serialize with the session's hints, render again. */
function session(src: string, edit?: (w: HTMLElement) => void, styled = true): { md: string; shown: string; again: string } {
  const w = mount(render(src));
  edit?.(w);
  const md = serializeBlock(w, kindOf(src), styled ? { editing: true, ...sourceStyleHints(src) } : { editing: true });
  return { md, shown: visible(w), again: visible(mount(render(md))) };
}
const typeAtEnd = (s: string) => (w: Element): void => { const t = lastText(w); if (t) t.data = t.data.replace(/\s*$/, '') + s; };

// ------------------------------------------------------------------------------------------------ G2 / U11
describe('G2 (U11): a link whose text is its URL renders the same link after an edit, in every context', () => {
  const URLS = [
    'https://example.com', 'https://example.com/', 'http://e.com/x_y_z', 'https://e.com/a?b=1&c=2', 'https://e.com/a(b)',
    'https://例子.测试/路径', 'ftp://ftp.example.org/f.txt', 'https://e.com/~u/*x*', 'HTTPS://E.COM/A', 'https://e.com/%E4%B8%AD',
  ];
  const MAILS = ['a@example.com', 'first.last+tag@sub.example.org', 'x_y@e.cn'];
  const BEFORE = ['', ' ', 'word', 'v2', '中文', '中文，', '见：', '(', '"', '**粗体！**', '**bold**', '*em*', '`c`', 'x.', 'x-', '[x](y)', '\\*', '<', '&', 'a\\\\', '$'];
  const AFTER = ['', ' tail', '后', '，后', '。', '.', '. x', ')', '(英文)', '"q"', '{b}', '[b]', ' <https://f.com>', '<https://f.com>', '**b**', '*e*', '!', '?x', ':x', '/x', '-x', '_x', '~x', '*', '>', '> x', '](y)', '`'];
  const LINKS = [...URLS, ...MAILS];
  const forms = (u: string): string[] => [`<${u}>`, `[${u}](${u})`];
  /** Serializes `src` as a session does (typing at the end; also without the source hints) and reports any
   *  difference in what the user sees. */
  function check(src: string, bad: string[]): void {
    const before = visible(mount(render(src)));
    const p = session(src, undefined, false);
    if (p.again !== before) bad.push(`${JSON.stringify(src)} plain\n   md ${JSON.stringify(p.md)}\n   was ${before}\n   now ${p.again}`);
    const t = session(src, typeAtEnd('x'));
    if (t.again !== t.shown) bad.push(`${JSON.stringify(src)} +x\n   md ${JSON.stringify(t.md)}\n   was ${t.shown}\n   now ${t.again}`);
  }
  // Every link form × every character before × every text after, in a paragraph and in nine other containers
  // (bold, italics, strikethrough, a table cell, a heading, a list item, a quote, a second line, bold italics):
  // 152 880 sources. By default a deterministic sample (every 37th: about 2 900); MDR_FULL_FUZZ=1 runs all (one container at a time: -t '<name>:'; ~1.5 min each).
  const CONTAINERS: Array<[string, (s: string) => string]> = [
    ['paragraph', (s) => s],
    ['table cell', (s) => `| h | i |\n|---|---|\n| ${s.replace(/\|/g, '\\|')} | z |`],
    ['heading', (s) => `## ${s}`], ['list item', (s) => `- ${s}`], ['quote', (s) => `> ${s}`],
    ['inside bold', (s) => `**${s}**`], ['inside em', (s) => `*${s}*`], ['inside del', (s) => `~~${s}~~`],
    ['second line', (s) => `a\n${s}`], ['nested emphasis', (s) => `***${s}***`],
  ];
  const STEP = process.env.MDR_FULL_FUZZ === '1' ? 1 : Number(process.env.MDR_G2_STEP ?? 37);
  for (const [name, wrapIn] of CONTAINERS) {
    it(`${name}: every link form × ${BEFORE.length} before × ${AFTER.length} after (1 in ${STEP})`, () => {
      const bad: string[] = [];
      let k = 0;
      for (const u of LINKS) for (const f of forms(u)) for (const b of BEFORE) for (const a of AFTER) if (k++ % STEP === 0) check(wrapIn(`${b}${f}${a}`), bad);
      expect(bad.slice(0, 12)).toEqual([]);
    }, 200_000);
  }

  it('the spellings chosen (pinned)', () => {
    const md = (src: string, styled = true): string => session(src, typeAtEnd('x'), styled).md;
    // compact forms kept where proven
    expect(md('see https://example.com/a tail')).toBe('see https://example.com/a tailx');
    expect(md('https://例子.测试/路径 说明')).toBe('https://例子.测试/路径 说明x');                 // FID-3c
    expect(md('get ftp://ftp.example.org/f.txt now')).toBe('get ftp://ftp.example.org/f.txt nowx');   // ftp stays bare
    expect(md('mail a@example.com now')).toBe('mail a@example.com nowx');
    expect(md('见 <https://example.com/a> 说明')).toBe('见 <https://example.com/a> 说明x');          // the source's <url> stays
    expect(md('wiki https://en.wikipedia.org/wiki/Foo_bar here')).toBe('wiki https://en.wikipedia.org/wiki/Foo_bar herex');
    // where bare would not read back: <url>
    expect(md('版本v2<https://example.com/a> 说明')).toBe('版本v2<https://example.com/a> 说明x');   // FID-1a
    expect(md('编号A<a@example.com> 说明')).toBe('编号A<a@example.com> 说明x');                     // FID-1b
    expect(md('请联系<support@example.com> 获取帮助')).toBe('请联系<support@example.com> 获取帮助x'); // FID-1c
    expect(md('**注意！**<https://example.com/x> 详见')).toBe('**注意！**<https://example.com/x> 详见x'); // FID-1d
    expect(md('文档 <https://example.com/docs>(英文) 可参考')).toBe('文档 <https://example.com/docs>(英文) 可参考x'); // FID-2a
    expect(md('word<https://e.com> tail')).toBe('word<https://e.com> tailx');                        // SES-2
    // where neither shows the same text: [text](destination)
    expect(md('[https://x.example/a%20b](https://x.example/a%20b) 说明')).toBe('[https://x.example/a%20b](https://x.example/a%20b) 说明x'); // FID-3b
    // the source not known (no hints): a URL holding a Markdown character prefers <url>, as before
    expect(md('<https://x.com/a_b> y', false)).toBe('<https://x.com/a_b> yx');
    expect(md('https://example.com/path and me@example.com end', false)).toBe('https://example.com/path and me@example.com endx');
  });
});

// ------------------------------------------------------------------------------------------------ G6
describe('G6: serializeBlock is linear in the block (no pass rescans a run of the same character)', () => {
  const para = (text: string): HTMLElement => { const w = document.createElement('section'); const p = document.createElement('p'); p.textContent = text; w.appendChild(p); return w; };
  const time = (el: HTMLElement): { ms: number; md: string } => { const t = performance.now(); const md = serializeBlock(el, BlockKind.Prose, { editing: true }); return { ms: performance.now() - t, md }; };
  // Each of these took seconds at this size before (a backtracking regex or a per-character rescan of the run).
  const SHAPES: Array<[string, () => HTMLElement, (md: string) => boolean]> = [
    ['60 000 spaces', () => para('a' + ' '.repeat(60000) + 'b'), (md) => md === 'a b'],
    ['60 000 tabs', () => para('a' + '\t'.repeat(60000) + 'b'), (md) => md === 'a b'],
    ['30 000 space+NBSP', () => para('a' + ' \u00a0'.repeat(30000) + 'b'), (md) => md.startsWith('a') && md.endsWith('b')],
    ['30 000 soft breaks', () => para('a' + ' \n'.repeat(30000) + 'b'), (md) => md.startsWith('a\n') && md.endsWith('\nb')],
    ['60 000 tildes', () => para('x ' + '~'.repeat(60000)), (md) => md.length >= 60002],
    ['heading with 60 000 spaces before #', () => { const w = document.createElement('section'); const h = document.createElement('h2'); h.textContent = 'a' + ' '.repeat(60000) + '#'; w.appendChild(h); return w; }, (md) => md === '## a \\#'],
    ['15 000 <br>', () => { const w = document.createElement('section'); const p = document.createElement('p'); for (let i = 0; i < 15000; i++) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode('z')); w.appendChild(p); return w; }, (md) => md.endsWith('z')],
    ['code span of 60 000 characters', () => { const w = document.createElement('section'); const p = document.createElement('p'); const c = document.createElement('code'); c.textContent = ' ' + 'a'.repeat(60000); p.appendChild(c); w.appendChild(p); return w; }, (md) => md.startsWith('` a') && md.endsWith('a`')],
    ['code block with 30 000 blank lines', () => { const w = document.createElement('section'); w.innerHTML = '<pre><code></code></pre>'; w.querySelector('code')!.textContent = 'a' + '\n'.repeat(30000) + 'b\n'; return w; }, (md) => md.startsWith('```\na\n') && md.endsWith('b\n```')],
    ['60 000 U+3000', () => para('a' + '\u3000'.repeat(60000) + 'b'), (md) => md.length === 60002],
  ];
  for (const [name, build, ok] of SHAPES) {
    it(name, () => {
      const r = time(build());
      expect(ok(r.md)).toBe(true);
      expect(r.ms).toBeLessThan(1500);
    });
  }
});

// ------------------------------------------------------------------------------------------------ G18 … G21, check item 7
const firstTextWith = (root: Element, needle: string): Text => {
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(needle)) return n as Text;
  throw new Error(`no text node with ${needle}`);
};
const setText = (needle: string, to: string) => (w: Element): void => { const t = firstTextWith(w, needle); t.data = t.data.replace(needle, to); };
const same = (r: { md: string; shown: string; again: string }): void => { expect({ md: r.md, rendered: r.again }).toEqual({ md: r.md, rendered: r.shown }); };

describe('G18: a typed line of dashes with inner spaces stays text', () => {
  for (const line of ['-- -', '--- ---', '- - -', '-  -  -', '--  -', '---- -', '-\t--']) {
    it(`paragraph ${JSON.stringify(line)}`, () => { const r = session('原来的文字', setText('原来的文字', line)); same(r); expect(r.md.startsWith('\\')).toBe(true); });
    it(`list item ${JSON.stringify(line)}`, () => same(session('- 第一项\n- 第二项', setText('第二项', line))));
    it(`quote, second line ${JSON.stringify(line)}`, () => { same(session('> 引用', setText('引用', line))); same(session('第一行\n第二行', setText('第二行', line))); });
  }
  it('the same shape with * and _ (escaped by their own rules)', () => {
    for (const line of ['** *', '* * *', '__ _', '_ _ _', '*** ***']) { same(session('原来的文字', setText('原来的文字', line))); same(session('- 第一项\n- 第二项', setText('第二项', line))); }
  });
  it('dashes that are not a thematic break are not escaped', () => {
    expect(session('原来的文字', setText('原来的文字', '-- a')).md).toBe('-- a');
    expect(session('原来的文字', setText('原来的文字', 'a -- -')).md).toBe('a -- -');
  });
});

describe('G19: a heading ending in " #" keeps its "#" next to a non-breaking space', () => {
  for (const tail of [' #\u00a0', ' \u00a0#', ' ##\u00a0', '\u00a0#', ' #\u00a0\u00a0', '\u00a0#\u00a0']) {
    it(JSON.stringify(tail), () => same(session('## Learn C', typeAtEnd(tail))));
  }
  it('a "#" glued to the text is no closing sequence and stays unescaped', () => expect(session('## Learn C', typeAtEnd('#\u00a0')).md).toBe('## Learn C#'));
});

describe('G20: an inline formula directly followed by a digit still closes', () => {
  it('"$x$ 1 个" with the space deleted', () => {
    const r = session('公式 $x$ 1 个与 $y$ 结尾', setText(' 1 个', '1 个'));
    same(r);
    expect(r.md).toBe('公式 $x$&#49; 个与 $y$ 结尾');
  });
  it('every digit, and a display formula (no rule there)', () => {
    for (let d = 0; d <= 9; d++) same(session('a $x$ b', setText(' b', `${d}b`)));
    const r = session('a $$x$$ b', setText(' b', '1b'));
    same(r);
    expect(r.md).toBe('a $$x$$1b');
  });
  it('a digit after other text is written as it is', () => expect(session('a $x$ b', setText(' b', ' 1b')).md).toBe('a $x$ 1b'));
});

describe('G21: adjacent formatting of different kinds keeps its delimiters', () => {
  for (const src of ['**粗体**~~删除~~ 文本', '~~删除~~**粗体** 文本', '*斜体*~~删除~~ 文本', '~~删除~~*斜体* 文本']) {
    it(src, () => { const r = session(src, typeAtEnd('x')); same(r); expect(r.md).not.toMatch(/<\/?(del|strong|em)>/); expect(r.md).toBe(src + 'x'); });
  }
  it('the same delimiter character keeps the safe form', () => {
    for (const src of ['**粗体***斜体* 文本', '*斜体***粗体** 文本']) same(session(src, typeAtEnd('x')));
  });
});

describe('check item 7: emphasis whose edge was edited, formatting nested in formatting of the same kind', () => {
  it('"*a * b*" with the a deleted, and with the b deleted', () => {
    same(session('x *a * b* y', setText('a * b', ' * b')));
    same(session('x *a * b* y', setText('a * b', 'a * ')));
    same(session('*a * b*', setText('a * b', ' * b')));
    same(session('**a * b**', setText('a * b', 'a * ')));
    same(session('~~a ~ b~~ c', setText('a ~ b', ' ~ b')));
    same(session('[a * b](https://e.example) c', setText('a * b', 'a * ')));
  });
  it('a trailing backslash or $ at an edited edge', () => {
    same(session('x *a \\ b* y', setText('a \\ b', 'a \\ ')));
    same(session('x *a $ b* y $z$', setText('a $ b', 'a $ ')));
  });
  it('bold in bold, italics in italics, strikethrough in strikethrough', () => {
    for (const src of ['****bold** x**', '**x **bold****', '**a **b** c**', '**a**b**c**', '**em* x*', '*x *em**', '~~~~a~~ b~~', '**a __b__ c**', '***a** b*', '***a* b**', '~~a<del>b</del>c~~', '~~~~x~~~~', '~~a ~~b~~ c~~']) {
      const html = render(src);
      const r = session(src, typeAtEnd('z'));
      same(r);
      void html;
    }
  });
  it('a link in bold right after bold (the matrix cases)', () => {
    same(session('****bold**<https://example.com>***', typeAtEnd('x')));
    same(session('**em*<https://example.com>**', typeAtEnd('x')));
  });
});

describe('a link whose text holds a URL and an escaped bracket', () => {
  it('[https://e.example/q2]] (the text ends in "]")', () => same(session('a <https://e.example/q2> b', (w) => { const a = w.querySelector('a')!; a.textContent += ']'; })));
});

describe('a break alone on its line right before a nested list (v2-ses-wysiwyg seed 9)', () => {
  it('is left out (no backslash that shows as text, no <br> line that swallows the nested list)', () => {
    const r = session('- a\n- b\n  - c', (w) => { const li = w.querySelectorAll('li')[1]; li.firstChild!.replaceWith(w.ownerDocument.createElement('br')); });
    expect(r.md).not.toMatch(/\\|<br>/);
    // the empty line the break made is the one thing that cannot be written
    expect(r.again).toBe(r.shown.replace('<br></br>', ''));
  });
  it('a break at the start of a line that goes on stays the backslash form', () => {
    const r = session('a b', (w) => { const p = w.querySelector('p')!; p.insertBefore(w.ownerDocument.createElement('br'), p.firstChild); });
    same(r);
    expect(r.md).toBe('\\\na b');
  });
});
