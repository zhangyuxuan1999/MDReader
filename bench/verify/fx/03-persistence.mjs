// Persistence of mode / toc / theme / split across reload, with NO query params.
import { launch, step, expect, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(8000);
const BASE = 'http://localhost:5203/';
const boot = async (q = '') => {
  await page.goto(BASE + q);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(200);
};
const st = () => page.evaluate(() => ({
  mode: document.querySelector('.mdr-app').dataset.mode,
  toc: document.querySelector('.mdr-app').dataset.toc,
  tocVisible: !!document.querySelector('.mdr-pane--toc')?.getClientRects().length,
  theme: document.documentElement.dataset.theme,
  split: document.querySelector('.mdr-main') && getComputedStyle(document.querySelector('.mdr-main')).getPropertyValue('--split'),
  ls: { mode: localStorage.getItem('mdr.mode'), toc: localStorage.getItem('mdr.toc'), theme: localStorage.getItem('mdr.theme'), split: localStorage.getItem('mdr.split') },
}));

await boot();
console.log('initial', JSON.stringify(await st()));

await step('mode persists across reload (no ?mode)', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(250);
  const a = await st();
  expect(a.mode === 'preview', `set failed: ${JSON.stringify(a)}`);
  await boot();
  const b = await st();
  expect(b.mode === 'preview', `after reload: ${JSON.stringify(b)}`);
});

await step('TOC hidden state persists across reload', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  await sleep(200);
  const before = await st();
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  await sleep(250);
  const a = await st();
  expect(a.toc !== before.toc, `toggle did nothing: ${before.toc} -> ${a.toc}`);
  expect(a.tocVisible === false, `toc pane still visible: ${JSON.stringify(a)}`);
  await boot();
  const b = await st();
  expect(b.toc === a.toc, `after reload toc=${b.toc} want ${a.toc}`);
  expect(b.tocVisible === false, `after reload toc visible: ${JSON.stringify(b)}`);
  // restore
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  await sleep(200);
});

await step('theme persists across reload and is set before first paint', async () => {
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]');
  await sleep(250);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(t0 !== t1, `theme did not change (${t1})`);
  await page.goto(BASE, { waitUntil: 'commit' });
  const early = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), rs: document.readyState, mdr: !!window.__mdr }));
  expect(early.attr === t1, `right after commit data-theme=${early.attr} want ${t1} (readyState=${early.rs}, __mdr=${early.mdr})`);
  return JSON.stringify(early);
});

await step('?mode= query param overrides stored mode (documented)', async () => {
  await boot('?mode=edit');
  const a = await st();
  expect(a.mode === 'edit', JSON.stringify(a));
  return `stored=${a.ls.mode}, active=${a.mode}`;
});

// ---- split gutter drag persists --split ----
await step('gutter drag changes and persists --split', async () => {
  await boot('?mode=split');
  const g = await page.locator('.mdr-gutter').boundingBox();
  expect(g, 'no .mdr-gutter');
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - 200, g.y + g.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(300);
  const a = await st();
  expect(a.ls.split, `LS mdr.split not written (state=${JSON.stringify(a)})`);
  const widths = await page.evaluate(() => ({ ed: document.querySelector('.mdr-pane--editor').getBoundingClientRect().width, pv: document.querySelector('.mdr-pane--preview').getBoundingClientRect().width }));
  await boot('?mode=split');
  const b = await st();
  const widths2 = await page.evaluate(() => ({ ed: document.querySelector('.mdr-pane--editor').getBoundingClientRect().width, pv: document.querySelector('.mdr-pane--preview').getBoundingClientRect().width }));
  expect(Math.abs(widths.ed - widths2.ed) < 3, `editor width ${widths.ed} -> ${widths2.ed} after reload (LS split=${b.ls.split})`);
  return `split=${a.ls.split} widths ${JSON.stringify(widths)} -> ${JSON.stringify(widths2)}`;
});

finish('03-persistence', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
