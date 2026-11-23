// bench/verify/p13-step-attrib.mjs — attributes the huge.md renderer-memory growth to a single step:
// load → gotoLine(mid) → 1 keystroke → 4 more keystrokes, sampling the renderer footprint after each.
// Usage: node bench/verify/p13-step-attrib.mjs [huge|large] [mode]
import { execSync } from 'node:child_process';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, memory, dumpErrors, sleep, fmt } from './common.mjs';
const which = process.argv[2] ?? 'huge';
const MODE = process.argv[3] ?? 'split';
const mid = which === 'huge' ? 170003 : 50011;
const { browser, page, cdp, errors } = await launch();
const bcdp = await browser.newBrowserCDPSession();
const pids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
async function fp() {
  const ids = await pids();
  const rows = execSync('ps -axo pid,rss,command').toString().split('\n').slice(1).map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], rss: +m[2] / 1024 })).filter((r) => ids.includes(r.pid));
  return rows.map((r) => { let v = r.rss; try { const m = execSync(`footprint ${r.pid} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) v = +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1); } catch {} return v; }).sort((a, b) => b - a)[0] ?? 0;
}
async function s(label) {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
  await sleep(1500);
  const m = await memory(page, cdp);
  const f = await fp();
  console.log(`[${label}] footprint ${f.toFixed(0)} MB, page JS heap ${fmt(m.jsHeapUsedMB)} MB, DOM nodes ${m.nodes}`);
  return f;
}
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=${MODE}`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 120_000 });
  if (MODE !== 'edit') await waitFirstVisible(page, 120_000);
  await waitIdle(page).catch(() => {});
  await sleep(2000);
  await s('1 after load');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await sleep(400); await s('2 after editor.focus()');
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 1), mid);
  await sleep(1500); await s(`3 after gotoLine(${mid})`);
  await page.keyboard.press('ArrowRight'); await sleep(800); await s('4 after ArrowRight (no doc change)');
  await page.keyboard.type('a'); await sleep(1500); await s('5 after 1 keystroke');
  await page.keyboard.type('bcde', { delay: 150 }); await sleep(2000); await s('6 after 4 more keystrokes');
  await sleep(10000); await s('7 after 10 s idle');
} finally { dumpErrors(errors); await browser.close(); }
