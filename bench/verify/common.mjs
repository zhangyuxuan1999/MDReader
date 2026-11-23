// bench/verify/common.mjs — shared helpers for the verifier scripts. Expects a dev server already
// running on :5201 (`npx vite --port 5201 --strictPort`).
import { chromium } from '@playwright/test';

export const BASE = process.env.MDR_BASE ?? 'http://localhost:5201';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export const max = (xs) => (xs.length ? Math.max(...xs) : 0);
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : String(n));

/** Pre-navigation probe: longtask + long-animation-frame observers, rAF frame timestamps,
 *  keydown timestamps, and a MessageChannel event-loop monitor that records every gap > 2 ms. */
export const PROBE_INIT = `
(() => {
  const probe = { longTasks: [], loaf: [], frames: [], keys: [], gaps: [], monitorOn: false };
  window.__probe = probe;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) probe.longTasks.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) probe.loaf.push({ start: e.startTime, dur: e.duration, blocking: e.blockingDuration, scripts: (e.scripts || []).map(s => ({ name: s.invoker || s.name, dur: s.duration })) }); })
      .observe({ type: 'long-animation-frame', buffered: true });
  } catch {}
  window.addEventListener('keydown', (e) => probe.keys.push({ t: performance.now(), key: e.key }), true);
  window.__probeFrames = (on) => {
    probe.framesOn = on;
    if (on && !probe.framesLoop) {
      probe.framesLoop = true;
      const tick = (ts) => { if (probe.framesOn) probe.frames.push(ts); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  };
  // Event-loop monitor: a MessageChannel ping-pong; any gap between two turns beyond the expected
  // sub-millisecond hop is time the main thread was busy (task or rendering).
  window.__probeMonitor = (on) => {
    probe.monitorOn = on;
    if (on && !probe.monitorLoop) {
      probe.monitorLoop = true;
      const ch = new MessageChannel();
      let last = performance.now();
      ch.port1.onmessage = () => {
        const now = performance.now();
        const gap = now - last;
        if (gap > 2) probe.gaps.push({ start: last, end: now, gap });
        last = now;
        if (probe.monitorOn) ch.port2.postMessage(0); else probe.monitorLoop = false;
      };
      ch.port2.postMessage(0);
    }
  };
})();
`;

export async function launch({ headless = true, width = 1400, height = 900, cpuThrottle = 1 } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(PROBE_INIT);
  const page = await context.newPage();
  const errors = { console: [], page: [], warnings: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') errors.console.push(m.text());
    else if (m.type() === 'warning') errors.warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.page.push(String(e?.stack ?? e)));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  return { browser, context, page, cdp, errors };
}

/** Warm up Vite's dep pre-bundling so the measured load is not skewed by a reload. */
export async function warmUp(page, url = `${BASE}/?doc=/test-data/small.md&mode=split`) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await sleep(2500);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
}

export async function waitFirstVisible(page, timeout = 60_000) {
  await page.waitForFunction(() => {
    const open = performance.getEntriesByName('mdr:open').at(-1)?.startTime ?? -1;
    const fv = performance.getEntriesByName('mdr:first-visible').at(-1)?.startTime ?? -1;
    return open >= 0 && fv >= open;
  }, null, { timeout });
  return page.evaluate(() => {
    const open = performance.getEntriesByName('mdr:open').at(-1).startTime;
    const st = performance.getEntriesByName('mdr:structure').filter((e) => e.startTime >= open)[0]?.startTime ?? -1;
    const fv = performance.getEntriesByName('mdr:first-visible').at(-1).startTime;
    return { open, structure: st < 0 ? null : st - open, firstVisible: fv - open };
  });
}

export async function waitIdle(page, timeout = 120_000) {
  await page.evaluate(() => window.__mdr.waitIdle().then(() => { window.__idleDone = true; }));
  await page.waitForFunction(() => window.__idleDone === true, null, { timeout });
  await page.evaluate(() => { window.__idleDone = false; });
  return page.evaluate(() => {
    const open = performance.getEntriesByName('mdr:open').at(-1).startTime;
    const idle = performance.getEntriesByName('mdr:idle').at(-1).startTime;
    return idle - open;
  });
}

export const readProbe = (page) => page.evaluate(() => {
  const p = window.__probe;
  return { longTasks: p.longTasks, loaf: p.loaf, frames: p.frames, keys: p.keys, gaps: p.gaps };
});
export const resetProbe = (page) => page.evaluate(() => {
  const p = window.__probe;
  p.longTasks.length = 0; p.loaf.length = 0; p.frames.length = 0; p.keys.length = 0; p.gaps.length = 0;
});

export async function memory(page, cdp) {
  const m = await cdp.send('Performance.getMetrics');
  const get = (n) => m.metrics.find((x) => x.name === n)?.value;
  const uas = await page.evaluate(async () => {
    try { if (performance.measureUserAgentSpecificMemory) { const r = await performance.measureUserAgentSpecificMemory(); return r.bytes; } } catch (e) { return 'n/a: ' + e.message; }
    return 'n/a';
  });
  return { jsHeapUsedMB: get('JSHeapUsedSize') / 1048576, jsHeapTotalMB: get('JSHeapTotalSize') / 1048576, nodes: get('Nodes'), uaSpecificMB: typeof uas === 'number' ? uas / 1048576 : uas };
}

export function report(name, value, target, pass) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${value}  (target ${target})`);
  return { name, value: String(value), target, pass };
}

export function dumpErrors(errors) {
  if (errors.console.length) console.log('CONSOLE ERRORS:', errors.console.slice(0, 10));
  if (errors.page.length) console.log('PAGE ERRORS:', errors.page.slice(0, 5));
  if (errors.warnings.length) console.log('WARNINGS:', errors.warnings.slice(0, 10));
}
