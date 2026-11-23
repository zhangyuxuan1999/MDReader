// bench/verify/render.mjs — fixture corpus: app preview vs markdown-it whole-document rendering.
// Run: node bench/verify/render.mjs   (dev server on :5202 must be running)
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, previewState } from './lib.mjs';

const H = harness('render');

// ---------------------------------------------------------------- fixtures compared against markdown-it
const corpus = [
  ['atx+setext headings', '# H1\n\n## H2 ##\n\n### H3\n\n#### H4\n##### H5\n###### H6\n\nSetext One\n==========\n\nSetext Two\n----------\n\nplain\n'],
  ['emphasis/strong/strike/code', 'Some *em* and _em2_ and **strong** and __strong2__ and ~~del~~ and `code` and ***both*** text.\n\n中文**加粗**和*斜体*以及~~删除~~和`代码`混排。\n'],
  ['links inline/auto/ref', '[inline](https://example.com/a "Title") and <https://auto.example.com/x> and https://bare.example.com/y and [ref][r1] and [collapsed][] and [shortcut] here.\n\n' + 'para\n\n'.repeat(60) + '[r1]: https://example.com/r1 "R1"\n[collapsed]: https://example.com/c\n[shortcut]: https://example.com/s\n'],
  ['images', '![alt text](https://example.com/i.png "t")\n\ninline ![x](i2.png) here\n\n![ref img][img]\n\n[img]: https://example.com/ref.png\n'],
  ['lists ordered/unordered/nested/loose', '- a\n- b\n  - b1\n  - b2\n    1. deep\n    2. deeper\n- c\n\n1. one\n2. two\n\n3. three after blank\n\n- loose 1\n\n- loose 2\n\n  continuation para\n\n- loose 3\n\n4) paren\n5) paren2\n\n* star\n+ plus\n'],
  ['task lists', '- [ ] todo\n- [x] done\n- [X] DONE\n  - [ ] nested\n\n1. [ ] ordered task\n2. [x] ordered done\n\n- [ ]\n- [ ] with **bold**\n'],
  ['fences ts/py/json/unknown', '```ts\nconst a: number = 1;\nexport function f() { return `x${a}`; }\n```\n\n```py\ndef f(x):\n    return x  # comment\n```\n\n```json\n{"a": [1, 2, {"b": null}], "c": "d"}\n```\n\n```unknownlang\nfoo <bar> & baz\n```\n\n```\nno lang <b>x</b>\n```\n\n~~~ruby\nputs "hi"\n~~~\n\n````md\n```\ninner\n```\n````\n'],
  ['indented code', 'para\n\n    indented code line 1\n    # not a heading\n\n    after blank still code\n\npara2\n'],
  ['tables with alignment', '| Left | Center | Right | None |\n|:-----|:------:|------:|------|\n| a | b | c | d |\n| **e** | `f` | [g](https://x.y) | 中 |\n\nNo leading pipe:\n\nh1 | h2\n---|---\n1 | 2\n'],
  ['blockquotes nested with lists', '> quote line 1\n> quote line 2\n>\n> > nested\n> > more\n>\n> - item in quote\n> - item 2\n>   1. sub\n>\n> ```js\n> code();\n> ```\n\n> a\n\n> b separate\n'],
  ['hr variants', 'a\n\n---\n\nb\n\n***\n\nc\n\n___\n\n- - -\n\nd\n'],
  ['inline html', 'Text with <sup>sup</sup> and <sub>sub</sub> and <br> break and <kbd>K</kbd> and <img src="https://example.com/x.png" width="100" height="50" alt="w">.\n\n<details>\n<summary>Click</summary>\n\nHidden **markdown** here.\n\n</details>\n\n<div align="center">\n<b>bold html</b>\n</div>\n'],
  ['html block spanning lines', '<table>\n  <tr>\n    <td>cell</td>\n  </tr>\n</table>\n\n<pre>\npre line 1\n\npre line 2 after blank\n# not heading\n</pre>\n\n<!--\ncomment\n\n# not heading in comment\n-->\n\nafter\n'],
  ['cjk no spaces', '这是一段没有空格的中文文本，包含标点符号。还有日本語のテキストと한국어 텍스트。\n\n第二段：**粗体中文**、*斜体中文*、`代码`、[链接](https://example.cn)。\n'],
  ['heading right after paragraph', 'paragraph text\n# Heading no blank\nmore text\n## H2 no blank\n- list\n### H3 after list\n> quote\n#### H4 after quote\n'],
  ['list items separated by blank lines (one list)', '- one\n\n- two\n\n- three\n\n\n- four after two blanks\n\n1. a\n\n2. b\n'],
  ['fence with blank + # lines', '```\nline\n\n# hash line\n\n\n## another\n- not a list\n```\n\nafter\n\n```python\n# comment\n\ndef f():\n    pass\n```\n'],
  ['unclosed fence', 'before\n\n```js\nfunction f() {\n\n# heading-looking\n- list-looking\n\n> quote-looking\n'],
  ['crlf input', '# Title\r\n\r\npara one\r\nline two\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n\r\n| x | y |\r\n|---|---|\r\n| 1 | 2 |\r\n'],
  ['trailing blank lines', '# T\n\ntext\n\n\n\n\n'],
  ['empty doc', ''],
  ['only blank lines', '\n\n\n'],
  ['setext multi-line paragraph', 'line one\nline two\n====\n\nafter\n'],
  ['ref def inside quote/list', '> [q]: https://example.com/q\n\n- [l]: https://example.com/l\n\nuse [q] and [l].\n'],
  ['heading indented inside list item', '- item\n\n  # heading in item\n\n- item2\n  ## h2 directly\n'],
  ['div html block containing # line', '<div>\n# inside div\n</div>\n\n<div>\n\n# real heading after blank\n\n</div>\n'],
  ['ref definition immediately after paragraph', 'text\n[notref]: https://example.com/n\n\nuse [notref]\n'],
  ['numbered list start + escapes', '3. three\n4. four\n\n\\# not heading\n\n\\- not list\n\n1\\. not list\n\n\\*not em\\*\n'],
  ['lazy continuation', '> quote\nlazy line\n\n- item\nlazy item line\n\n1. x\ny\n'],
  ['link reference with title on next line', '[a]\n\n[a]: https://example.com/a\n  "Title on next line"\n'],
  ['multi-line ref definition url on next line', '[b]\n\n[b]:\n  https://example.com/b\n'],
  ['html comment with blank lines then heading', '<!-- a\n\nb -->\n# H after comment\n'],
  ['table interrupted by heading', '| a | b |\n|---|---|\n| 1 | 2 |\n# H\n'],
  ['autolink paragraph start', '<https://example.com/start> begins the paragraph\n\n<span>span start</span> text\n'],
  ['hard breaks', 'line ends with two spaces  \nnext line\nbackslash\\\nend\n'],
  ['entities and special chars', '&amp; &lt; &copy; &#x1F600; &nbsp; 5 < 6 > 4 & "quotes"\n'],
  ['script/style html blocks', '<script>\nvar x = 1;\n\nvar y = 2;\n</script>\n\n<style>\nbody { color: red }\n\np {}\n</style>\n\nafter\n'],
  ['fence inside ordered list with wide marker', '10. item\n\n    ```\n\n    # in fence\n    ```\n\n11. next\n'],
  ['tilde fence closed by backticks (must not close)', '~~~\ncode\n```\nstill code\n~~~\n\nafter\n'],
  ['fence longer closer', '````\ncode\n```\nstill\n````\n\nafter\n'],
  ['thematic break vs list', '- a\n\n* * *\n\n- b\n'],
  ['details with markdown inside (README pattern)', '<details>\n<summary>Show more</summary>\n\n- hidden item 1\n- hidden item 2\n\n```js\nhidden();\n```\n\n</details>\n\nvisible after\n'],
  ['div align=center with blank lines inside', '<div align="center">\n\n# Centered Title\n\n![logo](https://example.com/logo.png)\n\n</div>\n'],
  ['details without blank lines (single html block)', '<details><summary>S</summary>\nplain html body\n</details>\n'],
  ['nested details', '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ninner text\n\n</details>\n\n</details>\n'],
];
// html blocks the sanitizer must drop: markdown-it output contains them, the preview must not (expected difference)
const SANITIZED_EXPECTED = new Set(['script/style html blocks']);

