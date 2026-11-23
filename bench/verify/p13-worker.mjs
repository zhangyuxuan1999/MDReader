// bench/verify/p13-worker.mjs — attribute P13 memory: read the render worker's OWN V8 heap through a
// raw DevTools WebSocket (Chromium launched with --remote-debugging-port=9333; /json lists the
// dedicated worker target; Runtime.getHeapUsage after HeapProfiler.collectGarbage), alongside the
// page heap and the renderer's physical footprint, at: after load+idle, after scrolling the preview
// through ~200 screens (back-fill + cache growth), and after 20 s typing.
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { BASE, PROBE_INIT, waitFirstVisible, waitIdle, sleep, fmt } from './common.mjs';

const PORT = 9333;
const which = process.argv[2] ?? 'large';
const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(PROBE_INIT);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const bcdp = await browser.newBrowserCDPSession();

async function workerHeap() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const w = targets.find((t) => t.type === 'worker' && /render\.worker/.test(t.url));
  if (!w) return { error: 'no worker target: ' + targets.map((t) => t.type + ':' + t.url.slice(0, 60)).join(', ') };
  const ws = new WebSocket(w.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('HeapProfiler.collectGarbage');
  await sleep(300);
  const r = await send('Runtime.getHeapUsage');
  ws.close();
  return { usedMB: r.result.usedSize / 1048576, totalMB: r.result.totalSize / 1048576 };
}
function footprint() {
  return bcdp.send('SystemInfo.getProcessInfo').then(({ processInfo }) => processInfo.filter((p) => p.type === 'renderer').map((p) => {
    try { const m = execSync(`footprint ${p.id} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); return { pid: p.id, MB: m ? +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) : null }; } catch { return { pid: p.id, MB: null }; }
  }).sort((a, b) => (b.MB ?? 0) - (a.MB ?? 0)));
}
async function stage(label) {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
  await sleep(500);
  const m = await cdp.send('Performance.getMetrics');
  const get = (n) => m.metrics.find((x) => x.name === n)?.value;
  const wh = await workerHeap();
  const fp = await footprint();
  const st = await page.evaluate(() => ({ mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, elements: document.getElementsByTagName('*').length }));
  console.log(`[${label}] page heap ${fmt(get('JSHeapUsedSize') / 1048576)} MB, DOM nodes ${get('Nodes')} (elements ${st.elements}, mounted ${st.mounted}); worker heap ${wh.error ?? `${fmt(wh.usedMB)} MB used / ${fmt(wh.totalMB)} MB total`}; renderer footprint ${fp.map((f) => `${f.pid}: ${f.MB === null ? 'n/a' : f.MB.toFixed(0)} MB`).join(', ')}`);
}
try {
  await page.goto(`${BASE}/?doc=/test-data/small.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await sleep(2000);
  await stage('small.md warm-up');
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await sleep(1000);
  await stage(`${which}.md after load + idle`);
  // scroll the preview through the document in 200 jumps of ~half a screen? use 100 jumps of 1% each so many blocks get requested
  const lines = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  for (let i = 1; i <= 100; i++) { await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), Math.floor((lines * i) / 100)); await sleep(120); }
  await waitIdle(page);
  await sleep(1000);
  await stage(`${which}.md after 100 preview jumps through the doc`);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), Math.floor(lines / 2));
  await sleep(500);
  await page.keyboard.type(Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''), { delay: 100 });
  await sleep(1000);
  await stage(`${which}.md after 200 chars typed`);
} finally {
  if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
  await browser.close();
}
