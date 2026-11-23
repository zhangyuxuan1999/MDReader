import { describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_PLAIN, HTML_FLAG_TRUSTED } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { loadMath, mathReady } from '../src/worker/math';
import { buildOutline, createOutlineState, headingText, outlineFingerprint, slugify, updateOutline } from '../src/worker/outline';
import { blockCounts, finaliseStats, emptyStats, addCounts } from '../src/worker/stats';
import { LruCache } from '../src/worker/cache';
import { buildBlocks } from '../src/worker/segmenter';
import { createDoc } from '../src/worker/doc';

const env = () => ({ references: {} });

describe('md.ts', () => {
  const mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);

  it('adds data-l (relative line) to block tokens', () => {
    const html = mdk.renderBlock('para\n\n# H\n\n- a\n- [ ] b\n\n> q\n\n| a |\n|---|\n| 1 |\n\n---\n', env()).html;
    expect(html).toContain('<p data-l="0">para</p>');
    expect(html).toContain('<h1 data-l="2">H</h1>');
    expect(html).toContain('<li data-l="4">a</li>');
    expect(html).toContain('<li class="task-list-item enabled" data-l="5">');
    // upstream plugin quirk: no space before `type` when checkboxes are enabled; browsers parse it fine
    expect(html).toContain('<input class="task-list-item-checkbox"type="checkbox">');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('<label');
    expect(html).toContain('<blockquote data-l="7">');
    expect(html).toContain('<table data-l="9">');
    expect(html).toContain('<hr data-l="13">');
    expect(html).not.toContain(' id=');
  });

  it('renders fences with hljs, data-lang and the size cap', () => {
    const ts = mdk.renderBlock('```ts\nconst x: number = 1;\n```', env()).html;
    expect(ts).toMatch(/^<pre class="md-code" data-l="0" data-lang="ts"><code class="hljs language-ts">/);
    expect(ts).toContain('hljs-keyword');
    const unknown = mdk.renderBlock('```nosuchlang\n<b>\n```', env()).html;
    expect(unknown).toContain('md-code--unhighlighted');
    expect(unknown).toContain('&lt;b&gt;');
    const plain = mdk.renderBlock('```\nx\n```', env()).html;
    expect(plain).toContain('<pre class="md-code md-code--unhighlighted" data-l="0"><code>x\n</code></pre>');
    const capped = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, maxHighlightChars: 10 }).renderBlock('```ts\nconst x: number = 1;\n```', env()).html;
    expect(capped).toContain('md-code--unhighlighted');
    const off = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, highlight: false }).renderBlock('```ts\nconst x = 1;\n```', env()).html;
    expect(off).not.toContain('hljs-');
    expect(mdk.renderBlock('    indented', env()).html).toContain('<pre class="md-code md-code--unhighlighted" data-l="0"><code>indented');
  });

  it('TRUSTED flag only when every token is a fence / code block (escaped text, no user markup)', () => {
    expect(mdk.renderBlock('```ts\nconst x = 1;\n```', env()).flags).toBe(HTML_FLAG_TRUSTED);
    expect(mdk.renderBlock('```\n<img src=x onerror=alert(1)>\n```\n\n', env()).flags).toBe(HTML_FLAG_TRUSTED);
    expect(mdk.renderBlock('    indented\n\n    more', env()).flags).toBe(HTML_FLAG_TRUSTED);
    expect(mdk.renderBlock('```\nx\n```\nparagraph after the fence', env()).flags).toBe(0);
    expect(mdk.renderBlock('para', env()).flags).toBe(0);
    expect(mdk.renderBlock('<div>x</div>', env()).flags).toBe(0);
    expect(mdk.renderBlock('', env()).flags).toBe(0);
    const trusted = mdk.renderBlock('```html\n<script>alert(1)</script>\n```', env());
    expect(trusted.flags).toBe(HTML_FLAG_TRUSTED);
    expect(trusted.html).not.toContain('<script');
  });

  it('html_block content carries data-l on its first tag (no wrapper element)', () => {
    expect(mdk.renderBlock('<details>\n<summary>S</summary>\n\nbody\n\n</details>', env()).html).toBe(
      '<details data-l="0">\n<summary>S</summary>\n<p data-l="3">body</p>\n</details>',
    );
    expect(mdk.renderBlock('<!-- c -->', env()).html).toBe('<!-- c -->');
    expect(mdk.renderBlock('</div>', env()).html).toBe('</div>');
    expect(mdk.renderBlock('<div align="center">\n\n# T\n\n</div>', env()).html).toContain('<div data-l="0" align="center">');
  });

  it('math: text after a closing $$ is kept', async () => {
    expect(await loadMath()).toBe(true);
    const m = createMarkdown(DEFAULT_RENDER_OPTIONS);
    m.enableMath();
    const same = m.renderBlock('$$x^2$$ TRAILING-SAME-LINE', env()).html;
    expect(same).toContain('TRAILING-SAME-LINE');
    expect(same).toContain('md-math--display');
    expect(same).toMatch(/^<p data-l="0">/);
    const after = m.renderBlock('$$\na = b\n$$ TRAILING-AFTER-CLOSER', env()).html;
    expect(after).toContain('<div class="md-math md-math--block" data-l="0">');
    expect(after).toContain('<p data-l="2">TRAILING-AFTER-CLOSER</p>');
    expect(m.renderBlock('$$x^2$$', env()).html).toMatch(/^<div class="md-math md-math--block"/);
    expect(m.renderBlock('$$x^2$$   ', env()).html).toMatch(/^<div class="md-math md-math--block"/);
  });

  it('math: currency forms stay plain text, real formulas still parse (fix round)', async () => {
    expect(await loadMath()).toBe(true);
    const m = createMarkdown(DEFAULT_RENDER_OPTIONS);
    m.enableMath();
    const plain = (src: string): boolean => !m.renderBlock(src, env()).html.includes('md-math');
    // prefix + suffix currency on one line: `$5, then 5$` is not a formula
    expect(plain('Price $5, then 5$ each.')).toBe(true);
    expect(plain('Price $5, then 5$')).toBe(true);
    expect(plain('$5 and $10')).toBe(true);
    expect(plain('costs 5$ or 6$ today')).toBe(true);
    // a formula whose body starts with a digit but does not end like a price still renders
    expect(plain('$5x$ apples')).toBe(false);
    expect(plain('$5 \\cdot x$')).toBe(false);
    expect(plain('$x = 5$ exactly')).toBe(false);
    expect(plain('$E=mc^2$')).toBe(false);
  });

  it('math: many unpaired `$` are scanned linearly (memoised closer search)', async () => {
    expect(await loadMath()).toBe(true);
    const m = createMarkdown(DEFAULT_RENDER_OPTIONS);
    m.enableMath();
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `$${i} 元`).join(' ');
    m.renderBlock(words(100), env());
    const time = (n: number): number => {
      const t0 = performance.now();
      m.renderBlock(words(n), env());
      return performance.now() - t0;
    };
    const small = Math.max(1, time(2000));
    const big = time(16000);
    // quadratic would be ~64× the 2k time; linear is ~8×
    expect(big).toBeLessThan(small * 24);
    expect(big).toBeLessThan(200);
    // the memo must not hide a later valid formula in the same paragraph
    expect(m.renderBlock(`${words(500)} and $x^2$ ends`, env()).html).toContain('md-math');
    expect(m.renderBlock('$a$ $1 $b$', env()).html.match(/md-math/g)?.length).toBe(2);
  });

  it('renderDocument honours mathOutput', async () => {
    expect(await loadMath()).toBe(true);
    const m = createMarkdown(DEFAULT_RENDER_OPTIONS);
    m.enableMath();
    const both = m.renderDocument('$x$', {}, new Map());
    expect(both).toContain('<math');
    const htmlOnly = m.renderDocument('$x$', {}, new Map(), 'html');
    expect(htmlOnly).toContain('katex-html');
    expect(htmlOnly).not.toContain('<math');
    expect(m.renderBlock('$x$', env()).html).toContain('<math');
  });

  it('images are lazy, links linkified, strikethrough and tables enabled, inline html kept', () => {
    const html = mdk.renderBlock('![a](x.png) see https://example.com ~~del~~ <em>hi</em>', env()).html;
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<a href="https://example.com">');
    expect(html).toContain('<s>del</s>');
    expect(html).toContain('<em>hi</em>');
  });

  it('PLAIN flag for oversize blocks, error block on exceptions', () => {
    const small = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, maxHtmlChars: 5 });
    const r = small.renderBlock('0123456789', env());
    expect(r.flags).toBe(HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED);
    expect(r.html).toBe('0123456789');
    const boom = createMarkdown(DEFAULT_RENDER_OPTIONS);
    boom.md.core.ruler.push('boom', () => {
      throw new Error('kaboom <x>');
    });
    const e = boom.renderBlock('<src>', env());
    expect(e.flags).toBe(0);
    expect(e.html).toBe('<div class="md-error"><p>渲染此段落时出错：kaboom &lt;x&gt;</p><pre>&lt;src&gt;</pre></div>');
  });

  it('uses env.references for reference links', () => {
    const html = mdk.renderBlock('see [docs][d]', { references: { D: { href: 'https://d.example', title: '' } } }).html;
    expect(html).toContain('<a href="https://d.example">docs</a>');
  });

  it('renders math after KaTeX is loaded', async () => {
    expect(await loadMath()).toBe(true);
    expect(mathReady()).toBe(true);
    const m = createMarkdown(DEFAULT_RENDER_OPTIONS);
    m.enableMath();
    const html = m.renderBlock('inline $E=mc^2$ and $$a$$\n\n$$\n\\int_0^1 x\n$$\n\ncost $5 and $6', env()).html;
    expect(html).toContain('<span class="md-math"><span class="katex">');
    expect(html).toContain('<span class="md-math md-math--display">');
    expect(html).toContain('<div class="md-math md-math--block" data-l="2">');
    expect(html).toContain('<math');
    expect(html).toContain('cost $5 and $6');
    expect(m.renderBlock('\\$notmath\\$', env()).html).toContain('$notmath$');
    expect(m.renderBlock('$$\nunclosed', env()).html).toContain('md-math--block');
  });

  it('renderDocument adds heading ids from the given map', () => {
    const html = mdk.renderDocument('# A\n\ntext\n\n## B', {}, new Map([[1, 'a'], [5, 'b']]));
    expect(html).toContain('<h1 data-l="0" id="a">A</h1>');
    expect(html).toContain('<h2 data-l="4" id="b">B</h2>');
  });
});

