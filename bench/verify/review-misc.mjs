// bench/verify/review-misc.mjs — static-review lens: user-visible effects of the findings.
//  A) setext heading containing `|` → rendered as <h2> in the preview but missing from TOC + export ids
//  B) AppHandle.dispose() leaves the layout shell (toolbar host, TOC nav + items, statusbar, overlay,
//     gutter) in the root and never disposes the TOC → re-running createApp duplicates the whole shell
//  C) statusbar 字符 must equal the document length
//  D) view.mountAll materialises the whole document
// Run: node bench/verify/review-misc.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';
import { readFileSync } from 'node:fs';

const { browser, page, errors } = await openPage();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };

await gotoApp(page, 'mode=split');

// ---------------------------------------------------------------- A
const DOC_A = '配置项 | 说明\n---\n\n正文。\n\n普通标题\n---\n\n尾巴。\n\n[去配置项](#配置项--说明)\n';
await page.evaluate((d) => window.__mdr.loadText(d, 'setext.md'), DOC_A);
await waitIdle(page);
await sleep(250);
const a = await page.evaluate(() => ({
  h2: Array.from(document.querySelectorAll('.mdr-preview h2')).map((e) => e.textContent),
  toc: Array.from(document.querySelectorAll('.mdr-toc__item')).map((e) => e.textContent),
}));
check('A: preview renders the pipe-bearing line as <h2>', a.h2.includes('配置项 | 说明'), a);
check('A: TOC lists every rendered <h2>', a.h2.every((t) => a.toc.includes(t)), a);

const [dlA] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml')),
]);
const htmlA = readFileSync(await dlA.path(), 'utf8');
const idsA = [...htmlA.matchAll(/<h2[^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
const h2A = [...htmlA.matchAll(/<h2[^>]*>([^<]*)</g)].map((m) => m[1]);
check('A: export gives every <h2> an id', idsA.length === h2A.length, { idsA, h2A });

// ---------------------------------------------------------------- C
await page.evaluate(() => window.__mdr.loadUrl('/test-data/small.md'));
await waitIdle(page);
await sleep(200);
const c = await page.evaluate(() => ({
  shown: document.querySelector('[data-stat=chars]').textContent,
  real: window.__mdr.app.getText().length,
  words: document.querySelector('[data-stat=words]').textContent,
}));
const shownChars = Number(/(\d+)/.exec(c.shown)?.[1]);
check('C: statusbar 字符 equals doc length', shownChars === c.real, { ...c, shownChars });

// ---------------------------------------------------------------- D
const d = await page.evaluate(async () => {
  const before = document.querySelectorAll('.md-block:not(.is-pending)').length;
  await window.__mdr.app.preview.mountAll();
  await new Promise((r) => setTimeout(r, 1500));
  return {
    before,
    total: window.__mdr.app.preview.blockCount(),
    wrappers: document.querySelectorAll('.md-block').length,
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
  };
});
check('D: mountAll materialises every block', d.mounted === d.total, d);

// ---------------------------------------------------------------- B
const b = await page.evaluate(async () => {
  const root = document.getElementById('app');
  const count = (sel) => root.querySelectorAll(sel).length;
  const before = {
    toolbar: count('.mdr-toolbar'), main: count('.mdr-main'), statusbar: count('.mdr-statusbar'),
    overlay: count('.mdr-overlay'), tocNav: count('.mdr-toc'), tocItems: count('.mdr-toc__item'),
    gutter: count('.mdr-gutter'), preview: count('.mdr-preview'),
  };
  window.__mdr.app.dispose();
  await new Promise((r) => setTimeout(r, 400));
  const after = {
    toolbar: count('.mdr-toolbar'), main: count('.mdr-main'), statusbar: count('.mdr-statusbar'),
    overlay: count('.mdr-overlay'), tocNav: count('.mdr-toc'), tocItems: count('.mdr-toc__item'),
    gutter: count('.mdr-gutter'), preview: count('.mdr-preview'),
  };
  return { before, after, hooks: !!window.__mdr };
});
check('B: dispose() removes the layout it created', b.after.toolbar === 0 && b.after.main === 0 && b.after.statusbar === 0 && b.after.overlay === 0 && b.after.tocNav === 0, b);

// and now re-create into the same root: does the shell duplicate?
const b2 = await page.evaluate(async () => {
  const mod = await import('/src/app/App.ts');
  const root = document.getElementById('app');
  await mod.createApp(root);
  await new Promise((r) => setTimeout(r, 800));
  const count = (sel) => root.querySelectorAll(sel).length;
  return {
    toolbar: count('.mdr-toolbar'), main: count('.mdr-main'), statusbar: count('.mdr-statusbar'),
    overlay: count('.mdr-overlay'), tocNav: count('.mdr-toc'), preview: count('.mdr-preview'), editor: count('.cm-editor'),
  };
});
check('B: createApp after dispose does not duplicate the shell', b2.toolbar === 1 && b2.main === 1 && b2.statusbar === 1 && b2.overlay === 1 && b2.tocNav === 1, b2);

console.log('\nconsole/page errors (' + errors.length + '):', errors.slice(0, 10));
console.log('__RESULT__' + JSON.stringify({ results, errors: errors.slice(0, 10) }));
await browser.close();
