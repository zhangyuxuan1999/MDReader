// bench/verify/r4-fresh.mjs — NEW rendering-correctness fixtures (round 2 verifier).
// Run: node bench/verify/r4-fresh.mjs      (dev server on :5202)
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, independentStats } from './lib.mjs';

const H = harness('r4');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- A. corpus vs markdown-it (new ground)
const corpus = [
  ['table: escaped pipes, code pipes, ragged rows', '| a \\| b | c |\n|---|---|\n| `x|y` | z |\n| only one |\n| 1 | 2 | 3 |\n|  |  |\n'],
  ['table: alignment all four + inline html + math', '| l | c | r | n |\n| :-- | :-: | --: | --- |\n| <b>B</b> | $x$ | $5 | 中文 |\n'],
  ['table: delimiter with spaces / one column / no body', '| solo |\n| :--: |\n\n| a | b |\n| - | - |\n'],
  ['table inside blockquote and list', '> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n- item\n\n  | c | d |\n  |---|---|\n  | 3 | 4 |\n'],
  ['links: parens, angle dest, quotes, nested brackets, email', '[a](https://e.com/x_(y)) [b](</with space>) [c](https://e.com "t") [d](https://e.com \'t2\') [e](https://e.com (t3)) [![img](https://e.com/i.png)](https://e.com/l) [f][ ] <mail@example.com> mail2@example.com www.example.com/path\n'],
  ['links: percent/unicode/hash/query', '[u](https://例子.测试/路径?q=1&r=2#frag) [v](https://e.com/%E4%B8%AD) [w](#local-anchor) [x](./rel/path.md) [y](/abs/path.md)\n'],
  ['emphasis edges', 'a*b*c a_b_c **a*b***  ***abc*** __*x*__ *__y__* **中文**，后面 中**文**中 ~~a~~b a~~b~~ `a``b` \\*not\\*\n'],
  ['images: title, lazy, nested, ref, empty alt', '![](https://e.com/1.png)\n\n![alt](https://e.com/2.png "T")\n\n![ref][ri]\n\n<img src="https://e.com/3.png" width="120" height="60" alt="raw" loading="eager">\n\n[ri]: https://e.com/r.png "RT"\n'],
  ['list: start attr, 4-space content, item is only a fence', '5. five\n6. six\n\n0. zero start\n\n-   wide marker item\n    continued\n\n- ```\n  fenced only\n  ```\n\n- \n- empty item above\n'],
  ['list: ordered loose with multiple paragraphs + nested task', '1. first para\n\n   second para\n\n   - [ ] sub task\n   - [x] sub done\n\n2. second item\n\n   > quote in item\n'],
  ['indented code directly after list', '- item\n\n      indented code in item\n\npara\n\n    top level code\n'],
  ['fence: CJK info string, info with spaces, 10 backticks', '```中文\n代码\n```\n\n```js  extra  words\nvar a=1\n```\n\n``````\nsix\n``````\n'],
  ['quote: table + fence + nested quote + lazy', '> # qh\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n>\n> > deep\n> > > deeper\n>\n> ```js\n> f();\n> ```\n> lazy tail\ncontinued lazily\n'],
  ['hr edge: spaced, many, after paragraph', 'p\n***\np2\n- - - - -\np3\n_____________\n'],
  ['inline html attrs kept: br in table, span style, details open', '| a | b |\n|---|---|\n| x<br>y | <span style="color:red">z</span> |\n\n<details open>\n<summary>Open</summary>\n\ninner\n\n</details>\n'],
  ['currency in headings/tables/lists', '# Costs $5 and $10\n\n- $1 then $2\n- price is $3.50\n\n| $7 | $8 |\n|---|---|\n| $9 | $10 |\n'],
  ['math in heading and table and list', '# Heading with $a+b$\n\n- item $c^2$\n\n| $x$ | y |\n|---|---|\n| $$z$$ | w |\n'],
  ['footnotes (spec: unsupported)', 'Text with a footnote[^1].\n\n[^1]: The note body.\n'],
  ['autolink + linkify inside emphasis and code', '*https://e.com/a* `https://e.com/b` **www.e.com/c** <https://e.com/d>\n'],
  ['emoji + surrogates + combining', '🎉👨‍👩‍👧‍👦 e\u0301 café A\u0301\u0301 𝕳𝖊𝖑𝖑𝖔 🇨🇳\n'],
  ['escapes everywhere', '\\\\ \\` \\* \\_ \\{ \\} \\[ \\] \\( \\) \\# \\+ \\- \\. \\! \\| \\< \\> \\$ \\~\n'],
  ['heading: no space after #, 7 hashes, closing hashes variants', '#nospace\n\n####### seven\n\n## closing ##\n\n## closing no space##\n\n## hash # inside ##\n\n#\n\n## \n'],
  ['crlf mixed with lf and lone cr', '# T\r\n\r\npara lf\nsecond\r\n\r\n```\r\nfence\r\n```\r\n\r\n- a\r\n- b\n- c\r\n'],
  ['tabs for indentation', '-\titem tab\n\t- nested tab\n\n\tcode by tab\n\n| a\t| b |\n|---|---|\n| 1\t| 2 |\n'],
];

