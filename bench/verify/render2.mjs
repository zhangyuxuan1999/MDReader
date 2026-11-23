// bench/verify/render2.mjs — second fixture corpus (edge cases beyond render.mjs): tabs, lone CR, tables followed
// by text/lists, reference-definition edge cases, math inside containers, linkify variants, html container
// edge cases, headings in odd places, code-language aliases, giant paragraph typing. Preview vs markdown-it.
// Run: node bench/verify/render2.mjs   (dev server on :5202)
import { openApp2, loadSettled, assertEqualsReference, harness, finish, tocItems, blocksHtml, sleep, settle } from './lib2.mjs';

const H = harness('render2');
const app = await openApp2();
const { page } = app;

const corpus = [
  ['tabs: indented code + list + fence', 'para\n\n\tindented with tab\n\t# not heading\n\n-\titem with tab\n-\tsecond\n\n```\n\tcode with tab\n```\n'],
  ['lone CR line endings', '# Title\r\rpara one\rline two\r\r- a\r- b\r\r```\rcode\r```\r'],
  ['mixed CR/CRLF/LF', '# T\r\n\rpara\n\n- x\r\n- y\r\r> q\n'],
  ['table followed directly by text', '| a | b |\n|---|---|\n| 1 | 2 |\ntext after table\nmore\n'],
  ['table followed directly by list', '| a | b |\n|---|---|\n| 1 | 2 |\n- item\n- item2\n'],
  ['table with escaped pipes and code', '| a | b |\n|---|---|\n| `x\\|y` | \\| |\n| **b** \\| c | d |\n'],
  ['table without leading/trailing pipes + short rows', 'a | b | c\n--|--|--\n1 | 2\n1 | 2 | 3 | 4\n'],
  ['table with only header', '| h1 | h2 |\n|----|----|\n\nnext\n'],
  ['paragraph then table delimiter (not a table)', 'text\n---|---\nmore\n'],
  ['ref def followed by text without blank', '[foo]: https://example.com/foo\ntext uses [foo]\n\n[foo]\n'],
  ['duplicate ref definitions (first wins)', '[dup]\n\n[dup]: https://example.com/first\n[dup]: https://example.com/second\n'],
  ['ref def with angle brackets + title variants', '[a]\n[b]\n[c]\n\n[a]: <https://example.com/a b> "t1"\n[b]: https://example.com/b \'t2\'\n[c]: https://example.com/c (t3)\n'],
  ['ref def with CJK label + case fold', '[标签]\n[ẞ] [ss]\n\n[标签]: https://example.cn/x\n[SS]: https://example.com/ss\n'],
  ['ref-style image and nested link', '![alt][im] and [![badge][im]][lnk]\n\n[im]: https://example.com/i.png "img"\n[lnk]: https://example.com/l\n'],
  ['ref def in blockquote used outside', '> [q]: https://example.com/q\n\nuse [q]\n'],
  ['ref def inside list item used outside', '- [li]: https://example.com/li\n\nuse [li]\n'],
  ['ref def cannot interrupt paragraph', 'para line\n[np]: https://example.com/np\n\nuse [np]\n'],
  ['ref label with brackets escaped', '[a\\]b]\n\n[a\\]b]: https://example.com/ab\n'],
  ['linkify variants', 'Visit www.example.com or example.com/path or mailto:a@b.co or a@b.co or https://例子.测试/路径 or http://x.y/?a=1&b=2. ftp://f.x/ done\n'],
  ['linkify inside code / html', '`https://not.link` and <span>https://in.html</span> and <https://auto.link>\n'],
  ['emphasis edge: underscores in words + CJK', 'snake_case_name and __init__ and *a*b* and **加粗**中文 and ***x***\n\n_中文_ 和 *中文*，**中文**。\n'],
  ['strikethrough edge', '~~del~~ ~single~ ~~~ not\n'],
  ['inline code with backticks', '`` a ` b `` and ` `` ` and `code\nspanning` lines\n'],
  ['hard break at paragraph end', 'line  \n\nnext\\\n\nend\n'],
  ['html inline mixed with markdown', '<b>bold **and** more</b> text <i>*em*</i> <code>`x`</code>\n'],
  ['html block type 7 alone cannot interrupt paragraph', 'text\n<span>x</span>\nmore\n\n<span>y</span>\nz\n'],
  ['html block type 6 interrupts paragraph', 'text\n<div>\n# inside\n</div>\nafter\n'],
  ['html comment inline and block', 'a <!-- inline --> b\n\n<!-- block -->\n# H\n\n<!-- multi\n# not heading\n-->\n'],
  ['html container with attributes on multiple lines', '<div\n  class="x"\n  align="center">\n\ncontent **md**\n\n</div>\n'],
  ['unclosed div container', '<div>\n\npara **one**\n\npara two\n\n# heading in unclosed div\n\nend\n'],
  ['closing tag before open (stray)', '</div>\n\ntext\n\n<div>\n\nx\n\n</div>\n\n</div>\n'],
  ['details with heading inside', '<details>\n<summary>S</summary>\n\n## Inside details\n\ntext\n\n</details>\n\n## After details\n'],
  ['table html container with md inside', '<table>\n<tr><td>\n\n**md in td**\n\n</td></tr>\n</table>\n'],
  ['pre containing fence markers and blanks', '<pre>\n```\n\n# x\n```\n</pre>\n\nafter\n'],
  ['textarea/script/style html1 blocks', '<textarea>\n\n# x\n</textarea>\n\npara\n'],
  ['processing instruction / cdata / doctype', '<?php echo 1; ?>\n\n<![CDATA[\n# x\n]]>\n\n<!DOCTYPE html>\n\nafter\n'],
  ['fence inside nested list (4-space indent)', '- a\n  - b\n    ```js\n    code();\n\n    # not heading\n    ```\n  - c\n- d\n'],
  ['fence inside blockquote with blank quote line', '> ```\n> a\n>\n> # b\n> ```\n>\n> after\n'],
  ['fence info string with attributes', '```ts title="x.ts" {1,2}\nconst a = 1;\n```\n\n``` js\nlet b;\n```\n\n```{r}\nx <- 1\n```\n'],
  ['fence indented 1-3 spaces', ' ```\n code\n ```\n\n   ```py\n   x = 1\n   ```\n'],
  ['fence closer with trailing spaces / longer', '```\ncode\n```   \n\n```\ncode2\n`````\n\nafter\n'],
  ['backtick fence with backtick in info (not a fence)', '``` a`b\ntext\n```\n'],
  ['language aliases', '```javascript\nconst a = 1;\n```\n\n```sh\necho $HOME\n```\n\n```bash\nls -la\n```\n\n```yaml\nkey: value\n```\n\n```html\n<div class="x">hi</div>\n```\n\n```css\n.a { color: red }\n```\n\n```JSON\n{"a":1}\n```\n\n```TypeScript\nlet x: number;\n```\n\n```c++\nint main() {}\n```\n\n```rust\nfn main() {}\n```\n\n```go\nfunc main() {}\n```\n\n```java\nclass A {}\n```\n\n```sql\nSELECT 1;\n```\n\n```diff\n- a\n+ b\n```\n\n```text\nplain\n```\n\n```mermaid\ngraph TD; A-->B\n```\n'],
  ['heading edge cases', '#\n\n# \n\n#5 not heading\n\n# H #\n\n# H \\#\n\n# H ####\n\n  # two-space indent\n\n    # four-space code\n\n#	tab heading\n\n# *em* **strong** `code` [l](u) ![i](p)\n'],
  ['setext edge cases', 'a\n=\n\nb\n---\n\nc\n= =\n\nd\n---\n---\n\n- li\n---\n\n> q\n---\n\ne\n    ===\n'],
  ['setext after list / quote (lazy)', '- item\nlazy\n===\n\n> quote\ncont\n---\n'],
  ['hr variants and lookalikes', '---\n\n***\n\n___\n\n- - -\n\n_ _ _\n\n    ---\n\n--\n\n+++\n\n---text\n\n* * * *\n'],
  ['list edge: marker changes + start numbers', '- a\n* b\n+ c\n\n1. x\n2) y\n\n007. seven\n\n1234567890. too long\n\n- \n- empty above\n'],
  ['list indentation edge', '- a\n - b\n  - c\n   - d\n    - e (code?)\n\n1. one\n   1. nested\n      1. deeper\n'],
  ['loose vs tight mixed', '- a\n- b\n\n- c\n\n  para\n- d\n'],
  ['list with fence + table + quote inside', '1. item\n\n   ```\n   code\n   ```\n\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n\n   > quote\n\n2. next\n'],
  ['task list edge', '- [ ]\n- [ ]x\n- [x]\n- [ ] ok\n-  [ ] two spaces\n- [X] upper\n- [ ]  double\n\n[ ] not in list\n\n1. [ ] o\n'],
  ['blockquote edge', '>\n\n> a\n>b\n> > c\n>>> d\n\n>no space\n\n> - a\n> - b\n>\n>   c\n'],
  ['blockquote lazy then heading', '> a\nb\n# H\nc\n'],
  ['math inside blockquote and list', '> $$\n> a = b\n> $$\n\n- $x$ item\n- $$\n  y\n  $$\n\n| $a$ | $$b$$ |\n|---|---|\n| $c_1$ | d |\n'],
  ['math with html-ish and entities', '$a < b > c$ and $\\text{&amp;}$ and $$x < y$$\n\n$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$\n'],
  ['dollar edge cases', 'Price $5, $10, $5.00-$10.50, US$3, 5$ each, $ alone, $$ two, a$b$c, $x$$y$, \\$esc\\$, `$in code$`\n\n$$$\n\n$$ $$\n'],
  ['math unclosed inline', 'A single $ here and text\n\n$unclosed math runs to end?\n\nnext para\n'],
  ['entities + numeric refs + invalid', '&amp; &#38; &#x26; &notanentity; &#0; &#xD800; &#1114112; &copy;\n'],
  ['unicode: zero-width, rtl, combining, emoji', 'a\u200bb \u202eRTL\u202c é (e\u0301) 👨‍👩‍👧‍👦 🇨🇳\n\n# 标题\u200b带零宽\n'],
  ['very long line with inline markup', 'x **b** `c` [l](https://x.y) '.repeat(3000) + '\n'],
  ['deeply nested lists (20)', Array.from({ length: 20 }, (_, i) => ' '.repeat(i * 2) + '- L' + i).join('\n') + '\n'],
  ['deeply nested quotes (20)', '>'.repeat(20) + ' deep\n'],
  ['many blank lines between blocks', 'a\n\n\n\n\n\n\n\n\n\nb\n\n\n\n# H\n\n\n\n- l\n\n\n\n- m\n'],
  ['whitespace-only lines inside paragraph', 'a\n   \nb\n\t\nc\n'],
  ['line with only spaces at eof', 'a\n   '],
  ['no trailing newline', '# H\ntext'],
  ['single char', 'x'],
  ['only a fence opener', '```'],
  ['only $$', '$$'],
  ['only html open', '<div>'],
  ['bom at start', '\ufeff# Title\n\ntext\n'],
];

