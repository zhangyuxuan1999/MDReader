// bench/verify/p13-nodes.mjs — where do the ~180k extra Blink nodes live after preview jumps?
// In-document census with a TreeWalker (all node types) by container, vs CDP Memory.getDOMCounters.
import { BASE, launch, waitFirstVisible, waitIdle, dumpErrors, sleep } from './common.mjs';
const JUMPS = Number(process.argv[2] ?? 100);
const { browser, page, cdp, errors } = await launch();
const census = () => page.evaluate(() => {
  const count = (root) => { let n = 0, text = 0, el = 0, attr = 0; const w = document.createTreeWalker(root, NodeFilter.SHOW_ALL); let c = w.currentNode; while (c) { n++; if (c.nodeType === 3) text++; else if (c.nodeType === 1) { el++; attr += c.attributes.length; } c = w.nextNode(); } return { n, text, el, attr }; };
  const body = document.querySelector('.mdr-preview__body');
  const cm = document.querySelector('.cm-content');
  const pend = [...document.querySelectorAll('.md-block.is-pending')].reduce((a, e) => a + e.childNodes.length, 0);
  return { document: count(document), previewBody: count(body), cmContent: count(cm), pendingChildNodes: pend, pending: document.querySelectorAll('.md-block.is-pending').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, chunks: document.querySelectorAll('.md-chunk').length, imgs: document.images.length, shadowHosts: [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length };
});
const counters = () => cdp.send('Memory.getDOMCounters');
const gcHard = async () => { try { await cdp.send('Memory.prepareForLeakDetection'); } catch {} for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); } };
try {
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await sleep(1000); await gcHard();
  console.log('[nodes] after load:', JSON.stringify(await counters()), JSON.stringify(await census()));
  const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  for (let i = 1; i <= JUMPS; i++) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), Math.floor((lines * i) / JUMPS)); await sleep(120); }
  await waitIdle(page); await sleep(2500); await gcHard();
  console.log('[nodes] after jumps+GC:', JSON.stringify(await counters()), JSON.stringify(await census()));
  // does a mode switch to edit (preview hidden) or a setDoc release them?
  await page.evaluate(() => window.__mdr.app.preview.setVisible(false)); await sleep(500); await gcHard();
  console.log('[nodes] preview hidden + GC:', JSON.stringify(await counters()));
  await page.evaluate(() => window.__mdr.app.preview.setVisible(true)); await sleep(500);
  await page.evaluate(() => window.__mdr.loadText('# tiny\n\nhello\n', 'tiny.md')); await sleep(1500); await gcHard();
  console.log('[nodes] after loadText(tiny) + GC:', JSON.stringify(await counters()), JSON.stringify(await census()));
} finally { dumpErrors(errors); await browser.close(); }
