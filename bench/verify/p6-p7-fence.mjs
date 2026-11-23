// bench/verify/p6-p7-fence.mjs — P6: typing inside a 300-line and a 5k-line fence (doc built via
// __mdr.loadText); P7: large.md with an unclosed ``` inserted at line 1, then closing it.
// Measures main-thread busy per keystroke (event-loop monitor), input latency (keydown → next rAF),
// long tasks > 100 ms, and preview correctness.
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const { browser, page, errors } = await launch();
const results = [];

const makeDoc = (fenceLines) => {
  const paras = (n, p) => Array.from({ length: n }, (_, i) => `段落 ${p}-${i} 这是一些中文文本 with some English words, line ${i}.\n`).join('\n');
  const fence = '```ts\n' + Array.from({ length: fenceLines }, (_, i) => `export function fn${i}(a: number, b: string): string { return b + a * ${i}; } // line ${i}`).join('\n') + '\n```\n';
  return `# Fence test ${fenceLines}\n\n${paras(200, 'a')}\n${fence}\n${paras(200, 'b')}`;
};

async function typeAndMeasure(label, line, chars, delay, col = 100000) {
  await page.evaluate(([l, c]) => window.__mdr.app.editor.gotoLine(l, c), [line, col]);
  await sleep(600);
  await page.evaluate(() => { window.__probeMonitor(true); window.__probeFrames(true); window.__rec = { samples: [], dispatch: [], events: [] }; window.__mdr.app.bus.on('perf:sample', (s) => window.__rec.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
    const view = window.__mdr.app.editor.view; if (!view.__wrapped) { view.__wrapped = true; const orig = view.dispatch.bind(view); view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__rec.dispatch.push(performance.now() - t0); return r; }; }
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rec.events.push({ name: e.name, dur: e.duration, start: e.startTime }); }).observe({ type: 'event', durationThreshold: 16 }); } catch {} });
  await resetProbe(page);
  await sleep(200);
  const tStart = await page.evaluate(() => performance.now());
  await page.keyboard.type(chars, { delay });
  await sleep(1200);
  const tEnd = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__probeMonitor(false); window.__probeFrames(false); });
  const probe = await readProbe(page);
  const rec = await page.evaluate(() => window.__rec);
  const keys = probe.keys.filter((k) => k.t >= tStart && k.t <= tEnd).map((k) => k.t);
  const gaps = probe.gaps.filter((g) => g.end > tStart && g.start < tEnd);
  const frames = probe.frames;
  const perKey = [], inputLat = [], mountLat = [];
  const mounts = rec.samples.filter((s) => s.name === 'mount');
  for (let i = 0; i < keys.length; i++) {
    const from = keys[i], to = i + 1 < keys.length ? keys[i + 1] : from + delay;
    let work = 0; for (const g of gaps) if (g.end > from && g.start < to) work += g.gap;
    perKey.push(work);
    const f = frames.find((x) => x > from); if (f) inputLat.push(f - from);
    const m = mounts.find((s) => s.at >= from); if (m) mountLat.push(m.at - from);
  }
  const lts = probe.longTasks.filter((x) => x.start >= tStart && x.start <= tEnd);
  const big = lts.filter((x) => x.dur > 100);
  const loaf = probe.loaf.filter((x) => x.start >= tStart && x.start <= tEnd);
  console.log(`\n[${label}] keys=${keys.length} busy/key p50 ${fmt(pct(perKey, 50))} p95 ${fmt(pct(perKey, 95))} max ${fmt(max(perKey))} ms; input latency (keydown→next frame) p50 ${fmt(pct(inputLat, 50))} p95 ${fmt(pct(inputLat, 95))} max ${fmt(max(inputLat))} ms; key→mount p50 ${fmt(pct(mountLat, 50))} p95 ${fmt(pct(mountLat, 95))} (n=${mountLat.length}); mount ms max ${fmt(max(mounts.map((m) => m.ms)))}`);
  const mountMs = mounts.filter((m) => m.at >= tStart).map((m) => m.ms);
  const evIn = rec.events.filter((e) => e.start >= tStart && e.start <= tEnd && (e.name === 'keydown' || e.name === 'input')).map((e) => e.dur);
  console.log(`[${label}] DIRECT: view.dispatch p50 ${fmt(pct(rec.dispatch, 50))} p95 ${fmt(pct(rec.dispatch, 95))} max ${fmt(max(rec.dispatch))} ms (n=${rec.dispatch.length}); mount ms p50 ${fmt(pct(mountMs, 50))} p95 ${fmt(pct(mountMs, 95))} max ${fmt(max(mountMs))} (n=${mountMs.length}); Event Timing keydown/input dur (8 ms granularity, ≥16 only): n=${evIn.length} p95 ${fmt(pct(evIn, 95))} max ${fmt(max(evIn))}`);
  console.log(`[${label}] long tasks: ${lts.length} (${lts.map((x) => x.dur.toFixed(0)).join(',')}); >100 ms: ${big.length}; LoAF: ${loaf.map((x) => `${x.dur.toFixed(0)}ms ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ')}`);
  return { perKey, inputLat, mountLat, lts, big, dispatch: rec.dispatch, mountMs, evIn };
}

