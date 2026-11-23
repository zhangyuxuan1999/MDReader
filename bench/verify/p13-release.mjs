// bench/verify/p13-release.mjs — in the app: after 100 preview jumps (+hard GC), does removing or
// replacing the formerly-mounted (now pending) wrappers release the retained nodes?
import { BASE, launch, waitFirstVisible, waitIdle, dumpErrors, sleep } from './common.mjs';
const { browser, page, cdp, errors } = await launch();
const nodes = async () => (await cdp.send('Memory.getDOMCounters')).nodes;
const gcHard = async () => { try { await cdp.send('Memory.prepareForLeakDetection'); } catch {} for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); } };
try {
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000); await waitIdle(page); await sleep(500);
  await page.evaluate(() => { window.__everMounted = new Set(); new MutationObserver((l) => { for (const m of l) if (m.type === 'attributes' && m.target.classList.contains('md-block') && !m.target.classList.contains('is-pending')) window.__everMounted.add(m.target); }).observe(document.querySelector('.mdr-preview__body'), { attributes: true, subtree: true, attributeFilter: ['class'] }); });
  const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  for (let i = 1; i <= 100; i++) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), Math.floor((lines * i) / 100)); await sleep(120); }
  await waitIdle(page); await sleep(2500); await gcHard();
  const n0 = await nodes();
  const st = await page.evaluate(() => ({ everMounted: window.__everMounted.size, pendingOfThose: [...window.__everMounted].filter((e) => e.classList.contains('is-pending')).length }));
  console.log(`[release] after jumps+GC: nodes ${n0}; wrappers ever mounted ${st.everMounted}, of which now pending ${st.pendingOfThose}`);
  // step 1: unobserve? not reachable. step 2: replace half of the formerly-mounted pending wrappers by shallow clones (same DOM position, no RO/display-lock history)
  await page.evaluate(() => { const arr = [...window.__everMounted].filter((e) => e.classList.contains('is-pending')); window.__half = arr.slice(0, Math.floor(arr.length / 2)); for (const e of window.__half) { const c = e.cloneNode(false); e.replaceWith(c); } });
  await sleep(300); await gcHard();
  const n1 = await nodes();
  console.log(`[release] after replacing ${await page.evaluate(() => window.__half.length)} formerly-mounted wrappers with shallow clones (old wrappers still referenced by JS): nodes ${n1} (Δ ${n1 - n0})`);
  await page.evaluate(() => { window.__half = null; });
  await gcHard();
  const n2 = await nodes();
  console.log(`[release] after dropping JS refs to those old wrappers + GC: nodes ${n2} (Δ ${n2 - n1})`);
} finally { dumpErrors(errors); await browser.close(); }
