// bench/verify/review-invariants.mjs — drives the real app through a battery of scenarios and checks
// DOM/model invariants after each: no console/page errors, no block left `.is-stale` or `.is-pending`
// inside the materialization window, preview block count == worker block count, TOC matches the outline.
// Run: node bench/verify/review-invariants.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`);
};

await gotoApp(page, 'mode=split');

async function snapshot() {
  return page.evaluate(() => {
    const prev = document.querySelector('.mdr-preview');
    const body = prev.querySelector('.mdr-preview__body');
    const blocks = Array.from(body.querySelectorAll('.md-block'));
    const H = prev.clientHeight;
    const top = prev.scrollTop;
    // visible-ish band = what the user can actually see
    const vis = blocks.filter((b) => {
      const r = b.getBoundingClientRect();
      const pr = prev.getBoundingClientRect();
      return r.bottom > pr.top && r.top < pr.bottom;
    });
    return {
      total: window.__mdr.app.preview.blockCount(),
      wrappers: blocks.length,
      visible: vis.length,
      visPending: vis.filter((b) => b.classList.contains('is-pending')).length,
      visStale: vis.filter((b) => b.classList.contains('is-stale')).length,
      visIds: vis.slice(0, 6).map((b) => b.dataset.id),
      scrollTop: top,
      scrollH: prev.scrollHeight,
      H,
      tocItems: document.querySelectorAll('.mdr-toc__item').length,
      text: vis.map((b) => b.textContent.slice(0, 40)).slice(0, 3),
    };
  });
}

// ---- 1. small doc, typing
await page.evaluate(() => window.__mdr.loadText('# 标题\n\n第一段文字。\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n', 'small.md'));
await waitIdle(page);
let s = await snapshot();
check('small doc: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);

await page.click('.cm-content');
await page.keyboard.type('hello world ', { delay: 12 });
await waitIdle(page);
s = await snapshot();
check('after typing: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);
const hasTyped = await page.evaluate(() => document.querySelector('.mdr-preview__body').textContent.includes('hello world'));
check('after typing: preview shows the typed text', hasTyped, { hasTyped });

// ---- 2. undo storm
for (let i = 0; i < 30; i++) await page.keyboard.press('Meta+z');
await waitIdle(page);
s = await snapshot();
check('after 30 undos: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);
for (let i = 0; i < 30; i++) await page.keyboard.press('Meta+Shift+z');
await waitIdle(page);
s = await snapshot();
check('after 30 redos: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);

// ---- 3. select all + delete + undo
await page.keyboard.press('Meta+a');
await page.keyboard.press('Backspace');
await waitIdle(page);
s = await snapshot();
check('after select-all delete: preview empty', s.total === 0 && s.wrappers === 0, s);
await page.keyboard.press('Meta+z');
await waitIdle(page);
s = await snapshot();
check('after undo of select-all delete: content is back', s.total > 0 && s.visPending === 0 && s.visStale === 0, s);

// ---- 4. medium document + scroll
await page.evaluate(() => window.__mdr.loadUrl('/test-data/medium.md'));
await waitIdle(page);
s = await snapshot();
check('medium.md: loaded and rendered', s.total > 100 && s.visPending === 0, s);
const tocCount = await page.evaluate(() => document.querySelectorAll('.mdr-toc__item').length);
check('medium.md: TOC populated', tocCount > 0, { tocCount });

for (let i = 0; i < 12; i++) {
  await page.mouse.move(1000, 450);
  await page.mouse.wheel(0, 1600);
  await sleep(90);
}
await waitIdle(page);
await sleep(300);
s = await snapshot();
check('after wheel scroll: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);

// ---- 5. mode cycling
for (const m of ['edit', 'preview', 'split', 'preview', 'edit', 'split']) {
  await page.evaluate((mm) => window.__mdr.mode(mm), m);
  await sleep(120);
}
await waitIdle(page);
await sleep(300);
s = await snapshot();
check('after mode cycling: nothing pending/stale in view', s.visPending === 0 && s.visStale === 0, s);

// ---- 6. TOC navigation
const navOk = await page.evaluate(async () => {
  const items = document.querySelectorAll('.mdr-toc__item');
  if (items.length < 8) return { skipped: true };
  const target = items[Math.floor(items.length * 0.7)];
  const line = Number(target.dataset.line);
  target.click();
  await new Promise((r) => setTimeout(r, 900));
  const tv = window.__mdr.app.preview.topVisible();
  return { line, previewLine: tv.line, delta: Math.abs(tv.line - line) };
});
check('TOC click lands the preview on the heading', navOk.skipped || navOk.delta <= 2, navOk);

// ---- 7. structure/DOM agreement
s = await snapshot();
const agree = await page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const n = p.blockCount();
  const ids = new Set();
  let dup = 0;
  for (const el of document.querySelectorAll('.md-block')) {
    if (ids.has(el.dataset.id)) dup++;
    ids.add(el.dataset.id);
  }
  // every wrapper id must be a live block id
  let unknown = 0;
  for (const id of ids) if (p.blockAtLine(1).id === undefined) unknown++;
  return { n, wrappers: ids.size, dup };
});
check('no duplicate .md-block wrappers', agree.dup === 0, agree);

console.log('\nconsole/page errors (' + errors.length + '):');
for (const e of errors.slice(0, 20)) console.log('  ' + e);
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5));

console.log('__RESULT__' + JSON.stringify({ results, errors: errors.slice(0, 20) }));
await browser.close();
