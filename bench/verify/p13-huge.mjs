// bench/verify/p13-attrib.mjs — P13 memory, done with correct process identification: renderer
// processes are those listed by the browser-level CDP SystemInfo.getProcessInfo (type 'renderer'), never a
// ps grep for "--type=renderer" (that also matches Electron apps such as the Claude desktop app).
// Physical footprint from macOS `footprint <pid>` (falls back to ps RSS). Stages: about:blank, small,
// medium, large, huge (each after mdr:idle + GC), then large in edit / preview / split, then the real
// P13 flow: large.md split + 60 s typing (600 chars, 100 ms) + scroll to end. Also the render
// worker's JS heap when reachable via worker.evaluate(performance.memory).
// Usage: node bench/verify/p13-attrib.mjs [typingSeconds]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, memory, report, dumpErrors, sleep, fmt } from './common.mjs';

const SECS = Number(process.argv[2] ?? 60);
const src = readFileSync(new URL('../../test-data/huge.md', import.meta.url), 'utf8').split('\n');
let target = 170000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

function renderers(pids) {
  const rows = execSync('ps -axo pid,ppid,rss,command').toString().split('\n').slice(1).map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], rssMB: +m[3] / 1024, cmd: m[4] }));
  return rows.filter((r) => pids.includes(r.pid)).map((r) => {
    let fp = null;
    try { const m = execSync(`footprint ${r.pid} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) fp = +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1); } catch {}
    return { pid: r.pid, rssMB: r.rssMB, footprintMB: fp };
  }).sort((a, b) => (b.footprintMB ?? b.rssMB) - (a.footprintMB ?? a.rssMB));
}

const { browser, page, cdp, errors } = await launch();
const bcdp = await browser.newBrowserCDPSession();
const rendererPids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
const bpid = 'cdp';
const stage = async (label) => {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
  await sleep(800);
  const m = await memory(page, cdp);
  const rs = renderers(await rendererPids());
  let workerHeap = 'n/a';
  try { const w = page.workers()[0]; if (w) workerHeap = await w.evaluate(() => (performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'no performance.memory')); } catch (e) { workerHeap = 'err ' + e.message.slice(0, 40); }
  console.log(`[${label}] page JS heap ${fmt(m.jsHeapUsedMB)} MB (total ${fmt(m.jsHeapTotalMB)}), DOM nodes ${m.nodes}; worker heap ${workerHeap}; renderers of browser ${bpid}: ${rs.map((r) => `pid ${r.pid} footprint ${r.footprintMB === null ? 'n/a' : r.footprintMB.toFixed(0)} MB (rss ${r.rssMB.toFixed(0)})`).join(' | ') || 'none found'}`);
  return { m, rs, workerHeap };
};
const load = async (url, wait = true) => {
  await page.goto(url);
  if (!wait) return;
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  if (!/mode=edit/.test(url)) await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await sleep(500);
};
try {
  await warmUp(page);
  await load('about:blank', false);
  await stage('about:blank');
  for (const d of []) { await load(`${BASE}/?doc=/test-data/${d}.md&mode=split`); await stage(`${d}.md split`); }
  for (const mode of []) { await load(`${BASE}/?doc=/test-data/huge.md&mode=${mode}`); await stage(`large.md ${mode}`); }
  // real P13 flow
  await load(`${BASE}/?doc=/test-data/huge.md&mode=split`);
  const s0 = await stage('P13 after load (large split)');
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(500);
  const chars = SECS * 10;
  const text = Array.from({ length: chars }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  await page.keyboard.type(text, { delay: 100 });
  await sleep(500);
  const s1 = await stage(`P13 after ${SECS} s typing`);
  const pv = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 3000); await sleep(30); }
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(window.__mdr.app.editor.lineCount(), 0, 'instant'));
  await sleep(1500);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 0); });
  await sleep(2500);
  const s2 = await stage('P13 after scroll to end');
  const top = s2.rs[0];
  report('P13 renderer memory after load + typing + scroll to end', `${top ? (top.footprintMB ?? top.rssMB).toFixed(0) : 'n/a'} MB physical footprint (JS heap ${fmt(s2.m.jsHeapUsedMB)} MB, DOM nodes ${s2.m.nodes})`, '< 450 MB', !!top && (top.footprintMB ?? top.rssMB) < 450);
  console.log(`[P13] growth: load ${(s0.rs[0]?.footprintMB ?? 0).toFixed(0)} → typing ${(s1.rs[0]?.footprintMB ?? 0).toFixed(0)} → scroll ${(s2.rs[0]?.footprintMB ?? 0).toFixed(0)} MB`);
} finally {
  dumpErrors(errors);
  await browser.close();
}
