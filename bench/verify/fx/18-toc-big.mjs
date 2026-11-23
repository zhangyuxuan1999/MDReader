import { launch, open, step, expect, finish, sleep, getFailures, cursor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(15000);
await open(page, '?doc=/test-data/large.md&mode=split');
await sleep(1200);
const info = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.mdr-toc__item')];
  const byLevel = {};
  for (const a of items) {
    const l = a.className.match(/--h(\d)/)?.[1] ?? '?';
    byLevel[l] ??= { total: 0, visible: 0 };
    byLevel[l].total++;
    if (a.getClientRects().length || a.offsetParent !== null) byLevel[l].visible++;
  }
  return { total: items.length, byLevel, navScrollH: document.querySelector('.mdr-toc')?.scrollHeight,
           hasCollapseUI: !!document.querySelector('.mdr-toc [aria-expanded], .mdr-toc__toggle, .mdr-toc details') };
});
console.log(JSON.stringify(info));
await step('SPEC §5.7: with > 3000 entries, levels >= 3 are collapsed by default', async () => {
  expect(info.total > 3000, `only ${info.total} entries — precondition not met`);
  const deep = Object.entries(info.byLevel).filter(([l]) => Number(l) >= 3).reduce((a, [, v]) => a + v.visible, 0);
  expect(deep === 0, `${deep} level>=3 TOC entries are rendered visible even though the outline has ${info.total} entries (SPEC §5.7 says they are collapsed by default); per level ${JSON.stringify(info.byLevel)}; collapse UI present: ${info.hasCollapseUI}`);
});
await step('TOC active item follows the cursor in a 3000-entry outline', async () => {
  const line = await page.evaluate(() => { const a = [...document.querySelectorAll('.mdr-toc__item')][1500]; return Number(a.dataset.line); });
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l + 1), line);
  await sleep(800);
  const act = await page.evaluate(() => document.querySelector('.mdr-toc__item.is-active')?.dataset.line);
  expect(Number(act) === line, `active=${act} want ${line}`);
  return `line ${line}`;
});
finish('18-toc-big', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
