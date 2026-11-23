// bench/verify/p13-fix.mjs — validate candidate fixes for the evicted-subtree retention: after 100
// preview jumps + GC, (A) on half of the formerly-mounted pending wrappers set content-visibility:
// visible, force layout, restore; (B) on the other half replace the wrapper with a shallow clone.
import { BASE, launch, waitFirstVisible, waitIdle, dumpErrors, sleep } from './common.mjs';
const { browser, page, cdp, errors } = await launch();
const nodes = async () => (await cdp.send('Memory.getDOMCounters')).nodes;
const gc = async () => { for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); } };
try {
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000); await waitIdle(page); await sleep(500);
  await page.evaluate(() => { window.__ever = new Set(); new MutationObserver((l) => { for (const m of l) if (m.type === 'attributes' && m.target.classList.contains('md-block') && !m.target.classList.contains('is-pending')) window.__ever.add(m.target); }).observe(document.querySelector('.mdr-preview__body'), { attributes: true, subtree: true, attributeFilter: ['class'] }); });
  const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  for (let i = 1; i <= 100; i++) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), Math.floor((lines * i) / 100)); await sleep(120); }
  await waitIdle(page); await sleep(2500); await gc();
  const n0 = await nodes();
  const cnt = await page.evaluate(() => { const arr = [...window.__ever].filter((e) => e.classList.contains('is-pending')); window.__a = arr.slice(0, arr.length >> 1); window.__b = arr.slice(arr.length >> 1); return [window.__a.length, window.__b.length]; });
  console.log(`[fix] after jumps+GC: nodes ${n0}; evicted wrappers: A=${cnt[0]} B=${cnt[1]}`);
  await page.evaluate(() => { for (const w of window.__a) w.style.contentVisibility = 'visible'; document.body.offsetHeight; for (const w of window.__a) w.style.contentVisibility = ''; document.body.offsetHeight; });
  await sleep(300); await gc();
  const n1 = await nodes();
  console.log(`[fix A] toggle content-visibility:visible + forced layout on ${cnt[0]} wrappers: nodes ${n1} (Δ ${n1 - n0})`);
  await page.evaluate(() => { for (const w of window.__b) w.replaceWith(w.cloneNode(false)); window.__b = null; window.__a = null; window.__ever = null; });
  await sleep(300); await gc();
  const n2 = await nodes();
  console.log(`[fix B] replace ${cnt[1]} wrappers with shallow clones: nodes ${n2} (Δ ${n2 - n1}); in-document baseline after load was ~43.5k`);
} finally { dumpErrors(errors); await browser.close(); }
