// bench/verify/p7-giant.mjs — P7 done properly: large.md, type "~~~~" + Enter at line 1 col 0 (a
// tilde fence cannot be closed by the backtick fences in the document, so the fence runs to EOF and
// the worker must produce ONE giant Code block), type a few chars inside it, then close it with
// "~~~~" + Enter at line 2 col 0. Measures direct view.dispatch, Event Timing durations, long tasks
// > 100 ms, the giant-guard (.is-slow) timeline and whether the old content stays visible.
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const { browser, page, errors } = await launch();
const snap = () => page.evaluate(() => {
  const first = document.querySelector('.md-block');
  return { blocks: window.__mdr.app.preview.blockCount(), wrappers: document.querySelectorAll('.md-block').length, mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, slow: document.querySelectorAll('.md-block.is-slow').length, stale: document.querySelectorAll('.md-block.is-stale').length, first: window.__mdr.app.preview.blockAtLine(1), firstChildren: first?.children.length, firstCls: first?.className, firstText: first?.textContent.slice(0, 50), pre: first?.querySelector('pre')?.className, idle: performance.getEntriesByName('mdr:idle').length };
});
async function typeAt(label, line, col, chars, delay) {
  await page.evaluate(([l, c]) => window.__mdr.app.editor.gotoLine(l, c), [line, col]);
  await sleep(400);
  await page.evaluate(() => {
    window.__rec = { dispatch: [], events: [], samples: [] };
    const view = window.__mdr.app.editor.view; if (!view.__wrapped) { view.__wrapped = true; const orig = view.dispatch.bind(view); view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__rec.dispatch.push(performance.now() - t0); return r; }; }
    if (!window.__evObs) { window.__evObs = true; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rec?.events.push({ name: e.name, dur: e.duration, start: e.startTime }); }).observe({ type: 'event', durationThreshold: 16 }); }
    window.__mdr.app.bus.on('perf:sample', (s) => window.__rec?.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
  });
  await resetProbe(page);
  const t0 = await page.evaluate(() => performance.now());
  await page.keyboard.type(chars, { delay });
  // timeline for 4 s after the last key
  const timeline = [];
  for (let i = 0; i < 40; i++) { await sleep(100); const s = await snap(); timeline.push({ t: (i + 1) * 100, blocks: s.blocks, mounted: s.mounted, slow: s.slow, stale: s.stale, firstChildren: s.firstChildren, first: s.first.lineCount }); }
  const t1 = await page.evaluate(() => performance.now());
  const rec = await page.evaluate(() => window.__rec);
  const probe = await readProbe(page);
  const lts = probe.longTasks.filter((x) => x.start >= t0);
  const ev = rec.events.filter((e) => e.start >= t0 && e.start <= t1 && (e.name === 'keydown' || e.name === 'input')).map((e) => e.dur);
  const mounts = rec.samples.filter((s) => s.name === 'mount');
  console.log(`\n[${label}] dispatch p50 ${fmt(pct(rec.dispatch, 50))} p95 ${fmt(pct(rec.dispatch, 95))} max ${fmt(max(rec.dispatch))} ms (n=${rec.dispatch.length}); Event Timing keydown/input ≥16: n=${ev.length} max ${fmt(max(ev))}; mounts ${mounts.length} (max ${fmt(max(mounts.map((m) => m.ms)))} ms); long tasks: ${lts.map((x) => `${x.dur.toFixed(0)}@+${(x.start - t0).toFixed(0)}`).join(',') || 'none'}; LoAF: ${probe.loaf.filter((x) => x.start >= t0).map((x) => `${x.dur.toFixed(0)}ms(block ${x.blocking.toFixed(0)}) ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ') || 'none'}`);
  const changes = timeline.filter((s, i) => i === 0 || JSON.stringify({ ...s, t: 0 }) !== JSON.stringify({ ...timeline[i - 1], t: 0 }));
  console.log(`[${label}] timeline (t ms after last key → blocks/mounted/slow/stale/firstBlockLines/firstChildren): ${changes.map((s) => `${s.t}:${s.blocks}/${s.mounted}/${s.slow}/${s.stale}/${s.first}/${s.firstChildren}`).join('  ')}`);
  return { rec, lts, ev, big: lts.filter((x) => x.dur > 100) };
}
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  const s0 = await snap();
  console.log(`[P7] start: ${JSON.stringify(s0)}`);
  const a = await typeAt('P7 open ~~~~ at line 1', 1, 0, '~~~~\n', 150);
  const s1 = await snap();
  console.log(`[P7] after open: ${JSON.stringify(s1)}; lines 1-3: ${JSON.stringify(await page.evaluate(() => [1, 2, 3].map((l) => window.__mdr.app.editor.view.state.doc.line(l).text.slice(0, 40))))}`);
  const b = await typeAt('P7 type inside giant (line 2 end)', 2, 100000, ' xyz', 150);
  const c = await typeAt('P7 close ~~~~ at line 2', 2, 0, '~~~~\n', 150);
  await sleep(5000);
  const s2 = await snap();
  const persist = await page.evaluate(() => { const el = document.querySelector('.md-block'); const doc = window.__mdr.app.editor.view.state.doc; const b = window.__mdr.app.preview.blockAtLine(1); let src = ''; for (let l = b.startLine; l < b.startLine + b.lineCount; l++) src += doc.line(l).text + '\n'; return { id: el.dataset.id, cls: el.className, blockLines: b.lineCount, sourceChars: src.length, renderedChars: el.textContent.length, docChars: doc.length, wrappersTotal: document.querySelectorAll('.md-block').length, secondBlockText: document.querySelectorAll('.md-block')[1]?.textContent.slice(0, 40), secondPending: document.querySelectorAll('.md-block')[1]?.classList.contains('is-pending') }; });
  console.log(`[P7] 5 s after close, block 1 rendered content vs its source: ${JSON.stringify(persist)}`);
  report('P7 after closing: block 1 shows only its own 2-line source (no stale giant payload)', `rendered ${persist.renderedChars} chars vs source ${persist.sourceChars} chars (doc ${persist.docChars})`, 'rendered ≈ source', persist.renderedChars < persist.sourceChars + 20);
  console.log(`[P7] after close: ${JSON.stringify(s2)}; lines 1-4: ${JSON.stringify(await page.evaluate(() => [1, 2, 3, 4].map((l) => window.__mdr.app.editor.view.state.doc.line(l).text.slice(0, 40))))}`);
  const allDisp = [...a.rec.dispatch, ...b.rec.dispatch, ...c.rec.dispatch];
  const allEv = [...a.ev, ...b.ev, ...c.ev];
  const allBig = [...a.big, ...b.big, ...c.big];
  report('P7 giant fence produced (1 block after opening ~~~~)', `${s1.blocks} blocks, first block ${s1.first.lineCount} lines kind ${s1.first.kind}`, '1 block (kind Code)', s1.blocks === 1);
  report('P7 blocks restored after closing', `${s2.blocks} (was ${s0.blocks})`, `${s0.blocks + 1}`, s2.blocks === s0.blocks + 1);
  report('P7 view.dispatch per key p95', `${fmt(pct(allDisp, 95))} ms (max ${fmt(max(allDisp))})`, '(input latency < 16 ms)', pct(allDisp, 95) < 16);
  report('P7 Event Timing keydown/input duration (≥16 ms entries, 8 ms granularity)', `n=${allEv.length} of ${allDisp.length} keys, max ${fmt(max(allEv))} ms`, 'p95 < 16 ms', max(allEv) <= 16);
  report('P7 tasks > 100 ms across open/type/close', `${allBig.length} (${allBig.map((x) => x.dur.toFixed(0)).join(',')})`, '≤ 1', allBig.length <= 1);
} finally {
  dumpErrors(errors);
  await browser.close();
}