const s4 = <T,>(x: T): T => x;

describe('outline.ts', () => {
  it('strips markup and slugifies with global dedupe', () => {
    expect(headingText('##  *Hello* `w` [link](http://x) ##')).toBe('Hello w link');
    expect(slugify('Hello World 中文!')).toBe('hello-world-中文');
    const lines = ['# A', '', '## A', '', 'Set', '===', '', '# B *x*', '', 'para', 'para2', '---'];
    const blocks = buildBlocks(lines, (() => { let n = 1; return () => n++; })());
    const { entries } = buildOutline(blocks, lines);
    expect(entries.map((e) => [e.level, e.text, e.slug, e.line])).toEqual([
      [1, 'A', 'a', 1],
      [2, 'A', 'a-1', 3],
      [1, 'Set', 'set', 5],
      [1, 'B x', 'b-x', 8],
      [2, 'para para2', 'para-para2', 10],
    ]);
    expect(entries[0].blockId).toBe(blocks[0].id);
    const fp = outlineFingerprint(entries);
    expect(outlineFingerprint(buildOutline(blocks, lines).entries)).toBe(fp);
    expect(outlineFingerprint(entries.slice(1))).not.toBe(fp);
  });

  it('heading text: tags stripped, entities decoded, image alt dropped, escapes literal, inner spaces kept', () => {
    expect(headingText('##### A & B <b>c</b> &amp; \\# d')).toBe('A & B c & # d');
    expect(headingText('# ![img](https://x.y/i.png) with image')).toBe('with image');
    expect(headingText('##   Spaces   Inside  ')).toBe('Spaces   Inside');
    expect(headingText('## Trailing hashes ###   ')).toBe('Trailing hashes');
    expect(headingText('# \\*not em\\* &lt;x&gt; &#x1F600; &#65;')).toBe('*not em* <x> 😀 A');
    expect(headingText('# Emoji 🎉 & Punct!?')).toBe('Emoji 🎉 & Punct!?');
    expect(headingText('# `code` and <kbd>K</kbd> [l](u "t")')).toBe('code and K l');
    expect(slugify('A & B c & # d')).toBe('a--b-c---d');
  });

  it('outline: multi-line setext headings and markdown headings inside glued HTML regions', () => {
    const lines = ['first line', 'second line', '==========', '', '# ATX', '', '<div align="center">', '', '# Centered', '', 'Sub', '---', '', '<details>', '# raw', '', '</div>', '', '```', '# fence', '```'];
    const blocks = buildBlocks(lines, (() => { let n = 1; return () => n++; })());
    expect(blocks.map((b) => b.kind)).toEqual([BlockKind.Prose, BlockKind.Heading, BlockKind.Html, BlockKind.Code]);
    const { entries } = buildOutline(blocks, lines);
    expect(entries.map((e) => [e.level, e.text, e.slug, e.line, e.blockId])).toEqual([
      [1, 'first line second line', 'first-line-second-line', 1, blocks[0].id],
      [1, 'ATX', 'atx', 5, blocks[1].id],
      [1, 'Centered', 'centered', 9, blocks[2].id],
      [2, 'Sub', 'sub', 11, blocks[2].id],
    ]);
  });

  it('outline state is incremental: cached slugs, line shifts patch in place, fingerprint tracks changes', () => {
    const alloc = (() => { let n = 1; return () => n++; })();
    const lines = ['# A', '', 'p', '', '# A', '', '## B'];
    let blocks = buildBlocks(lines, alloc);
    const st = createOutlineState();
    expect(updateOutline(st, blocks, lines)).toBe(true);
    const first = st.entries;
    expect(first.map((e) => e.slug)).toEqual(['a', 'a-1', 'b']);
    expect(updateOutline(st, blocks, lines)).toBe(false);
    // shift lines only (same blocks with a moved startLine): entries are patched in place, no new array
    for (const b of blocks) if (b.startLine > 1) b.startLine += 2;
    expect(updateOutline(st, blocks, lines)).toBe(true);
    expect(st.entries).toBe(first);
    expect(first.map((e) => e.line)).toEqual([1, 7, 9]);
    for (const b of blocks) if (b.startLine > 1) b.startLine -= 2;
    // a fresh block object with the same id + hash reuses the cached entry; a changed hash rebuilds
    blocks = blocks.map((b) => ({ ...b }));
    expect(updateOutline(st, blocks, lines)).toBe(true); // lines moved back
    // same heading count with a changed text: patched in place (slugs re-deduped), still the same array
    const lines2 = ['# A', '', 'p', '', '# C', '', '## B'];
    blocks = buildBlocks(lines2, alloc);
    expect(updateOutline(st, blocks, lines2)).toBe(true);
    expect(st.entries).toBe(first);
    expect(st.entries.map((e) => e.slug)).toEqual(['a', 'c', 'b']);
    // a removed heading rebuilds the list
    const lines3 = ['# A', '', 'p', '', 'C', '', '## B'];
    blocks = buildBlocks(lines3, alloc);
    expect(updateOutline(st, blocks, lines3)).toBe(true);
    expect(st.entries).not.toBe(first);
    expect(st.entries.map((e) => e.slug)).toEqual(['a', 'b']);
    // in-place patch keeps global dedupe exact: renaming headings shifts the -n suffixes of the others
    const l3 = ['# A', '', '# A', '', '# B', '', '# A', '', '# B'];
    const b3 = buildBlocks(l3, alloc);
    const s3 = createOutlineState();
    updateOutline(s3, b3, l3);
    expect(s3.entries.map((e) => e.slug)).toEqual(['a', 'a-1', 'b', 'a-2', 'b-1']);
    const patched = s3.entries;
    // rename the 2nd A → B and the 1st B → A in one edit (same heading count → patched in place)
    const l4 = ['# A', '', '# B', '', '# A', '', '# A', '', '# B'];
    const b4 = b3.map((b, i) => (i === 1 || i === 2 ? { ...b, outline: null, hashLo: b.hashLo ^ 1 } : b));
    b4[1].kind = BlockKind.Heading;
    expect(updateOutline(s4(s3), b4, l4)).toBe(true);
    expect(s3.entries).toBe(patched);
    expect(s3.entries.map((e) => [e.text, e.slug])).toEqual([['A', 'a'], ['B', 'b'], ['A', 'a-1'], ['A', 'a-2'], ['B', 'b-1']]);
    expect(s3.entries.map((e) => [e.text, e.slug])).toEqual(buildOutline(buildBlocks(l4, alloc), l4).entries.map((e) => [e.text, e.slug]));
    // empty outline is reported once
    const empty = createOutlineState();
    expect(updateOutline(empty, [], [])).toBe(true);
    expect(updateOutline(empty, [], [])).toBe(false);
  });
});