for (const [name, text] of corpus) {
  try {
    await loadAndSettle(page, text, name.replace(/\W+/g, '_') + '.md');
    const d = diffCanonical(canonical(renderReference(text)), canonical(await previewHtml(page)));
    if (d) H.fail(`corpus4: ${name}: preview != markdown-it`, { fixture: text, diffAt: d.index, expected: d.expected, actual: d.actual });
    else H.pass(`corpus4: ${name}`);
  } catch (e) { H.fail(`corpus4: ${name} (exception)`, { error: String(e).slice(0, 400) }); }
}

// ---------------------------------------------------------------- B. images get loading="lazy" (SPEC 4.4)
await loadAndSettle(page, '![a](https://e.com/1.png)\n\ntext ![b](https://e.com/2.png) inline\n\n![r][ri]\n\n[ri]: https://e.com/3.png\n', 'lazy.md');
const imgs = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview__body img')).map((i) => ({ src: i.getAttribute('src'), loading: i.getAttribute('loading') })));
if (imgs.length === 3 && imgs.every((i) => i.loading === 'lazy')) H.pass('images: loading="lazy" on every markdown image');
else H.fail('images: SPEC 4.4 requires loading="lazy" on images', { imgs });

// ---------------------------------------------------------------- C. data-l correctness (click-to-source / task write-back)
const dlDoc = ['# H1', '', 'para one', 'para one cont', '', '- a', '- b', '  - c', '', '> q1', '> q2', '', '```js', 'x();', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '<div>', 'raw', '</div>', '', 'last para'].join('\n');
await loadAndSettle(page, dlDoc, 'datal.md');
const dl = await page.evaluate(() => {
  const out = [];
  for (const b of document.querySelectorAll('.mdr-preview__body .md-block')) {
    const start = window.__mdr.app.preview.blockAtLine(1) && null; // placeholder
    for (const el of b.querySelectorAll('[data-l]')) out.push({ id: b.dataset.id, tag: el.tagName.toLowerCase(), l: Number(el.dataset.l), text: el.textContent.trim().slice(0, 30) });
  }
  // block start lines from the model
  const starts = {};
  for (let line = 1; line <= 25; line++) { const b = window.__mdr.app.preview.blockAtLine(line); starts[b.id] = b.startLine; }
  return { out, starts };
});
const srcLines = dlDoc.split('\n');
const dlBad = [];
for (const e of dl.out) {
  const line = dl.starts[e.id] + e.l; // 1-based
  const src = srcLines[line - 1] ?? '';
  const firstWord = (e.text.match(/[A-Za-z0-9();|]+/) || [''])[0];
  if (firstWord && !src.includes(firstWord) && !(e.tag === 'table' || e.tag === 'ul' || e.tag === 'ol' || e.tag === 'blockquote' || e.tag === 'div')) dlBad.push({ ...e, line, src });
}
if (dlBad.length) H.fail('data-l: element line offsets do not point at the source line (alt+click / task write-back land on the wrong line)', { bad: dlBad.slice(0, 8), starts: dl.starts });
else H.pass('data-l: offsets resolve to the right source lines', `${dl.out.length} elements`);