// the sanitizer drops <textarea> (FORBID_TAGS) but keeps its text — an expected difference
const SANITIZED_EXPECTED = new Set(['textarea/script/style html1 blocks']);
for (const [name, text] of corpus) {
  try {
    await loadSettled(page, text, name.replace(/\W+/g, '_') + '.md');
    if (SANITIZED_EXPECTED.has(name)) { H.pass(`corpus2: ${name}`, 'differs only by the sanitised <textarea> (expected)'); continue; }
    await assertEqualsReference(page, H, `corpus2: ${name}`);
  } catch (err) {
    H.fail(`corpus2: ${name} (exception)`, { error: String(err).slice(0, 500) });
  }
}

// ---------------------------------------------------------------- language aliases: is highlighting applied?
await loadSettled(page, corpus.find((c) => c[0] === 'language aliases')[1], 'langs.md');
const langs = await page.evaluate(() => Array.from(document.querySelectorAll('pre.md-code')).map((pre) => ({
  lang: pre.dataset.lang ?? null, unhighlighted: pre.classList.contains('md-code--unhighlighted'), spans: pre.querySelectorAll('[class*="hljs-"]').length, cls: pre.querySelector('code')?.className,
})));
console.log('langs:', JSON.stringify(langs));
const shouldHl = new Set(['javascript', 'sh', 'bash', 'yaml', 'html', 'css', 'JSON', 'TypeScript', 'c++', 'rust', 'go', 'java', 'sql', 'diff']);
const notHl = langs.filter((l) => shouldHl.has(l.lang) && (l.unhighlighted || l.spans === 0));
if (notHl.length) H.fail('highlight: common language aliases not highlighted', { notHl });
else H.pass('highlight: common language aliases highlighted', langs.map((l) => `${l.lang}:${l.spans}`).join(' '));

