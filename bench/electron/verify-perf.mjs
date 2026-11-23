// bench/electron/verify-perf.mjs — VERIFIER: the SAME three measurements on large.md, run twice —
// once inside the packaged /Applications/MDReader.app and once in Chrome against the web build —
// so the desktop-vs-browser comparison is apples to apples.
//
//   node bench/electron/verify-perf.mjs
//
// Metrics (definitions copied from bench/perf.spec.ts):
//   open→first-visible   performance mark 'mdr:first-visible' − 'mdr:open'
//   keystroke→mount p95  'mount' perf samples attributed to the last keydown within 200 ms
//   scroll frame gaps    20 screens of wheel over the preview: slow-frame % and worst gap
//
// Both sides load ?perf=1 (the packaged renderer only installs window.__mdr under that flag, and the
// flag also enables the perf overlay — so both carry the same overlay cost).
import { chromium } from '@playwright/test';
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = process.env.MDR_APP || '/Applications/MDReader.app';
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
const PORT = Number(process.env.MDR_PORT || 5254);
const BASE = process.env.MDR_BASE || `http://localhost:${PORT}`;
const OWN_SERVER = !process.env.MDR_BASE;
const TYPED = 100;
const TYPE_INTERVAL_MS = 200;
const SCROLL_SCREENS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const results = {};
const notes = [];
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing */ }
}
async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function until(page, fn, arg, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}
const installFrameProbe = (page) => page.evaluate(() => {
  window.__frames = [];
  const tick = (ts) => { window.__frames.push(ts); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__keys = [];
  window.addEventListener('keydown', () => window.__keys.push(performance.now()), true);
});

/** The three measurements, identical on both engines. Assumes large.md is already open. */
async function measure(page, label) {
  const openMs = await page.evaluate(() => {
    const last = (n) => performance.getEntriesByName(n).at(-1)?.startTime ?? NaN;
    return last('mdr:first-visible') - last('mdr:open');
  });
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(600);
  await page.evaluate(() => window.__mdr.waitIdle());

  // --- keystroke → mount p95
  const midLine = await page.evaluate(() => Math.floor(window.__mdr.app.editor.lineCount() / 2));
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 0), midLine);
  await sleep(500);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => { window.__keys.length = 0; });
  const typeFrom = await page.evaluate(() => performance.now());
  const text = '性能测试 typing latency 中英混排 '.repeat(8).slice(0, TYPED);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(TYPE_INTERVAL_MS);
  }
  await sleep(600);
  const mount = await page.evaluate((from) => {
    const keys = window.__keys.filter((k) => k >= from);
    const out = [];
    for (const s of window.__mdr.samples()) {
      if (s.name !== 'mount' || s.at < from) continue;
      const k = keys.filter((t) => t <= s.at).at(-1);
      if (k !== undefined && s.at - k < 200) out.push(s.at - k);
    }
    return out;
  }, typeFrom);

  // --- 20 screens of scrolling over the preview
  const box = await page.evaluate(() => {
    const r = window.__mdr.app.preview.el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
  });
  await page.mouse.move(box.x, box.y);
  await sleep(300);
  const scrollFrom = await page.evaluate(() => performance.now());
  for (let i = 0; i < SCROLL_SCREENS * 4; i++) {
    await page.mouse.wheel(0, box.h / 4);
    await sleep(40);
  }
  await sleep(500);
  const scrollTo = await page.evaluate(() => performance.now());
  const frames = await page.evaluate(() => window.__frames.slice());
  const win = frames.filter((t) => t >= scrollFrom && t < scrollTo);
  const gaps = [];
  for (let i = 1; i < win.length; i++) gaps.push(win[i] - win[i - 1]);
  const slow = gaps.filter((g) => g > 20).length;
  const r = {
    openToFirstVisibleMs: Number(openMs.toFixed(1)),
    keyToMountP95Ms: Number(pct(mount, 95).toFixed(1)),
    keyToMountP50Ms: Number(pct(mount, 50).toFixed(1)),
    keyToMountMaxMs: Number((mount.length ? Math.max(...mount) : 0).toFixed(1)),
    mountSamples: mount.length,
    scrollFrames: gaps.length,
    scrollSlowFramePct: Number((gaps.length ? (100 * slow) / gaps.length : 0).toFixed(1)),
    scrollWorstGapMs: Number((gaps.length ? Math.max(...gaps) : 0).toFixed(1)),
    scrollGapP95Ms: Number(pct(gaps, 95).toFixed(1)),
  };
  console.log(`  ${label}: ${JSON.stringify(r)}`);
  return r;
}