// ---------------------------------------------------------------- run
const app = await openApp();
const { page } = app;

for (const [name, text] of corpus) {
  try {
    await loadAndSettle(page, text, name.replace(/\W+/g, '_') + '.md');
    const html = await previewHtml(page);
    const expected = canonical(renderReference(text));
    const actual = canonical(html);
    const d = diffCanonical(expected, actual);
    if (d && SANITIZED_EXPECTED.has(name)) { H.pass(`corpus: ${name}`, 'differs only by sanitised <script>/<style> (expected)'); continue; }
    if (d) H.fail(`corpus: ${name}`, { fixture: text, diffAt: d.index, expected: d.expected, actual: d.actual, expectedLines: d.expectedLines, actualLines: d.actualLines });
    else H.pass(`corpus: ${name}`, `${actual.length} canonical lines`);
  } catch (err) {
    H.fail(`corpus: ${name} (exception)`, { error: String(err).slice(0, 500) });
  }
}

// ---------------------------------------------------------------- math (own assertions; markdown-it has no math)
const mathDoc = [
  'Inline $E = mc^2$ math and display $$\\int_0^1 x\\,dx$$ inline-display.',
  '',
  'Costs $5 and $10 today; also $5.00 to $10.50, and US$3-$4 range.',
  '',
  '$$',
  '\\frac{a}{b} + \\sqrt{c}',
  '$$',
  '',
  '$$x^2$$ trailing text after closing',
  '',
  'Escaped \\$ dollar and `$code$` in code.',
  '',
  '$$',
  'a = b',
  '$$ tail after closer',
  '',
  'end paragraph',
  '',
].join('\n');
await loadAndSettle(page, mathDoc, 'math.md');
const m = await page.evaluate(() => {
  const body = document.querySelector('.mdr-preview__body');
  const blocks = Array.from(body.querySelectorAll('.md-block'));
  return {
    katex: body.querySelectorAll('.katex').length,
    mathSpans: body.querySelectorAll('.md-math').length,
    displayBlocks: body.querySelectorAll('.md-math--block').length,
    text: body.textContent,
    blockTexts: blocks.map((b) => b.textContent.trim().slice(0, 120)),
    currencyBlock: blocks[1]?.innerHTML,
    codeInMath: !!body.querySelector('code') && Array.from(body.querySelectorAll('code')).map((c) => c.textContent),
  };
});
if (m.katex === 0) H.fail('math: KaTeX rendered', { got: m });
else H.pass('math: KaTeX rendered', `${m.katex} .katex nodes`);
if (m.currencyBlock && /md-math/.test(m.currencyBlock)) H.fail('math: currency "$5 and $10" must not become math', { html: m.currencyBlock });
else H.pass('math: currency not treated as math');
if (!m.text.includes('trailing text after closing')) H.fail('math: text after a same-line closing $$ is lost', { blockTexts: m.blockTexts });
else H.pass('math: text after same-line $$ kept');
if (!m.text.includes('tail after closer')) H.fail('math: text after the closing $$ line is lost', { blockTexts: m.blockTexts });
else H.pass('math: text after closing $$ line kept');
if (!m.codeInMath || !m.codeInMath.includes('$code$')) H.fail('math: `$code$` inside inline code must stay code', { got: m.codeInMath });
else H.pass('math: inline code containing $ preserved');
if (!m.text.includes('Escaped $ dollar')) H.fail('math: escaped \\$ renders as literal $', { text: m.text.slice(0, 300) });
else H.pass('math: escaped dollar');