try {
  await warmUp(page);
  // ---- P6
  for (const n of [300, 5000]) {
    await page.goto(`${BASE}/?mode=split`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await page.evaluate((t) => window.__mdr.loadText(t, `fence${t.length}.md`), makeDoc(n));
    await waitFirstVisible(page, 60_000);
    await waitIdle(page);
    const fenceStart = 2 + 200 * 2 + 1; // line of ```ts
    const line = fenceStart + Math.floor(n / 2);
    const lineText = await page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, line);
    const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), line);
    console.log(`[P6 ${n}] line ${line} "${lineText.slice(0, 40)}" block ${JSON.stringify(b)}`);
    const r = await typeAndMeasure(`P6 ${n}-line fence`, line, ' // typed here abc', 100);
    const ok = await page.evaluate(({ id, l }) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { has: el?.textContent.includes('typed here abc'), stale: el?.classList.contains('is-stale'), hl: !!el?.querySelector('.hljs-keyword, .hljs-title'), cls: el?.querySelector('pre')?.className }; }, { id: b.id, l: line });
    console.log(`[P6 ${n}] preview updated: ${JSON.stringify(ok)}`);
    const t = n === 300 ? 8 : 16;
    results.push(report(`P6 ${n}-line fence main busy per key p95`, `${fmt(pct(r.perKey, 95))} ms (max ${fmt(max(r.perKey))})`, `< ${t} ms`, pct(r.perKey, 95) < t));
    results.push(report(`P6 ${n}-line fence preview shows typed text`, `${ok.has} (stale ${ok.stale}, highlighted ${ok.hl}, pre class ${ok.cls})`, 'true', ok.has === true));
  }

  // ---- P7: large.md, unclosed fence at line 1
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  const blocks0 = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  await page.evaluate(() => window.__mdr.app.editor.gotoLine(1, 0));
  await sleep(300);
  // type ``` + Enter at the very top → whole doc becomes one fence
  const r7a = await typeAndMeasure('P7 open fence (type ``` Enter at line 1)', 1, '```\n', 150, 0);
  await sleep(2500);
  const st1 = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount(), wrappers: document.querySelectorAll('.md-block').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, slow: document.querySelectorAll('.md-block.is-slow').length, stale: document.querySelectorAll('.md-block.is-stale').length, firstKind: window.__mdr.app.preview.blockAtLine(1), pre: document.querySelector('.md-block pre')?.className, firstText: document.querySelector('.md-block')?.textContent.slice(0, 60) }));
  console.log(`[P7] after opening fence: ${JSON.stringify(st1)} (was ${blocks0} blocks)`);
  const probeA = await readProbe(page);
  const bigA = probeA.longTasks.filter((x) => x.dur > 100);
  console.log(`[P7] long tasks after opening fence (incl. settle): ${probeA.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  // now type a few chars on line 2 inside the giant block
  const r7b = await typeAndMeasure('P7 typing inside giant fence (line 2)', 2, ' xyz', 150);
  await sleep(1500);
  // close it: line 2 becomes ``` → block splits back (line 1 ```, line 2 ``` closes)
  await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
  await sleep(300);
  const r7c = await typeAndMeasure('P7 close fence (type ``` Enter at line 2)', 2, '```\n', 150, 0);
  await sleep(3000);
  const st2 = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount(), wrappers: document.querySelectorAll('.md-block').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, stale: document.querySelectorAll('.md-block.is-stale').length, slow: document.querySelectorAll('.md-block.is-slow').length, h1: document.querySelector('.md-block h1')?.textContent, l1: window.__mdr.app.editor.view.state.doc.line(1).text, l2: window.__mdr.app.editor.view.state.doc.line(2).text, l3: window.__mdr.app.editor.view.state.doc.line(3).text }));
  console.log(`[P7] after closing fence: ${JSON.stringify(st2)}`);
  const probeC = await readProbe(page);
  console.log(`[P7] long tasks after closing (incl. settle): ${probeC.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  const allInput = [...r7a.inputLat, ...r7b.inputLat, ...r7c.inputLat];
  const allEv = [...r7a.evIn, ...r7b.evIn, ...r7c.evIn]; const allDisp = [...r7a.dispatch, ...r7b.dispatch, ...r7c.dispatch];
  console.log(`[P7] Event Timing keydown/input ≥16ms: n=${allEv.length} of ${allDisp.length} keys, p95 ${fmt(pct(allEv, 95))} max ${fmt(max(allEv))}; dispatch p95 ${fmt(pct(allDisp, 95))} max ${fmt(max(allDisp))}`);
  const allBig = [...bigA, ...r7b.big, ...probeC.longTasks.filter((x) => x.dur > 100)];
  results.push(report('P7 input latency p95 (keydown → next frame)', `${fmt(pct(allInput, 95))} ms (max ${fmt(max(allInput))})`, '< 16 ms', pct(allInput, 95) < 16));
  results.push(report('P7 tasks > 100 ms', `${allBig.length} (${allBig.map((x) => x.dur.toFixed(0)).join(',')})`, '≤ 1', allBig.length <= 1));
  results.push(report('P7 giant fence: 1 block after open', `${st1.blocks}`, '1', st1.blocks === 1));
  results.push(report('P7 blocks restored after close', `${st2.blocks} (was ${blocks0})`, `${blocks0 + 1}`, st2.blocks === blocks0 + 1));
  console.log(`[P7] main busy per key: open p95 ${fmt(pct(r7a.perKey, 95))}, inside p95 ${fmt(pct(r7b.perKey, 95))}, close p95 ${fmt(pct(r7c.perKey, 95))} ms`);
} finally {
  dumpErrors(errors);
  await browser.close();
}
