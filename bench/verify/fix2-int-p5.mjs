// bench/verify/fix2-int-p5.mjs — integrator (stage 2b): p5-clean.mjs for a BUILT dist served statically (the candidate and the 0.1.1 baseline, same server, same measurement). Copy of p5-clean.mjs:
// event-loop monitor (no MutationObserver, no rAF loop, no dispatch wrapper, no tracing), plus an
// idle baseline measured with the exact same monitor immediately before typing. Reports
//   busy-per-keystroke = Σ(monitor gaps in the 100 ms after the key) minus the idle baseline,
// the longest single gap per key, and (separately) keystroke→mount latency from perf:sample.
// Usage: MDR_BASE=http://localhost:<port> node bench/verify/fix2-int-p5.mjs   (was: node bench/verify/p5-clean.mjs [large|huge] [chars] [delayMs] [mode]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max, mean } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 200);
const DELAY = Number(process.argv[4] ?? 100);
const MODE = process.argv[5] ?? 'split';
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : Math.floor(src.length / 2);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  // integrator: a production build has no ?doc= (DEV only): load the text through the test hook instead.
  await page.goto(`${BASE}/?mode=${MODE}&perf=1`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await page.evaluate((t) => window.__mdr.loadText(t, 'p5.md'), src.join('\n'));
  if (MODE !== 'edit') await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1200);
  await waitIdle(page).catch(() => {});
  await sleep(500);
  await page.evaluate(() => {
    window.__mounts = [];
    window.__mdr.app.bus.on('perf:sample', (s) => { if (s.name === 'mount') window.__mounts.push(performance.now()); });
  });

  // ---- idle baseline with the same monitor
  await page.evaluate(() => window.__probeMonitor(true));
  await resetProbe(page);
  const b0 = await page.evaluate(() => performance.now());
  await sleep(4000);
  const b1 = await page.evaluate(() => performance.now());
  const base = await readProbe(page);
  const bwin = [];
  for (let s = b0; s + DELAY <= b1; s += DELAY) { let w = 0; for (const g of base.gaps) if (g.end > s && g.start < s + DELAY) w += g.gap; bwin.push(w); }
  console.log(`[p5-clean ${which}/${MODE}] idle baseline busy per ${DELAY} ms: p50 ${fmt(pct(bwin, 50))} p95 ${fmt(pct(bwin, 95))} max ${fmt(max(bwin))} (n=${bwin.length})`);

  // ---- typing
  await resetProbe(page);
  await page.evaluate(() => { window.__mounts.length = 0; });
  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  const tStart = await page.evaluate(() => performance.now());
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(600);
  const tEnd = await page.evaluate(() => performance.now());
  await page.evaluate(() => window.__probeMonitor(false));
  const probe = await readProbe(page);
  const mounts = await page.evaluate(() => window.__mounts);

  const keys = probe.keys.filter((k) => k.t >= tStart && k.t <= tEnd).map((k) => k.t);
  const work = [], maxGap = [], lat = [];
  let noMount = 0;
  for (let i = 0; i < keys.length; i++) {
    const from = keys[i], to = i + 1 < keys.length ? keys[i + 1] : from + DELAY;
    let w = 0, mg = 0;
    for (const g of probe.gaps) { if (g.end > from && g.start < to) { w += Math.min(g.end, to) - Math.max(g.start, from); mg = Math.max(mg, g.gap); } }
    work.push(w); maxGap.push(mg);
    const m = mounts.find((t) => t >= from);
    if (m !== undefined && m < to) lat.push(m - from); else noMount++;
  }
  const baseP50 = pct(bwin, 50);
  const adj = work.map((w) => Math.max(0, w - baseP50));
  const lts = probe.longTasks.filter((x) => x.start >= tStart && x.start <= tEnd);
  const loaf = probe.loaf.filter((x) => x.start >= tStart && x.start <= tEnd);
  console.log(`[p5-clean ${which}/${MODE}] keys=${keys.length} mounts=${mounts.length} keysWithoutMount=${noMount}`);
  console.log(`[p5-clean] raw busy per key: p50 ${fmt(pct(work, 50))} p95 ${fmt(pct(work, 95))} max ${fmt(max(work))} ms`);
  console.log(`[p5-clean] baseline-adjusted busy per key: p50 ${fmt(pct(adj, 50))} p95 ${fmt(pct(adj, 95))} max ${fmt(max(adj))} ms`);
  console.log(`[p5-clean] longest single gap per key: p50 ${fmt(pct(maxGap, 50))} p95 ${fmt(pct(maxGap, 95))} max ${fmt(max(maxGap))} ms`);
  console.log(`[p5-clean] key→mount latency: p50 ${fmt(pct(lat, 50))} p95 ${fmt(pct(lat, 95))} max ${fmt(max(lat))} ms (n=${lat.length})`);
  console.log(`[p5-clean] long tasks ${lts.length}; LoAF ${loaf.length} ${loaf.slice(0, 5).map((x) => `${x.dur.toFixed(0)}ms`).join(',')}`);
  report(`P5 ${which}/${MODE} main busy per keystroke p95 (baseline-adjusted)`, `${fmt(pct(adj, 95))} ms`, '< 5 ms', pct(adj, 95) < 5);
  report(`P5 ${which}/${MODE} main busy per keystroke max (baseline-adjusted)`, `${fmt(max(adj))} ms`, '< 10 ms', max(adj) < 10);
  report(`P5 ${which}/${MODE} keystroke → block mounted p95`, `${fmt(pct(lat, 95))} ms`, '< 40 ms', pct(lat, 95) < 40);
} finally {
  dumpErrors(errors);
  await browser.close();
}
