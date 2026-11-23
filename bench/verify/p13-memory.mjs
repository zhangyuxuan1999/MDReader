// bench/verify/p13-memory.mjs — SUPERSEDED by p13-attrib.mjs (this file's ps filter also matched the
// Claude desktop app's Electron renderer; numbers from it are invalid).
// P13: large.md, load + 60 s typing (600 chars at 100 ms, mid-doc)
// + scroll to end; reports JS heap (CDP Performance.getMetrics), DOM nodes, and the renderer
// process RSS read from `ps` (the page cannot use measureUserAgentSpecificMemory without COOP/COEP).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, memory, report, dumpErrors, sleep, fmt } from './common.mjs';

const SECS = Number(process.argv[2] ?? 60);
const src = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
let target = 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const rendererRss = () => {
  const out = execSync('ps -axo pid,rss,command').toString().split('\n').filter((l) => /--type=renderer/.test(l) && /headless|chrom/i.test(l));
  const rows = out.map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], rssMB: +m[2] / 1024 }; });
  return rows.sort((a, b) => b.rssMB - a.rssMB);
};
const { browser, page, cdp, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await sleep(1000);
  const m0 = await memory(page, cdp);
  console.log(`[p13] after load: heap ${fmt(m0.jsHeapUsedMB)} MB used / ${fmt(m0.jsHeapTotalMB)} MB total, DOM nodes ${m0.nodes}; renderer RSS (all renderers, MB): ${rendererRss().map((r) => r.rssMB.toFixed(0)).join(', ')}`);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(500);
  const chars = SECS * 10;
  const text = Array.from({ length: chars }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  await page.keyboard.type(text, { delay: 100 });
  await sleep(1000);
  const m1 = await memory(page, cdp);
  console.log(`[p13] after ${SECS} s typing (${chars} chars): heap ${fmt(m1.jsHeapUsedMB)} MB, DOM nodes ${m1.nodes}; renderer RSS: ${rendererRss().map((r) => r.rssMB.toFixed(0)).join(', ')}`);
  // scroll to end (preview then editor), through the sync
  const pv = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 3000); await sleep(30); }
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(window.__mdr.app.editor.lineCount(), 0, 'instant'));
  await sleep(1500);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 0); });
  await sleep(3000);
  const m2 = await memory(page, cdp);
  const rss = rendererRss();
  const st = await page.evaluate(() => ({ mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, wrappers: document.querySelectorAll('.md-block').length, elements: document.getElementsByTagName('*').length, top: window.__mdr.app.preview.topVisible().line, etop: window.__mdr.app.editor.topVisible().line }));
  console.log(`[p13] after scroll to end: heap ${fmt(m2.jsHeapUsedMB)} MB used / ${fmt(m2.jsHeapTotalMB)} MB total, DOM nodes ${m2.nodes}, elements ${st.elements}, mounted ${st.mounted}/${st.wrappers}, preview top ${st.top}, editor top ${st.etop}; renderer RSS: ${rss.map((r) => r.rssMB.toFixed(0)).join(', ')}`);
  report('P13 renderer RSS after load + typing + scroll to end (largest renderer process)', `${rss[0]?.rssMB.toFixed(0)} MB (JS heap ${fmt(m2.jsHeapUsedMB)} MB, DOM nodes ${m2.nodes})`, '< 450 MB', (rss[0]?.rssMB ?? 1e9) < 450);
} finally {
  dumpErrors(errors);
  await browser.close();
}
