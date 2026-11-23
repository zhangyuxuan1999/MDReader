// bench/verify/review-interactions.mjs — line mapping of preview interactions (SPEC §5.6):
// checkbox write-back, Alt+click → source line, #anchor resolution, plus export-HTML correctness.
// Run: node bench/verify/review-interactions.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';
import { readFileSync } from 'node:fs';

const { browser, page, errors } = await openPage();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };

await gotoApp(page, 'mode=split');

// 1-based source lines are in the comment after each line
const DOC = [
  '# 一级标题',            // 1
  '',                      // 2
  '正文段落。',            // 3
  '',                      // 4
  '- [ ] 任务甲',          // 5
  '- [ ] 任务乙',          // 6
  '- [x] 任务丙',          // 7
  '',                      // 8
  '> 引用第一行',          // 9
  '> 引用第二行',          // 10
  '',                      // 11
  '| a | b |',             // 12
  '| --- | --- |',         // 13
  '| 1 | 2 |',             // 14
  '| 3 | 4 |',             // 15
  '',                      // 16
  '## 二级 标题 B',        // 17
  '',                      // 18
  '[跳转](#二级-标题-b)',  // 19
  '',                      // 20
  '段落最后。',            // 21
  '',
].join('\n');

await page.evaluate((d) => window.__mdr.loadText(d, 'interactions.md'), DOC);
await waitIdle(page);
await sleep(200);

// ---- checkbox write-back ------------------------------------------------
for (const [nth, wantLine] of [[0, 5], [1, 6], [2, 7]]) {
  const r = await page.evaluate(async (n) => {
    const boxes = document.querySelectorAll('.mdr-preview input[type=checkbox]');
    if (boxes.length <= n) return { missing: true, count: boxes.length };
    let got = null;
    const off = window.__mdr.app.bus.on('source:edit', (e) => { got = e; });
    boxes[n].click();
    await new Promise((r2) => setTimeout(r2, 150));
    off();
    return { got, text: window.__mdr.app.getText() };
  }, nth);
  check(`checkbox ${nth} maps to source line ${wantLine}`, !r.missing && r.got && r.got.line === wantLine, r.got ?? r);
}
// the three toggles should have flipped exactly those boxes
const afterToggles = await page.evaluate(() => window.__mdr.app.getText().split('\n').slice(4, 7));
check('checkbox clicks flipped the right lines', JSON.stringify(afterToggles) === JSON.stringify(['- [x] 任务甲', '- [x] 任务乙', '- [ ] 任务丙']), afterToggles);

// restore
await page.evaluate((d) => window.__mdr.loadText(d, 'interactions.md'), DOC);
await waitIdle(page);
await sleep(150);

// ---- Alt+click → source line -------------------------------------------
const altCases = [
  ['h1', '.md-block[data-id] h1', 1],
  ['第一段', 'p', 3],
  ['quote', 'blockquote', 9],
  ['table row 2', 'table tbody tr:nth-child(2)', 15],
];
for (const [label, sel, wantLine] of altCases) {
  const r = await page.evaluate(async (s) => {
    const el = document.querySelector('.mdr-preview ' + s);
    if (!el) return { missing: true };
    let got = null;
    const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { got = e; });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    await new Promise((r2) => setTimeout(r2, 120));
    off();
    return { got };
  }, sel);
  check(`Alt+click on ${label} → line ${wantLine}`, !!r.got && r.got.line === wantLine, r.got ?? r);
}

// ---- #anchor resolution -------------------------------------------------
const anchor = await page.evaluate(async () => {
  const a = Array.from(document.querySelectorAll('.mdr-preview a[href^="#"]'))[0];
  if (!a) return { missing: true };
  let got = null;
  const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { got = e; });
  a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
  off();
  return { href: a.getAttribute('href'), got, outline: window.__mdr.app.preview.blockCount() };
});
check('#anchor link resolves to the heading line 17', !!anchor.got && anchor.got.line === 17, anchor);

// ---- relative link toast ------------------------------------------------
await page.evaluate((d) => window.__mdr.loadText(d, 'rel.md'), '[rel](./other.md)\n');
await waitIdle(page);
await sleep(150);
const rel = await page.evaluate(async () => {
  const a = document.querySelector('.mdr-preview a[href]');
  a?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
  return { toast: document.querySelector('.mdr-toast__text')?.textContent ?? null };
});
check('relative link shows the zh-CN toast', rel.toast === '暂不支持打开相对链接', rel);

// ---- export HTML --------------------------------------------------------
const EXPORT_DOC = '# 导出标题\n\n段落 $E = mc^2$ 行内公式。\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n## 导出标题\n\n```js\nconst a = 1;\n```\n\n<img src=x onerror="window.__pwn=1">\n\n[到第二个](#导出标题-1)\n';
await page.evaluate((d) => window.__mdr.loadText(d, 'export.md'), EXPORT_DOC);
await waitIdle(page);
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml')),
]);
const html = readFileSync(await dl.path(), 'utf8');
const ids = [...html.matchAll(/<h[1-6][^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
check('export: heading ids deduped', JSON.stringify(ids) === JSON.stringify(['导出标题', '导出标题-1']), ids);
check('export: no <script> / onerror survives', !/<script/i.test(html) && !/onerror=/i.test(html), { script: /<script/i.test(html), onerror: /onerror=/i.test(html) });
check('export: katex present once per formula (no MathML duplicate)', !/<annotation/.test(html) && /katex/.test(html), { annotation: /<annotation/.test(html), katex: /katex/.test(html) });
check('export: code fence highlighted', /class="hljs/.test(html) || /md-code/.test(html), { hljs: /class="hljs/.test(html) });
check('export: standalone (no external css link)', !/<link[^>]+stylesheet/i.test(html), { size: html.length });

console.log('\nconsole/page errors (' + errors.length + '):', errors.slice(0, 10));
console.log('__RESULT__' + JSON.stringify({ results, errors: errors.slice(0, 10) }));
await browser.close();