// ---------------------------------------------------------------- D. task toggle on a line with two [ ] and inside nested loose list
const taskDoc = '- [ ] first [ ] second on same line\n- item without task\n\n1. [ ] outer\n\n   - [x] inner done\n\n     more para\n\n2. [ ] outer2\n';
await loadAndSettle(page, taskDoc, 'task2.md');
const toggles = await page.evaluate(async () => {
  const boxes = Array.from(document.querySelectorAll('.mdr-preview__body input[type=checkbox]'));
  const res = [];
  for (let i = 0; i < boxes.length; i++) {
    const before = window.__mdr.app.getText();
    boxes[i].click();
    await new Promise((r) => setTimeout(r, 120));
    const after = window.__mdr.app.getText();
    res.push({ i, changed: before !== after, beforeLines: before.split('\n'), afterLines: after.split('\n') });
  }
  return res;
});
const badToggle = toggles.filter((t) => {
  if (!t.changed) return true;
  const diff = t.afterLines.filter((l, i) => l !== t.beforeLines[i]);
  return diff.length !== 1;
});
if (badToggle.length) H.fail('task toggle: clicking a checkbox changed the wrong number of source lines', { bad: badToggle.map((b) => ({ i: b.i, changed: b.changed, diff: b.afterLines.filter((l, i) => l !== b.beforeLines[i]) })) });
else H.pass('task toggle: each click flips exactly one source line', `${toggles.length} checkboxes`);
const finalText = await page.evaluate(() => window.__mdr.app.getText());
if (finalText.split('\n')[0] === '- [x] first [ ] second on same line') H.pass('task toggle: only the FIRST [ ] on the line is toggled (SPEC 5.6)');
else H.fail('task toggle: a line with two "[ ]" toggles the wrong marker', { line: finalText.split('\n')[0] });

// ---------------------------------------------------------------- E. stats vs independent counts (new inputs)
const statDocs = [
  ['emoji+surrogates', '🎉👨‍👩‍👧‍👦 hello 世界 𝕳𝖊𝖑𝖑𝖔\n'],
  ['hyphen/apostrophe words', "don't re-use it’s state-of-the-art x_y a1b2\n"],
  ['numbers and punctuation only', '123 456,789 !!! ??? ---\n'],
  ['mixed cjk latin dense', '中文abc中文def中文\n'.repeat(50)],
  ['whitespace heavy', '   a    b   \n\n\n   c   \n'],
];
for (const [name, text] of statDocs) {
  await loadAndSettle(page, text, 'stats.md');
  const got = await page.evaluate(() => ({
    words: document.querySelector('.mdr-statusbar__item[data-stat="words"]')?.textContent ?? '',
    chars: document.querySelector('.mdr-statusbar__item[data-stat="chars"]')?.textContent ?? '',
    reading: document.querySelector('.mdr-statusbar__item[data-stat="reading"]')?.textContent ?? '',
  }));
  const exp = independentStats(text);
  const gw = Number((got.words.match(/(\d+)/) || [])[1]);
  const gc = Number((got.chars.match(/(\d+)/) || [])[1]);
  const gr = Number((got.reading.match(/(\d+)/) || [])[1]);
  if (gw !== exp.words || gc !== exp.chars || gr !== exp.readingMinutes)
    H.fail(`stats: ${name} differs from independent count`, { got, expected: exp });
  else H.pass(`stats: ${name}`, `${got.words} / ${got.chars} / ${got.reading}`);
}

// ---------------------------------------------------------------- F. 1 MB paragraph: does typed text EVER appear? (poll)
const big = '# Top\n\n' + ('这是一段很长的中文段落，包含 **加粗** 和 [链接](https://example.com/x) 以及 `代码`。'.repeat(9000)).slice(0, 1_000_000) + '\n\n## Tail\n';
await loadAndSettle(page, big, 'big1mb.md', { timeout: 120_000 });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 50));
const tType = Date.now();
await page.keyboard.type('ZQZQ');
let appeared = -1;
for (let i = 0; i < 60; i++) {
  const ok = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block')).some((b) => b.textContent.includes('ZQZQ')));
  if (ok) { appeared = Date.now() - tType; break; }
  await new Promise((r) => setTimeout(r, 250));
}
if (appeared < 0) H.fail('1 MB paragraph: text typed into it never appears in the preview (15 s)', { note: 'block is HTML_FLAG_PLAIN; preview never updates' });
else { H.pass('1 MB paragraph: typed text appears', `${appeared} ms`); H.measure('1 MB paragraph: keystroke -> preview shows typed text', `${appeared} ms`, 'informational', true); }

// ---------------------------------------------------------------- G. errors
if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const realErr = app.consoleErrors.filter((e) => !/404|Failed to load resource|net::ERR/.test(e));
if (realErr.length) H.fail('console errors', { errors: realErr.slice(0, 5) }); else H.pass('no console errors');

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