// ---------------------------------------------------------------- XSS
const xss = [
  ['<script>window.__xss1=1</script>', () => 'script'],
  ['<img src=x onerror="window.__xss2=1">', () => 'onerror'],
  ['[click](javascript:window.__xss3=1)', () => 'javascript-md-link'],
  ['<a href="javascript:window.__xss4=1">js</a>', () => 'javascript-html-link'],
  ['<a href="JaVaScRiPt:window.__xss5=1">js2</a>', () => 'javascript-case'],
  ['<a href="&#106;avascript:window.__xss6=1">js3</a>', () => 'javascript-entity'],
  ['<svg onload="window.__xss7=1"><circle r="1"/></svg>', () => 'svg-onload'],
  ['<svg><a href="javascript:window.__xss8=1"><text>svg link</text></a></svg>', () => 'svg-a-js'],
  ['<details open ontoggle="window.__xss9=1">d</details>', () => 'ontoggle'],
  ['<iframe src="javascript:window.__xss10=1"></iframe>', () => 'iframe'],
  ['<object data="data:text/html,<script>window.__xss11=1</script>"></object>', () => 'object'],
  ['<embed src="data:text/html,x">', () => 'embed'],
  ['<form action="https://evil.example"><input type="text" name="pw"><button>go</button></form>', () => 'form'],
  ['<style>body{display:none}</style>', () => 'style'],
  ['<math><mi xlink:href="javascript:window.__xss12=1">m</mi></math>', () => 'mathml-xlink'],
  ['<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a>', () => 'data-url'],
  ['<video><source onerror="window.__xss13=1" src="x"></video>', () => 'source-onerror'],
  ['<img src="x" name="body"><img src="y" id="__mdr">', () => 'dom-clobber'],
  ['<meta http-equiv="refresh" content="0;url=https://evil.example">', () => 'meta-refresh'],
  ['<base href="https://evil.example/">', () => 'base'],
  ['<a href="https://example.com" target="_blank">ext</a>', () => 'target-noopener'],
  ['<input type="checkbox" onclick="window.__xss14=1" checked> raw', () => 'checkbox-onclick'],
  ['<textarea>x</textarea><select><option>a</option></select><button>b</button>', () => 'forbidden-form-controls'],
  ['<a href="vbscript:window.__xss15=1">vb</a>', () => 'vbscript'],
  ['<svg><use href="data:image/svg+xml;base64,PHN2ZyBpZD0ieCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48c2NyaXB0PndpbmRvdy5fX3hzczE2PTE8L3NjcmlwdD48L3N2Zz4=#x"></use></svg>', () => 'svg-use-data'],
];
const xssDoc = xss.map(([s]) => s).join('\n\n') + '\n';
await loadAndSettle(page, xssDoc, 'xss.md');
const x = await page.evaluate(() => {
  const body = document.querySelector('.mdr-preview__body');
  const fired = Object.keys(window).filter((k) => k.startsWith('__xss'));
  const dangerous = [];
  for (const el of body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'iframe', 'object', 'embed', 'form', 'style', 'meta', 'base', 'link', 'textarea', 'select', 'button'].includes(tag)) dangerous.push(`<${tag}>`);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) dangerous.push(`${tag}[${a.name}]`);
      if (/^(href|src|xlink:href|action|data|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value.replace(/[\s -]/g, ''))) dangerous.push(`${tag}[${a.name}=${a.value.slice(0, 40)}]`);
    }
    if (tag === 'input' && el.type !== 'checkbox') dangerous.push('input[type!=checkbox]');
    if (tag === 'a' && el.target === '_blank' && !/noopener/.test(el.rel)) dangerous.push('a[target=_blank] without noopener');
  }
  return { fired, dangerous, bodyIsElement: document.body instanceof HTMLBodyElement, mdrIntact: typeof window.__mdr?.loadText === 'function', html: body.innerHTML.slice(0, 3000) };
});
if (x.fired.length || x.dangerous.length || !x.bodyIsElement || !x.mdrIntact) H.fail('xss: unsanitised content in preview', { fired: x.fired, dangerous: x.dangerous, html: x.html });
else H.pass('xss: all payloads neutralised', `${xss.length} payloads`);

// ---------------------------------------------------------------- console / page errors
if (app.pageErrors.length) H.fail('page errors during render corpus', { errors: app.pageErrors.slice(0, 5) });
else H.pass('no page errors');
if (app.consoleErrors.length) H.fail('console errors during render corpus', { errors: app.consoleErrors.slice(0, 5) });
else H.pass('no console errors');
if (app.consoleWarnings.length) console.log('[render] console warnings:', app.consoleWarnings.slice(0, 5));

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
