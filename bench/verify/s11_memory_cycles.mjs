// s11 — memory growth after 10 load/unload cycles of large.md (JS heap via CDP after forced GC),
// plus DOM node count, live Worker count, ResizeObserver targets (indirect: mounted wrappers) and
// the number of .md-block wrappers after unload. Leak = final heap not within 30 % of the baseline.
// Run: node bench/verify/s11_memory_cycles.mjs
import { launch, open, settle, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('Performance.enable');

async function heapMB() {
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(200);
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await cdp.send('Performance.getMetrics');
  const get = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
  return { heap: +(get('JSHeapUsedSize') / 1048576).toFixed(1), total: +(get('JSHeapTotalSize') / 1048576).toFixed(1), nodes: get('Nodes'), listeners: get('JSEventListeners'), docs: get('Documents'), frames: get('Frames') };
}
const domInfo = () => page.evaluate(() => ({ all: document.getElementsByTagName('*').length, blocks: document.querySelectorAll('.md-block').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, workers: window.__workers.length, toc: document.querySelectorAll('.mdr-toc__item').length, cmLines: document.querySelectorAll('.cm-line').length }));

try {
  await open(page, '?mode=split');
  await settle(page, 30000);
  const large = await fetchTestDoc('large.md');
  // warm-up once so lazily-loaded modules (katex, language data) are not counted as growth
  await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'large.md'); }, large);
  await settle(page, 120000);
  await page.evaluate(async () => { await window.__mdr.loadText('', 'empty.md'); });
  await settle(page, 30000);
  await sleep(500);
  const base = await heapMB();
  const baseDom = await domInfo();
  C.measure('baseline after warm-up + unload: heap MB / nodes', `${base.heap} / ${base.nodes}`, 'informational', true);
  console.log('baseline', base, baseDom);

  const rows = [];
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'large.md'); }, large);
    let s = await settle(page, 120000);
    if (!s.ok) C.check(`cycle ${i}: load settles`, false, s);
    // scroll through a few positions so blocks get mounted/evicted, type a little
    for (const l of [20000, 60000, 100000, 500]) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), l); await sleep(250); }
    await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(40000, 0); ed.focus(); });
    await page.keyboard.type('cycle edit ', { delay: 0 });
    await settle(page, 60000);
    const loaded = await heapMB();
    await page.evaluate(async () => { await window.__mdr.loadText('', 'empty.md'); });
    s = await settle(page, 30000);
    await sleep(600);
    const after = await heapMB();
    const dom = await domInfo();
    rows.push({ i, loadedHeap: loaded.heap, afterHeap: after.heap, nodes: after.nodes, listeners: after.listeners, blocks: dom.blocks, workers: dom.workers, all: dom.all });
    console.log(`cycle ${i}: loaded ${loaded.heap} MB → unloaded ${after.heap} MB, nodes ${after.nodes}, listeners ${after.listeners}, DOM ${dom.all}, md-blocks ${dom.blocks}, workers ${dom.workers}`);
  }
  const last = rows[rows.length - 1];
  const ratio = last.afterHeap / base.heap;
  C.measure('heap after 10 load/unload cycles vs baseline (MB)', `${last.afterHeap} vs ${base.heap} (×${ratio.toFixed(2)})`, 'within +30 %', ratio <= 1.3);
  C.measure('DOM nodes after 10 cycles vs baseline', `${last.nodes} vs ${base.nodes}`, 'within +30 %', last.nodes <= base.nodes * 1.3 + 50);
  C.measure('event listeners after 10 cycles vs baseline', `${last.listeners} vs ${base.listeners}`, 'within +30 %', last.listeners <= base.listeners * 1.3 + 20);
  C.check('no leftover .md-block wrappers after unload', last.blocks === 0, `blocks=${last.blocks}`);
  C.check('exactly one Worker ever created (no restarts)', last.workers === 1, `workers=${last.workers}`);
  // monotonic growth check: heap after each unload
  const slope = (rows[9].afterHeap - rows[0].afterHeap) / 9;
  C.measure('heap growth per cycle (MB/cycle, after unload)', slope.toFixed(2), '≈ 0', Math.abs(slope) < 2);
  // loaded-state stability: heap while loaded should not grow either
  const slopeL = (rows[9].loadedHeap - rows[0].loadedHeap) / 9;
  C.measure('loaded-state heap growth per cycle (MB/cycle)', slopeL.toFixed(2), '≈ 0', Math.abs(slopeL) < 3);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s11 memory cycles', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
