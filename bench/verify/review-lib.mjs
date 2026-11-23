// bench/verify/review-lib.mjs — helpers for the static-review verifier scripts (port 5205, own server).
import { chromium } from '@playwright/test';

export const PORT = Number(process.env.PORT || 5205);
export const BASE = `http://localhost:${PORT}`;

export async function openPage(opts = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--enable-precise-memory-info'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...(opts.context ?? {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('crash', () => errors.push('[crash] page crashed'));
  const cdp = await context.newCDPSession(page);
  if (opts.cpuThrottle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpuThrottle });
  return { browser, context, page, cdp, errors };
}

export async function gotoApp(page, query = 'mode=split') {
  await page.goto(`${BASE}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
}

export async function loadDoc(page, name) {
  await page.evaluate(async (n) => { await window.__mdr.loadUrl(`/test-data/${n}`); }, name);
}

export async function waitIdle(page, timeout = 120000) {
  await page.evaluate(() => window.__mdr.waitIdle(), null, { timeout });
}

export async function waitFirstVisible(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const opens = performance.getEntriesByName('mdr:open');
    if (!opens.length) return false;
    const open = opens[opens.length - 1].startTime;
    return performance.getEntriesByName('mdr:first-visible').some((e) => e.startTime >= open);
  }, null, { timeout });
}

export async function marks(page) {
  return page.evaluate(() => {
    const out = {};
    for (const e of performance.getEntriesByType('mark')) if (e.name.startsWith('mdr:')) (out[e.name] ??= []).push(e.startTime);
    return out;
  });
}

/** Installs a rAF gap monitor + longtask observer; returns via readMonitor(). */
export async function installMonitor(page) {
  await page.evaluate(() => {
    const m = (window.__mon = { gaps: [], longtasks: [], loaf: [], running: true, last: performance.now() });
    const tick = () => {
      const t = performance.now();
      m.gaps.push(t - m.last);
      m.last = t;
      if (m.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) m.loaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration }); }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {}
  });
}
export async function resetMonitor(page) {
  await page.evaluate(() => { const m = window.__mon; m.gaps = []; m.longtasks = []; m.loaf = []; m.last = performance.now(); });
}
export async function readMonitor(page) {
  return page.evaluate(() => {
    const m = window.__mon;
    const gaps = m.gaps.slice(1);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
    return {
      frames: gaps.length,
      over20: gaps.filter((g) => g > 20).length,
      over50: gaps.filter((g) => g > 50).length,
      maxGap: sorted.length ? sorted[sorted.length - 1] : 0,
      p95: p(0.95),
      longtasks: m.longtasks.slice(),
      loaf: m.loaf.slice(),
    };
  });
}

export async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const o = {};
  for (const m of metrics) o[m.name] = m.value;
  return o;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pct = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
export const r1 = (n) => Math.round(n * 10) / 10;

export function report(name, results) {
  console.log(`\n=== ${name} ===`);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.value}  (target ${r.target})`);
}
