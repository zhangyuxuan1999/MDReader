// bench/verify/v5-chc-ringdoc.mjs — challenge-c: does the step ring (fix-session-f A1) keep a REPLACED document alive?
// Opens test-data/huge.md (10.6 MB), then a small document (a document replacement: the ring keeps the document before
// it), forces GC through CDP and reads the JS heap; then 3 more small documents. Candidate against 0.1.1.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-ringdoc.mjs cand  |  MDR_BASE_PORT=5497 ... base
import { readFileSync } from 'node:fs';
import { openPage, load, sleep, J } from './v5-chc-lib.mjs';
const target = process.argv[2] || 'cand';
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 110000);
const HUGE = readFileSync(new URL('../../test-data/huge.md', import.meta.url), 'utf8');
const { browser, page } = await openPage(target);
try {
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Runtime.getHeapUsage'); return Math.round(m.usedSize / 1048576); };
  const h0 = await heap();
  await load(page, HUGE, 'huge.md'); await sleep(1500);
  const h1 = await heap();
  await load(page, 'small one\n', 's1.md'); await sleep(1500);
  const h2 = await heap();
  for (let i = 0; i < 3; i++) { await load(page, `small ${i}\n`, `s${i + 2}.md`); await sleep(500); }
  const h3 = await heap();
  console.log(J({ target, startMB: h0, withHugeMB: h1, afterSmallMB: h2, after3moreMB: h3 }));
} finally { clearTimeout(killer); await browser.close(); }
