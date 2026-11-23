// bench/verify/ux/06-grid.mjs — pane geometry per mode / toc state / viewport width.
// Run: node bench/verify/ux/06-grid.mjs
import { launch, open, step, expect, finish, sleep, getFailures } from './lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');
const geo = () => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return `${s.replace('.mdr-pane--','')}[x=${b.x.toFixed(0)} w=${b.width.toFixed(0)} h=${b.height.toFixed(0)} disp=${getComputedStyle(e).display}]`; };
  const app = document.querySelector('.mdr-app');
  return `mode=${app.dataset.mode} toc=${app.dataset.toc} vw=${innerWidth} :: ` + ['.mdr-pane--toc', '.mdr-pane--editor', '.mdr-gutter', '.mdr-pane--preview'].map(r).join(' ');
});
const pw = () => page.evaluate(() => document.querySelector('.mdr-pane--preview').getBoundingClientRect().width);
const ew = () => page.evaluate(() => document.querySelector('.mdr-pane--editor').getBoundingClientRect().width);
await step('split + toc open: both panes wide', async () => { const g = await geo(); expect((await ew()) > 300 && (await pw()) > 300, g); return g; });
await step('preview mode (toolbar button): preview pane fills width', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]'); await sleep(100);
  const g = await geo(); expect((await pw()) > 600, g); return g;
});
await step('edit mode: editor fills width', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.edit"]'); await sleep(100);
  const g = await geo(); expect((await ew()) > 600, g); return g;
});
await step('split + toc closed (Mod-Shift-o): editor and preview both wide', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]'); await page.click('.cm-content'); await page.keyboard.press('Meta+Shift+o'); await sleep(100);
  const g = await geo(); expect((await ew()) > 400 && (await pw()) > 400, g); return g;
});
await step('preview mode + toc closed: preview fills width', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]'); await sleep(100);
  const g = await geo(); expect((await pw()) > 1000, g); return g;
});
await step('split at 800px wide (toc auto-collapsed): panes wide', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]'); await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  await page.setViewportSize({ width: 800, height: 600 }); await sleep(200);
  const g = await geo(); expect((await ew()) > 300 && (await pw()) > 300, g); return g;
});
await page.screenshot({ path: '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots/grid-800-split.png' });
await page.setViewportSize({ width: 1400, height: 900 });
await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]'); await sleep(200);
await page.screenshot({ path: '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots/grid-preview-mode.png' });
finish('06-grid', errors); await browser.close(); process.exit(getFailures() ? 1 : 0);
