import { launch, open, loadText, step, expect, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');
await loadText(page, '# A\n\nx\n\n## B\n\ny\n', 'n.md');

const snap = () => page.evaluate(() => {
  const app = document.querySelector('.mdr-app');
  const pane = document.querySelector('.mdr-pane--toc');
  const btn = document.querySelector('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  const r = pane.getBoundingClientRect();
  return { w: innerWidth, dataToc: app.dataset.toc, paneW: Math.round(r.width), paneVisible: !!pane.getClientRects().length && r.width > 0,
           btnPressed: btn.getAttribute('aria-pressed'), btnActive: btn.classList.contains('is-active'), items: document.querySelectorAll('.mdr-toc__item').length };
});
for (const w of [1400, 1100, 1000, 900, 860, 820, 760, 600]) {
  await page.setViewportSize({ width: w, height: 800 });
  await sleep(350);
  console.log(w, JSON.stringify(await snap()));
}
await step('at a narrow width the TOC toggle still has an effect (or the button reflects reality)', async () => {
  await page.setViewportSize({ width: 820, height: 800 });
  await sleep(400);
  const before = await snap();
  expect(before.dataToc === 'open', `precondition: data-toc=${before.dataToc}`);
  expect(!before.paneVisible,
    `at 820px the TOC pane IS visible (${before.paneW}px) — skip`);
  // The pane is invisible but the app/button claim the TOC is open.
  expect(before.btnPressed !== 'true' && !before.btnActive,
    `at 820px the TOC is collapsed to ${before.paneW}px by CSS, yet the toolbar button reports aria-pressed=${before.btnPressed} / is-active=${before.btnActive} and data-toc=${before.dataToc} — the 显示/隐藏目录 control does nothing visible and lies about its state`);
});
await step('toggling TOC at a narrow width changes something visible', async () => {
  await page.setViewportSize({ width: 820, height: 800 });
  await sleep(300);
  const before = await snap();
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  await sleep(400);
  const after = await snap();
  expect(before.paneVisible !== after.paneVisible || before.paneW !== after.paneW,
    `clicking 显示/隐藏目录 at 820px changed nothing visible: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  return `${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
});
await page.setViewportSize({ width: 1400, height: 900 });
finish('12-narrow-toc', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
