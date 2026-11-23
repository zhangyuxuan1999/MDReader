// bench/verify/p13-huge-settled.mjs — P13 on huge.md (6.6 MB / 340k lines), the full spec flow:
// load + 60 s typing (600 chars @100 ms mid-doc) + scroll to end, then a 30 s settle with forced GC
// before the final reading (macOS `footprint` counts compressed/transient pages, so the peak during
// typing is not a fair "after" number). Reports peak and settled renderer footprint.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, memory, report, dumpErrors, sleep, fmt } from './common.mjs';
const which = process.argv[2] ?? 'huge';
const SECS = Number(process.argv[3] ?? 60);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'huge' ? 170000 : 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;
const { browser, page, cdp, errors } = await launch();
const bcdp = await browser.newBrowserCDPSession();
const pids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
async function fp() {
  const ids = await pids();
  const rows = execSync('ps -axo pid,rss,command').toString().split('\n').slice(1).map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], rss: +m[2] / 1024 })).filter((r) => ids.includes(r.pid));
  return rows.map((r) => { let v = r.rss; try { const m = execSync(`footprint ${r.pid} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) v = +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1); } catch {} return v; }).sort((a, b) => b - a)[0] ?? 0;
}
async function s(label, gc = true) {
  if (gc) { try { await cdp.send('HeapProfiler.collectGarbage'); } catch {} await sleep(1200); }
  const m = await memory(page, cdp);
  const f = await fp();
  console.log(`[${label}] footprint ${f.toFixed(0)} MB, page JS heap ${fmt(m.jsHeapUsedMB)} MB, DOM nodes ${m.nodes}`);
  return f;
}
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 120_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page); await sleep(2000);
  const load = await s('after load');
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(600);
  const chars = SECS * 10;
  await page.keyboard.type(Array.from({ length: chars }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join(''), { delay: 100 });
  await sleep(1000);
  const typed = await s(`after ${SECS} s typing (${chars} chars)`, false);
  const pv = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 3000); await sleep(30); }
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(window.__mdr.app.editor.lineCount(), 0, 'instant'));
  await sleep(2000);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 0); });
  await sleep(3000);
  const peak = await s('after scroll to end (peak, no settle)', false);
  let settled = peak;
  for (let i = 0; i < 6; i++) { await sleep(5000); settled = await s(`settle +${(i + 1) * 5}s`); }
  console.log(`[P13 ${which}] load ${load.toFixed(0)} → typing ${typed.toFixed(0)} → scroll ${peak.toFixed(0)} → settled ${settled.toFixed(0)} MB`);
  report(`P13 ${which}.md renderer footprint, peak during the flow`, `${Math.max(load, typed, peak).toFixed(0)} MB`, '< 450 MB', Math.max(load, typed, peak) < 450);
  report(`P13 ${which}.md renderer footprint, settled 30 s after the flow`, `${settled.toFixed(0)} MB`, '< 450 MB', settled < 450);
} finally { dumpErrors(errors); await browser.close(); }
