// bench/verify/p11-p12-undo-mode.mjs — P11: undo ×50 / redo ×50 (main-thread busy per step p95,
// preview follows); P12: mode switch ×20 and theme toggle ×20 (longest task). large.md.
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const src = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
let target = 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
const perStep = async (label, n, press, extraWait = 60) => {
  await page.evaluate(() => { window.__probeMonitor(true); window.__probeFrames(true); window.__rec = { samples: [], dispatch: [] }; window.__mdr.app.bus.on('perf:sample', (s) => window.__rec.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
    const view = window.__mdr.app.editor.view; if (!view.__wrapped) { view.__wrapped = true; const orig = view.dispatch.bind(view); view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__rec.dispatch.push(performance.now() - t0); return r; }; } window.__rec.dispatch.length = 0; });
  await resetProbe(page);
  await sleep(200);
  const stamps = [];
  for (let i = 0; i < n; i++) { stamps.push(await page.evaluate(() => performance.now())); await page.keyboard.press(press); await sleep(extraWait); }
  await sleep(800);
  const tEnd = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__probeMonitor(false); window.__probeFrames(false); });
  const probe = await readProbe(page);
  const rec = await page.evaluate(() => window.__rec);
  const keys = probe.keys.filter((k) => k.t >= stamps[0] - 5 && k.t <= tEnd && k.key.toLowerCase() === 'z').map((k) => k.t);
  const work = [], mountLat = [];
  const mounts = rec.samples.filter((s) => s.name === 'mount');
  for (let i = 0; i < keys.length; i++) {
    const from = keys[i], to = i + 1 < keys.length ? keys[i + 1] : from + extraWait;
    let w = 0; for (const g of probe.gaps) if (g.end > from && g.start < to) w += g.gap; work.push(w);
    const m = mounts.find((s) => s.at >= from); if (m) mountLat.push(m.at - from);
  }
  const lts = probe.longTasks.filter((x) => x.start >= stamps[0]);
  const disp = rec.dispatch.filter((d) => d > 0.05); console.log(`[${label}] DIRECT view.dispatch per step: p50 ${fmt(pct(disp, 50))} p95 ${fmt(pct(disp, 95))} max ${fmt(max(disp))} ms (n=${disp.length})`);
  console.log(`[${label}] steps ${keys.length}: busy/step p50 ${fmt(pct(work, 50))} p95 ${fmt(pct(work, 95))} max ${fmt(max(work))} ms; step→mount p95 ${fmt(pct(mountLat, 95))} (n=${mountLat.length}); mounts ${mounts.length}; long tasks ${lts.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  return { work, mountLat, lts, mounts: mounts.length };
};

try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(800);
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), target);
  // 50 separate transactions: type a char, wait > history newGroupDelay (500 ms) is too slow; instead use
  // spaces separated by cursor moves so each becomes its own undo group: type char, press Left+Right.
  for (let i = 0; i < 50; i++) { await page.keyboard.type(String.fromCharCode(97 + (i % 26))); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await sleep(40); }
  await sleep(1000);
  const v0 = await page.evaluate(() => window.__mdr.version());
  const undo = await perStep('P11 undo x50', 50, 'Meta+z', 80);
  const v1 = await page.evaluate(() => window.__mdr.version());
  const lineAfterUndo = await page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, target);
  const redo = await perStep('P11 redo x50', 50, 'Meta+Shift+z', 80);
  const v2 = await page.evaluate(() => window.__mdr.version());
  const st = await page.evaluate(({ id, l }) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { text: el?.textContent.slice(-70), stale: el?.classList.contains('is-stale'), line: window.__mdr.app.editor.view.state.doc.line(l).text.slice(-60) }; }, { id: b.id, l: target });
  console.log(`[P11] versions ${v0} → undo ${v1} (${v1 - v0} steps) → redo ${v2} (${v2 - v1} steps); line after undo restored to original: ${lineAfterUndo === src[target - 1]}; after redo: ${JSON.stringify(st)}`);
  const all = [...undo.work, ...redo.work];
  report('P11 undo steps executed', `${v1 - v0}`, '50', v1 - v0 === 50);
  report('P11 redo steps executed', `${v2 - v1}`, '50', v2 - v1 === 50);
  report('P11 main busy per undo/redo step p95', `${fmt(pct(all, 95))} ms (undo p95 ${fmt(pct(undo.work, 95))}, redo p95 ${fmt(pct(redo.work, 95))}, max ${fmt(max(all))})`, '< 5 ms', pct(all, 95) < 5);
  report('P11 preview reflects redo result', `${st.text?.includes(st.line.slice(-20))} stale=${st.stale}`, 'true', st.text?.includes(st.line.slice(-20)) && !st.stale);

  // ---- P12 mode x20
  await page.evaluate(() => { window.__probeMonitor(true); });
  await resetProbe(page);
  await sleep(200);
  const modeGaps = [];
  for (let i = 0; i < 20; i++) {
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press('Meta+/');
    await sleep(150);
    const t1 = await page.evaluate(() => performance.now());
    modeGaps.push([t0, t1]);
  }
  await sleep(500);
  let probe = await readProbe(page);
  const modeSeq = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  const worstMode = max(probe.gaps.map((g) => g.gap));
  const perSwitch = modeGaps.map(([a, b]) => max(probe.gaps.filter((g) => g.start >= a && g.start <= b).map((g) => g.gap)));
  console.log(`\n[P12] mode x20: longest task/gap ${fmt(worstMode)} ms; per switch max: ${perSwitch.map((x) => x.toFixed(0)).join(',')}; long tasks ${probe.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}; LoAF ${probe.loaf.map((x) => `${x.dur.toFixed(0)}ms ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ') || 'none'}; final mode ${modeSeq}`);
  report('P12 mode switch x20 longest task', `${fmt(worstMode)} ms`, '< 50 ms', worstMode < 50);
  // ---- P12 theme x20
  await resetProbe(page);
  await sleep(200);
  const themeGaps = [];
  for (let i = 0; i < 20; i++) {
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press('Meta+Shift+l');
    await sleep(150);
    themeGaps.push([t0, await page.evaluate(() => performance.now())]);
  }
  await sleep(500);
  await page.evaluate(() => { window.__probeMonitor(false); });
  probe = await readProbe(page);
  const worstTheme = max(probe.gaps.map((g) => g.gap));
  const perTheme = themeGaps.map(([a, b]) => max(probe.gaps.filter((g) => g.start >= a && g.start <= b).map((g) => g.gap)));
  console.log(`[P12] theme x20: longest task/gap ${fmt(worstTheme)} ms; per toggle max: ${perTheme.map((x) => x.toFixed(0)).join(',')}; long tasks ${probe.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}; LoAF ${probe.loaf.map((x) => `${x.dur.toFixed(0)}ms ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ') || 'none'}`);
  report('P12 theme toggle x20 longest task', `${fmt(worstTheme)} ms`, '< 50 ms', worstTheme < 50);
} finally {
  dumpErrors(errors);
  await browser.close();
}
