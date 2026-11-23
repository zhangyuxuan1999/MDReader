// bench/verify/p5-control.mjs — control experiment for P5: (1) idle baseline of the MessageChannel
// monitor (busy per 100 ms window with no input), (2) direct view.dispatch cost per keystroke on
// small.md / large.md / huge.md, (3) Event Timing API entries (keydown/keypress/input, threshold 16 ms)
// and long tasks while typing. No CPU-heavy probes are active during the typing phase except the
// dispatch wrapper and the Event Timing observer.
// Usage: node bench/verify/p5-control.mjs [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, dumpErrors, sleep, fmt, pct, max, mean } from './common.mjs';

const CHARS = Number(process.argv[2] ?? 40);
const DELAY = Number(process.argv[3] ?? 100);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
const pickLine = (which) => {
  const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
  let t = which === 'large' ? 50000 : Math.floor(src.length / 2);
  while (t < src.length && !(isProse(src[t - 1]) && src[t - 2] === '' && src[t] === '')) t++;
  return { line: t, text: src[t - 1] };
};

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  // ---- (1) idle baseline of the monitor on large.md
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), pickLine('large').line);
  await sleep(1000);
  await page.evaluate(() => window.__probeMonitor(true));
  await resetProbe(page);
  const b0 = await page.evaluate(() => performance.now());
  await sleep(3000);
  const b1 = await page.evaluate(() => performance.now());
  await page.evaluate(() => window.__probeMonitor(false));
  const base = await readProbe(page);
  const win = [];
  for (let s = b0; s + 100 <= b1; s += 100) { let w = 0; for (const g of base.gaps) if (g.end > s && g.start < s + 100) w += g.gap; win.push(w); }
  console.log(`[control] monitor idle baseline (large.md, focused editor, no input): busy per 100 ms p50 ${fmt(pct(win, 50))} p95 ${fmt(pct(win, 95))} max ${fmt(max(win))} ms; gaps>2ms n=${base.gaps.length}`);

  // ---- (2)+(3) per-doc typing with only the dispatch wrapper + Event Timing
  for (const which of ['small', 'large', 'huge']) {
    const { line, text } = pickLine(which);
    await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await waitFirstVisible(page, 120_000);
    await waitIdle(page);
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), line);
    await sleep(1200);
    await page.evaluate(() => {
      const view = window.__mdr.app.editor.view;
      const rec = (window.__rec = { dispatch: [], events: [], mounts: [] });
      const orig = view.dispatch.bind(view);
      view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); rec.dispatch.push(performance.now() - t0); return r; };
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.events.push({ name: e.name, dur: e.duration, proc: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime, start: e.startTime }); })
          .observe({ type: 'event', durationThreshold: 16 });
      } catch {}
      window.__mdr.app.bus.on('perf:sample', (s) => rec.mounts.push({ name: s.name, ms: s.ms, at: performance.now() }));
    });
    await resetProbe(page);
    await sleep(200);
    const typed = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.type(typed, { delay: DELAY });
    await sleep(500);
    const t1 = await page.evaluate(() => performance.now());
    const rec = await page.evaluate(() => window.__rec);
    const probe = await readProbe(page);
    const lts = probe.longTasks.filter((x) => x.start >= t0 && x.start <= t1);
    const loaf = probe.loaf.filter((x) => x.start >= t0 && x.start <= t1);
    const ev = rec.events.filter((e) => e.start >= t0 && e.start <= t1);
    const byName = {};
    for (const e of ev) (byName[e.name] ??= []).push(e);
    const d = rec.dispatch;
    console.log(`\n[control ${which}.md line ${line} "${text.slice(0, 30)}"] keys=${CHARS} dispatch n=${d.length}: p50 ${fmt(pct(d, 50))} p95 ${fmt(pct(d, 95))} max ${fmt(max(d))} ms (mean ${fmt(mean(d))})`);
    console.log(`[control ${which}] Event Timing entries ≥16 ms: ${ev.length} → ${Object.entries(byName).map(([n, xs]) => `${n}: n=${xs.length} dur p50 ${fmt(pct(xs.map((x) => x.dur), 50))} max ${fmt(max(xs.map((x) => x.dur)))} (processing p50 ${fmt(pct(xs.map((x) => x.proc), 50))}, input delay p50 ${fmt(pct(xs.map((x) => x.delay), 50))})`).join('; ') || 'none'}`);
    console.log(`[control ${which}] long tasks: ${lts.length} (${lts.map((x) => x.dur.toFixed(0)).join(',')}); LoAF: ${loaf.length} ${loaf.slice(0, 5).map((x) => `${x.dur.toFixed(0)}ms(block ${x.blocking.toFixed(0)}) ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ')}; mounts ${rec.mounts.filter((m) => m.name === 'mount').length}`);
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}