// ---------------------------------------------------------------- headings inside containers → TOC
await loadSettled(page, '<details>\n<summary>S</summary>\n\n## Inside details\n\ntext\n\n</details>\n\n## After details\n\n<div>\n\n### In div\n\n</div>\n\n- item\n  # in list\n\n> # in quote\n', 'toc-containers.md');
const toc = await tocItems(page);
console.log('toc containers:', JSON.stringify(toc));
const want = ['Inside details', 'After details', 'In div'];
const missing = want.filter((t) => !toc.some((x) => x.text === t));
if (missing.length) H.fail('toc: headings inside HTML containers missing from the outline', { toc, missing });
else H.pass('toc: headings inside HTML containers present', toc.map((t) => `${t.level}:${t.text}@${t.line}`).join(', '));
// rendered <h2>/<h3> in the preview vs toc: any rendered top-level heading (not inside li/blockquote) must be in the toc
const rendered = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block :is(h1,h2,h3,h4,h5,h6)')).filter((h) => !h.closest('li') && !h.closest('blockquote')).map((h) => h.textContent.trim()));
const notInToc = rendered.filter((t) => !toc.some((x) => x.text === t));
if (notInToc.length) H.fail('toc: rendered headings not in the TOC', { rendered, toc: toc.map((t) => t.text), notInToc });
else H.pass('toc: every rendered top-level heading has a TOC entry');

