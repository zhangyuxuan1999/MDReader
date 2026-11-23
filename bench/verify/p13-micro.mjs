// bench/verify/p13-micro.mjs — isolate what retains children removed via replaceChildren() without JS
// wrappers: variants on about:blank, each: wrapper (+ optional content-visibility:auto / ResizeObserver
// / c-v parent chunk), fill with 20k nodes, force layout, replaceChildren(), (unobserve), hard GC,
// read Memory.getDOMCounters.nodes.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
const gc = async () => { for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await new Promise((r) => setTimeout(r, 200)); } };
const nodes = async () => (await cdp.send('Memory.getDOMCounters')).nodes;
await page.goto('about:blank');
const variants = [
  { name: 'plain div', cv: false, ro: false, chunk: false },
  { name: 'div content-visibility:auto', cv: true, ro: false, chunk: false },
  { name: 'div + ResizeObserver', cv: false, ro: true, chunk: false },
  { name: 'div c-v:auto + ResizeObserver', cv: true, ro: true, chunk: false },
  { name: 'div inside c-v:auto chunk (wrapper plain)', cv: false, ro: false, chunk: true },
  { name: 'div c-v:auto inside c-v:auto chunk + RO', cv: true, ro: true, chunk: true },
  { name: 'div c-v:auto, wrapper REMOVED after replaceChildren', cv: true, ro: false, chunk: false, removeWrapper: true },
];
for (const v of variants) {
  await page.evaluate(() => { document.body.innerHTML = ''; });
  await gc();
  const before = await nodes();
  await page.evaluate((v) => {
    const parent = document.createElement('div');
    if (v.chunk) parent.style.cssText = 'content-visibility:auto; contain-intrinsic-size:auto 500px';
    const w = document.createElement('section');
    if (v.cv) w.style.cssText = 'content-visibility:auto; contain-intrinsic-size:auto 100px';
    parent.appendChild(w); document.body.appendChild(parent);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 10000; i++) { const p = document.createElement('p'); p.appendChild(document.createTextNode('x' + i)); frag.appendChild(p); }
    w.replaceChildren(frag);
    w.getBoundingClientRect();
    const ro = v.ro ? new ResizeObserver(() => {}) : null; ro?.observe(w);
    window.__w = w; window.__ro = ro;
  }, v);
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__w.getBoundingClientRect());
  const filled = await nodes();
  await page.evaluate((v) => { window.__w.replaceChildren(); window.__ro?.unobserve(window.__w); if (v.removeWrapper) window.__w.remove(); window.__w = null; window.__ro = null; }, v);
  await gc();
  const after = await nodes();
  console.log(`[micro] ${v.name}: nodes before ${before}, filled ${filled}, after replaceChildren+GC ${after} → retained ${after - before}`);
}
await browser.close();
