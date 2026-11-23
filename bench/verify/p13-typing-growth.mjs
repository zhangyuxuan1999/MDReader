// bench/verify/p13-typing-growth.mjs — isolates the renderer-memory growth seen in p13-huge.mjs:
// types in batches and samples the renderer process footprint, the page JS heap and (via a CDP
// session attached to the render worker target) the worker's own JS heap after a forced GC on both.
// Usage: node bench/verify/p13-typing-growth.mjs [huge|large] [batches] [charsPerBatch] [delayMs]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, memory, report, dumpErrors, sleep, fmt } from './common.mjs';

const which = process.argv[2] ?? 'huge';
const BATCHES = Number(process.argv[3] ?? 6);
const PER = Number(process.argv[4] ?? 100);
const DELAY = Number(process.argv[5] ?? 100);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : 170000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, cdp, errors } = await launch();
const bcdp = await browser.newBrowserCDPSession();
const rendererPids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
function footprint(pids) {
  const rows = execSync('ps -axo pid,rss,command').toString().split('\n').slice(1)
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: +m[1], rssMB: +m[2] / 1024 })).filter((r) => pids.includes(r.pid));
  return rows.map((r) => {
    let fp = null;
    try { const m = execSync(`footprint ${r.pid} 2>/dev/null`).toString().match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) fp = +m[1] * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1); } catch {}
    return { pid: r.pid, rssMB: r.rssMB, fp };
  }).sort((a, b) => (b.fp ?? b.rssMB) - (a.fp ?? a.rssMB))[0];
}

let wcdp = null;
async function workerHeapMB() {
  try {
    if (!wcdp) {
      const w = page.workers()[0];
      if (!w) return null;
      wcdp = await page.context().newCDPSession(w);
      await wcdp.send('HeapProfiler.enable');
    }
    await wcdp.send('HeapProfiler.collectGarbage');
    const r = await wcdp.send('Runtime.evaluate', { expression: '1', returnByValue: true });
    void r;
    // Runtime.getHeapUsage gives used/total size of the worker's isolate.
    const u = await wcdp.send('Runtime.getHeapUsage');
    return u.usedSize / 1048576;
  } catch (e) { return 'err ' + String(e.message).slice(0, 50); }
}

async function sample(label) {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
  const wh = await workerHeapMB();
  await sleep(700);
  const m = await memory(page, cdp);
  const f = footprint(await rendererPids());
  console.log(`[${label}] renderer footprint ${f ? (f.fp ?? f.rssMB).toFixed(0) : '?'} MB (rss ${f ? f.rssMB.toFixed(0) : '?'}), page JS heap ${fmt(m.jsHeapUsedMB)} MB, worker JS heap ${typeof wh === 'number' ? fmt(wh) + ' MB' : wh}, DOM nodes ${m.nodes}`);
  return { fp: f ? (f.fp ?? f.rssMB) : 0, heap: m.jsHeapUsedMB, worker: wh, nodes: m.nodes };
}

try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 120_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await sleep(800);
  const s = [await sample(`${which} after load (0 chars)`)];
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(600);
  const text = (n) => Array.from({ length: n }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  for (let b = 0; b < BATCHES; b++) {
    await page.keyboard.type(text(PER), { delay: DELAY });
    await sleep(800);
    s.push(await sample(`${which} after ${(b + 1) * PER} chars`));
  }
  // idle for 10 s and re-sample: distinguishes "GC lag" from "retained"
  await sleep(10_000);
  const after = await sample(`${which} after 10 s idle`);
  const blocks = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  console.log(`[growth] blocks=${blocks}; structure Int32Array per edit ≈ ${(blocks * 4 * 4 / 1048576).toFixed(2)} MB → ${(BATCHES * PER * blocks * 4 * 4 / 1073741824).toFixed(2)} GB allocated over ${BATCHES * PER} keystrokes`);
  console.log(`[growth] footprint curve: ${s.map((x) => x.fp.toFixed(0)).join(' → ')} → (idle) ${after.fp.toFixed(0)} MB`);
  report(`P13 ${which}.md renderer footprint after load + ${BATCHES * PER} keystrokes`, `${after.fp.toFixed(0)} MB (load was ${s[0].fp.toFixed(0)} MB)`, '< 450 MB', after.fp < 450);
} finally {
  dumpErrors(errors);
  await browser.close();
}