let vite = null;
let app = null;
let browser = null;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-perf-'));

try {
  const big = path.join(tmp, 'large.md');
  await fsp.copyFile(path.join(ROOT, 'test-data', 'large.md'), big);
  const stat = await fsp.stat(big);
  const lines = (await fsp.readFile(big, 'utf8')).split('\n').length;
  note(`fixture: ${(stat.size / 1024 / 1024).toFixed(2)} MB, ${lines} lines`);

  // ================================================================ packaged app
  console.log('\n[1] packaged /Applications/MDReader.app');
  for (const run of [1, 2]) {
    app = await electron.launch({ executablePath: EXE, args: [] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.goto('app://mdreader/index.html?perf=1&mode=split');
    await until(page, () => !!window.__mdr, null, 40000);
    await installFrameProbe(page);
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, big);
    const got = await until(page, () => document.title.includes('large.md') && performance.getEntriesByName('mdr:first-visible').length > 0, null, 120000);
    if (!got) throw new Error('packaged app never opened large.md');
    results[`electron-run${run}`] = await measure(page, `electron run ${run}`);
    if (run === 2) {
      const mem = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, rssMB: Math.round(m.memory.workingSetSize / 1024) })));
      results.electronMemory = { byProcess: mem, totalMB: mem.reduce((s, m) => s + m.rssMB, 0) };
      note(`electron memory after large.md: ${mem.map((m) => `${m.type}=${m.rssMB} MB`).join(', ')} → total ${results.electronMemory.totalMB} MB`);
    }
    await app.evaluate(({ app: a }) => { a.exit(0); });
    await app.close().catch(() => {});
    app = null;
    await sleep(1500);
  }

  // ================================================================ Chrome
  console.log('\n[2] Chrome (Playwright chromium) against the web build');
  if (OWN_SERVER) {
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }
  for (const run of [1, 2]) {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?perf=1&mode=split`);
    await until(page, () => !!window.__mdr, null, 40000);
    await installFrameProbe(page);
    await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
    const got = await until(page, () => performance.getEntriesByName('mdr:first-visible').length > 0, null, 120000);
    if (!got) throw new Error('chrome never opened large.md');
    results[`chrome-run${run}`] = await measure(page, `chrome run ${run}`);
    if (run === 2) {
      const mem = await page.evaluate(() => performance.memory
        ? { usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576) }
        : null);
      results.chromeMemory = mem;
      note(`chrome JS heap after large.md: ${JSON.stringify(mem)} (renderer only — not comparable to Electron's whole-app RSS)`);
    }
    await browser.close();
    browser = null;
    await sleep(800);
  }

  console.log('\n=== comparison (median of 2 runs) ===');
  const med2 = (a, b, k) => Number((((a[k] + b[k]) / 2)).toFixed(1));
  const e1 = results['electron-run1'], e2 = results['electron-run2'];
  const c1 = results['chrome-run1'], c2 = results['chrome-run2'];
  const rows = [
    ['open→first-visible (ms)', med2(e1, e2, 'openToFirstVisibleMs'), med2(c1, c2, 'openToFirstVisibleMs')],
    ['keystroke→mount p95 (ms)', med2(e1, e2, 'keyToMountP95Ms'), med2(c1, c2, 'keyToMountP95Ms')],
    ['keystroke→mount p50 (ms)', med2(e1, e2, 'keyToMountP50Ms'), med2(c1, c2, 'keyToMountP50Ms')],
    ['scroll slow-frame %', med2(e1, e2, 'scrollSlowFramePct'), med2(c1, c2, 'scrollSlowFramePct')],
    ['scroll worst frame gap (ms)', med2(e1, e2, 'scrollWorstGapMs'), med2(c1, c2, 'scrollWorstGapMs')],
    ['scroll frame-gap p95 (ms)', med2(e1, e2, 'scrollGapP95Ms'), med2(c1, c2, 'scrollGapP95Ms')],
  ];
  console.log('metric'.padEnd(30), 'MDReader.app'.padEnd(14), 'Chrome');
  for (const [k, a, b] of rows) console.log(String(k).padEnd(30), String(a).padEnd(14), String(b));
  results.comparison = Object.fromEntries(rows.map(([k, a, b]) => [k, { electron: a, chrome: b }]));
} catch (err) {
  results.error = String(err && err.stack ? err.stack : err);
  console.error(err);
} finally {
  if (app) await app.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (vite) { try { process.kill(vite.pid, 'SIGKILL'); } catch { /* gone */ } killPort(PORT); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log('\n=== raw ===');
console.log(JSON.stringify(results, null, 2));
process.exit(results.error ? 1 : 0);
