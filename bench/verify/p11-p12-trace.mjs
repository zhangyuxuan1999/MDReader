// bench/verify/p11-p12-trace.mjs — P11: undo ×50 / redo ×50 on large.md; P12: mode switch ×20 and
// theme toggle ×20. Main-thread cost is read from a Chromium trace (RunTask per step window: busy
// sum and longest task), plus the longtask / LoAF observers. The MessageChannel monitor is NOT used.
// Usage: node bench/verify/p11-p12-trace.mjs [stepDelayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';
import { startTrace, stopTrace, perWindow, tasksBetween, describeTask } from './trace.mjs';

const STEP = Number(process.argv[2] ?? 100);
const src = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
let target = 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
const out = [];
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(800);
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), target);
  await page.evaluate(() => {
    window.__rec = { samples: [], dispatch: [] };
    window.__mdr.app.bus.on('perf:sample', (s) => window.__rec.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
    const view = window.__mdr.app.editor.view; const orig = view.dispatch.bind(view);
    view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__rec.dispatch.push({ t: t0, ms: performance.now() - t0 }); return r; };
    window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) performance.mark('vt:key'); }, true);
  });
  // 50 separate undo groups: type a char, then move the cursor (a selection-only transaction ends the group)
  for (let i = 0; i < 50; i++) { await page.keyboard.type(String.fromCharCode(97 + (i % 26))); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await sleep(40); }
  await sleep(1200);
  await waitIdle(page).catch(() => {});
  const v0 = await page.evaluate(() => window.__mdr.version());

  // ---- P11 undo x50 under trace
  await resetProbe(page);
  await startTrace(browser, page);
  await page.evaluate(() => { window.__rec.dispatch.length = 0; performance.mark('vt:undo-start'); });
  for (let i = 0; i < 50; i++) { await page.keyboard.press('Meta+z'); await sleep(STEP); }
  await sleep(800);
  await page.evaluate(() => performance.mark('vt:undo-end'));
  const v1 = await page.evaluate(() => window.__mdr.version());
  const lineAfterUndo = await page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, target);
  const dispUndo = await page.evaluate(() => window.__rec.dispatch.map((d) => d.ms));
  await page.evaluate(() => { window.__rec.dispatch.length = 0; performance.mark('vt:redo-start'); });
  for (let i = 0; i < 50; i++) { await page.keyboard.press('Meta+Shift+z'); await sleep(STEP); }
  await sleep(800);
  await page.evaluate(() => performance.mark('vt:redo-end'));
  const v2 = await page.evaluate(() => window.__mdr.version());
  const dispRedo = await page.evaluate(() => window.__rec.dispatch.map((d) => d.ms));
  const tr = await stopTrace(browser);
  const probe = await readProbe(page);
  const keys = tr.marks['vt:key'] ?? [];
  const undoKeys = keys.filter((k) => k >= tr.marks['vt:undo-start'][0] && k < tr.marks['vt:undo-end'][0]);
  const redoKeys = keys.filter((k) => k >= tr.marks['vt:redo-start'][0] && k < tr.marks['vt:redo-end'][0]);
  const wu = perWindow(tr.tasks, undoKeys, STEP), wr = perWindow(tr.tasks, redoKeys, STEP);
  const st = await page.evaluate(({ id, l }) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { text: el?.textContent.slice(-70), stale: el?.classList.contains('is-stale'), line: window.__mdr.app.editor.view.state.doc.line(l).text.slice(-60) }; }, { id: b.id, l: target });
  const summarize = (label, w, disp) => {
    const busy = w.map((x) => x.busy), longest = w.map((x) => x.longest);
    const worst = w.reduce((a, x) => (x.longest > (a?.longest ?? -1) ? x : a), null);
    console.log(`[${label}] steps ${w.length}: busy/step p50 ${fmt(pct(busy, 50))} p95 ${fmt(pct(busy, 95))} max ${fmt(max(busy))} ms; longest task/step p50 ${fmt(pct(longest, 50))} p95 ${fmt(pct(longest, 95))} max ${fmt(max(longest))} ms; view.dispatch p50 ${fmt(pct(disp, 50))} p95 ${fmt(pct(disp, 95))} max ${fmt(max(disp))} (n=${disp.length}); worst task: ${describeTask(worst?.longestTask)}`);
    return { busy, longest };
  };
  const u = summarize('P11 undo x50', wu, dispUndo), r = summarize('P11 redo x50', wr, dispRedo);
  const lts = probe.longTasks.filter((x) => x.start >= 0);
  console.log(`[P11] versions ${v0} → ${v1} (${v1 - v0} undo steps) → ${v2} (${v2 - v1} redo steps); line restored after undo: ${lineAfterUndo === src[target - 1]}; after redo: ${JSON.stringify(st)}; long tasks (≥50 ms) during P11: ${lts.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  const allBusy = [...u.busy, ...r.busy], allLongest = [...u.longest, ...r.longest], allDisp = [...dispUndo, ...dispRedo];
  out.push(report('P11 undo steps executed', `${v1 - v0}`, '50', v1 - v0 === 50));
  out.push(report('P11 redo steps executed', `${v2 - v1}`, '50', v2 - v1 === 50));
  out.push(report('P11 main-thread busy per undo/redo step p95 (trace RunTask sum)', `${fmt(pct(allBusy, 95))} ms (undo ${fmt(pct(u.busy, 95))}, redo ${fmt(pct(r.busy, 95))}, max ${fmt(max(allBusy))})`, '< 5 ms', pct(allBusy, 95) < 5));
  out.push(report('P11 longest single task per step p95', `${fmt(pct(allLongest, 95))} ms (max ${fmt(max(allLongest))})`, '< 5 ms', pct(allLongest, 95) < 5));
  out.push(report('P11 view.dispatch per step p95', `${fmt(pct(allDisp, 95))} ms (max ${fmt(max(allDisp))})`, '< 5 ms', pct(allDisp, 95) < 5));
  out.push(report('P11 preview reflects redo result (not stale)', `${st.text?.includes(st.line.slice(-20))} stale=${st.stale}`, 'true', !!st.text?.includes(st.line.slice(-20)) && !st.stale));

  // ---- P12 mode x20 / theme x20 under trace
  await sleep(500);
  await resetProbe(page);
  await startTrace(browser, page);
  await page.evaluate(() => performance.mark('vt:mode-start'));
  for (let i = 0; i < 20; i++) { await page.evaluate(() => performance.mark('vt:mode')); await page.keyboard.press('Meta+/'); await sleep(200); }
  await sleep(500);
  await page.evaluate(() => performance.mark('vt:mode-end'));
  await page.evaluate(() => performance.mark('vt:theme-start'));
  for (let i = 0; i < 20; i++) { await page.evaluate(() => performance.mark('vt:theme')); await page.keyboard.press('Meta+Shift+l'); await sleep(200); }
  await sleep(500);
  await page.evaluate(() => performance.mark('vt:theme-end'));
  const tr2 = await stopTrace(browser);
  const probe2 = await readProbe(page);
  const modeTasks = tasksBetween(tr2.tasks, tr2.marks['vt:mode-start'][0], tr2.marks['vt:mode-end'][0]);
  const themeTasks = tasksBetween(tr2.tasks, tr2.marks['vt:theme-start'][0], tr2.marks['vt:theme-end'][0]);
  const top = (ts) => [...ts].sort((a, b) => b.dur - a.dur).slice(0, 4);
  const wm = perWindow(tr2.tasks, tr2.marks['vt:mode'], 200), wt = perWindow(tr2.tasks, tr2.marks['vt:theme'], 200);
  const finalMode = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  const finalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  console.log(`\n[P12 mode x20] final mode ${finalMode}; per-switch longest task: ${wm.map((x) => x.longest.toFixed(0)).join(',')}; per-switch busy: ${wm.map((x) => x.busy.toFixed(0)).join(',')}`);
  console.log(`[P12 mode x20] top tasks: ${top(modeTasks).map(describeTask).join(' | ')}`);
  console.log(`[P12 theme x20] final theme ${finalTheme}; per-toggle longest task: ${wt.map((x) => x.longest.toFixed(0)).join(',')}; per-toggle busy: ${wt.map((x) => x.busy.toFixed(0)).join(',')}`);
  console.log(`[P12 theme x20] top tasks: ${top(themeTasks).map(describeTask).join(' | ')}`);
  console.log(`[P12] longtask observer (≥50 ms) during P12: ${probe2.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}; LoAF: ${probe2.loaf.map((x) => `${x.dur.toFixed(0)}ms(block ${x.blocking.toFixed(0)}) ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ') || 'none'}`);
  const worstMode = max(modeTasks.map((t) => t.dur)), worstTheme = max(themeTasks.map((t) => t.dur));
  out.push(report('P12 mode switch x20 longest main-thread task (trace)', `${fmt(worstMode)} ms`, '< 50 ms', worstMode < 50));
  out.push(report('P12 theme toggle x20 longest main-thread task (trace)', `${fmt(worstTheme)} ms`, '< 50 ms', worstTheme < 50));
  out.push(report('P12 longtask entries (≥50 ms) during mode/theme cycling', `${probe2.longTasks.length}`, '0', probe2.longTasks.length === 0));
} finally {
  dumpErrors(errors);
  await browser.close();
}