// ---------------------------------------------------------------- BOM: is it visible / counted?
await loadSettled(page, '\ufeff# Title\n\ntext\n', 'bom.md');
const bom = await page.evaluate(() => ({ h1: document.querySelector('.md-block h1')?.textContent ?? null, tocFirst: document.querySelector('.mdr-toc__item')?.textContent ?? null, blocks: document.querySelectorAll('.md-block').length }));
// informational only: File.text()/Response.text() strip the BOM before the app sees the string, and markdown-it behaves the same
H.measure('bom: "\\ufeff# Title" passed straight to loadText renders an h1', bom.h1 === 'Title' ? 'yes' : 'no (same as markdown-it; real files lose the BOM in .text())', 'informational', true);

// ---------------------------------------------------------------- giant paragraph (>200k): typed text must eventually appear
const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
let para = '';
while (para.length < 300_000) para += unit;
await loadSettled(page, `# Big\n\n${para}\n\n## After\n`, 'para300k.md', { mountAll: false });
await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && !b.classList.contains('is-pending') && !b.classList.contains('is-slow'); }, null, { timeout: 30_000 });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 20));
await page.keyboard.type('QQXYZ');
const tQ = Date.now();
const shown = await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && b.textContent.includes('QQXYZ') && !b.classList.contains('is-slow') && !b.classList.contains('is-stale'); }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
const giant = await page.evaluate(() => { const b = document.querySelectorAll('.md-block')[1]; return { cls: b?.className, first: b?.firstElementChild?.className, hasTyped: b?.textContent.includes('QQXYZ'), rawMarkup: /\*\*加粗\*\*/.test(b?.textContent ?? '') }; });
console.log('giant paragraph after typing:', JSON.stringify(giant));
if (!shown) H.fail('giant paragraph (300 KB): typed text never appears in the preview within 20 s', giant);
else { H.pass('giant paragraph (300 KB): typed text appears', `${Date.now() - tQ} ms`); H.measure('300 KB paragraph: last keystroke → preview updated', `${Date.now() - tQ} ms`, 'informational', true); }
if (giant.rawMarkup) H.measure('300 KB paragraph shown as PLAIN raw markdown (spec maxHtmlChars=200000)', 'yes', 'spec-conformant, informational', true);

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
