// bench/verify/ux/16-narrow-toc.mjs — at ≤ 900 px the TOC auto-collapses: does the TOC button / Mod-Shift-o
// still do something visible (or at least reflect that the TOC cannot be shown)?  Also: toolbar
// theme-button state, and the 640 px preview top offset.
// Run: node bench/verify/ux/16-narrow-toc.mjs
import { launch, open, step, expect, check, finish, sleep, getFailures } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const { browser, page, errors } = await launch({ viewport: { width: 800, height: 600 } });
await open(page, '?doc=/test-data/small.md&mode=split');

const tocState = () => page.evaluate(() => {
  const toc = document.querySelector('.mdr-pane--toc');
  const r = toc.getBoundingClientRect();
  const btn = document.querySelector('[data-cmd="view.toggleToc"]');
  return { dataToc: document.querySelector('.mdr-app').dataset.toc, w: +r.width.toFixed(0), display: getComputedStyle(toc).display, pressed: btn.getAttribute('aria-pressed'), ls: localStorage.getItem('mdr.toc') };
});

await step('800 px: TOC auto-collapsed; toolbar button state + clicking it', async () => {
  const a = await tocState();
  await page.click('[data-cmd="view.toggleToc"]');
  await sleep(150);
  const b = await tocState();
  await page.click('[data-cmd="view.toggleToc"]');
  await sleep(150);
  const c = await tocState();
  await page.screenshot({ path: `${OUT}/narrow-800-toc-toggle.png` });
  // A visible change OR an honest disabled/unpressed state is acceptable; "pressed=true but nothing shown" is not.
  const honest = (a.w === 0 && a.pressed !== 'true') || b.w > 0;
  check('TOC button at 800 px either shows the TOC or does not claim it is shown (aria-pressed)', honest, `before ${JSON.stringify(a)} → click ${JSON.stringify(b)} → click ${JSON.stringify(c)}`);
  return `${JSON.stringify(a)} → ${JSON.stringify(b)} → ${JSON.stringify(c)}`;
});
await step('Widen to 1400: TOC comes back and reflects the persisted state', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(200);
  const s = await tocState();
  expect(s.w > 100 || s.dataToc === 'closed', JSON.stringify(s));
  return JSON.stringify(s);
});

finish('16-narrow-toc', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