describe('stats.ts', () => {
  it('counts cjk, latin words, chars', () => {
    const c = blockCounts("中文 English words don't 123 日本語 한국어");
    expect(c.cjk).toBe(2 + 3 + 3);
    expect(c.latinWords).toBe(4);
    expect(c.charsNoSpace).toBe("中文 English words don't 123 日本語 한국어".length - 6);
    expect(c.chars).toBe("中文 English words don't 123 日本語 한국어".length + 1);
    expect(blockCounts('中文English').latinWords).toBe(1);
    expect(blockCounts('').chars).toBe(1);
  });

  it('finalises doc totals with the readingMinutes rule', () => {
    const t = emptyStats();
    expect(finaliseStats(t, 0, 0).readingMinutes).toBe(0);
    addCounts(t, blockCounts('hi'), 1);
    expect(finaliseStats(t, 1, 1)).toEqual({ chars: 2, charsNoSpace: 2, cjk: 0, latinWords: 1, lines: 1, readingMinutes: 1 });
    addCounts(t, blockCounts('中'.repeat(800)), 1);
    expect(finaliseStats(t, 3, 2).readingMinutes).toBe(3);
  });
});

describe('cache.ts', () => {
  it('evicts least recently used entries by byte budget', () => {
    const c = new LruCache<string, string>(10, (v) => v.length);
    c.set('a', 'aaaa');
    c.set('b', 'bbbb');
    expect(c.get('a')).toBe('aaaa');
    c.set('c', 'cccc'); // budget 10: evicts b (least recent)
    expect(c.has('b')).toBe(false);
    expect(c.has('a')).toBe(true);
    expect(c.bytes).toBe(8);
    c.set('a', 'a');
    expect(c.bytes).toBe(5);
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe('createDoc + buildBlocks stats consistency', () => {
  it('sum of block chars equals text length', () => {
    const text = '# a\n\n中文 text\n\n- x\n';
    const doc = createDoc(text);
    const blocks = buildBlocks(doc.lines, (() => { let n = 1; return () => n++; })());
    const t = emptyStats();
    for (const b of blocks) addCounts(t, b, 1);
    expect(finaliseStats(t, doc.lines.length, blocks.length).chars).toBe(text.length);
  });
});
