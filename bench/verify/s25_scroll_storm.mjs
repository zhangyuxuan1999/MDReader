// s25 — random scroll storm on huge.md (chunk materialisation/demotion churn), scrolling while typing,
// and a resize storm while scrolled deep. Checks: viewport never stays blank, model stays consistent,
// no console/page errors, no restart, input stays responsive.
// Run: node bench/verify/s25_scroll_storm.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

const viewportState = () => page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const el = p.el;
  const r = el.getBoundingClientRect();
  let total = 0, pending = 0, empty = 0;
  for (const b of document.querySelectorAll('.md-block')) {
    const br = b.getBoundingClientRect();
    if (br.bottom > r.top && br.top < r.bottom) {
      total++;
      if (b.classList.contains('is-pending')) pending++;
      if (!b.firstChild) empty++;
    }
  }
  // model ↔ DOM agreement for the top visible line
  const m = p.scrollTopToLine(el.scrollTop);
  const back = p.lineToScrollTop(m.line, m.fraction);
  return { total, pending, empty, scrollTop: Math.round(el.scrollTop), scrollHeight: Math.round(el.scrollHeight), line: m.line, roundTripErr: Math.abs(back - el.scrollTop) };
});

try {
  await open(page, '?doc=/test-data/huge.md&mode=split');
  await page.waitForFunction(() => window.__mdr.version() >= 1, null, { timeout: 120000 });
  let s = await settle(page, 240000);
  C.check('huge.md settles', s.ok, s);
  let sc = await structureCheck(page);
  C.check('structure tiles', sc.problems.length === 0, sc);

  // ---- (A) 200 random jumps, no settle between them
  await page.evaluate(() => { window.__longTasks.length = 0; });
  const jump = await page.evaluate(async () => {
    const el = window.__mdr.app.preview.el;
    const H = el.scrollHeight;
    let worstRoundTrip = 0, negative = 0;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      el.scrollTop = Math.floor(rnd() * (H - 1000));
      await new Promise((r) => requestAnimationFrame(r));
      const p = window.__mdr.app.preview;
      const m = p.scrollTopToLine(el.scrollTop);
      if (!(m.line >= 1) || !Number.isFinite(m.fraction)) negative++;
      const back = p.lineToScrollTop(m.line, m.fraction);
      worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back - el.scrollTop));
    }
    return { worstRoundTrip: Math.round(worstRoundTrip), negative, finalScrollHeight: Math.round(el.scrollHeight) };
  });
  C.check('(A) 200 random jumps: scrollTop↔line round-trip never degenerate', jump.negative === 0, jump);
  C.measure('(A) worst scrollTop↔line round-trip error (px)', jump.worstRoundTrip, '< 2000 (one block)', jump.worstRoundTrip < 2000);
  let lt = await longTasks(page);
  C.measure('(A) long tasks during the jump storm (count/max ms)', `${lt.count}/${lt.max}`, 'max < 100', lt.max < 100);
  await sleep(2000);
  let v = await viewportState();
  C.check('(A) after the storm settles, the visible viewport is filled', v.total > 0 && v.pending === 0 && v.empty === 0, v);
  sc = await structureCheck(page);
  C.check('(A) structure tiles after the jump storm', sc.problems.length === 0, sc);

  // ---- (B) continuous wheel scrolling for 5 s, sampling for blank viewports
  await page.evaluate(() => { window.__mdr.app.preview.el.scrollTop = 0; });
  await sleep(400);
  const wheel = await page.evaluate(async () => {
    const el = window.__mdr.app.preview.el;
    const r = el.getBoundingClientRect();
    let blankFrames = 0, frames = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      el.scrollTop += 2500;
      await new Promise((rr) => requestAnimationFrame(rr));
      frames++;
      let total = 0, filled = 0;
      for (const b of document.querySelectorAll('.md-block')) {
        const br = b.getBoundingClientRect();
        if (br.bottom > r.top && br.top < r.bottom) { total++; if (b.firstChild) filled++; }
      }
      if (total === 0 || filled === 0) blankFrames++;
    }
    return { frames, blankFrames, blankPct: +(100 * blankFrames / frames).toFixed(1), scrollTop: Math.round(el.scrollTop) };
  });
  C.measure('(B) fast-scroll frames with a completely blank viewport (%)', wheel.blankPct, '< 40 % (transient only)', wheel.blankPct < 40);
  await sleep(2000);
  v = await viewportState();
  C.check('(B) viewport filled once scrolling stops', v.total > 0 && v.pending === 0 && v.empty === 0, v);

  // ---- (C) typing while scrolling
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(170000, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; window.__longTasks.length = 0; });
  const scrolling = page.evaluate(async () => {
    const el = window.__mdr.app.preview.el;
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) { el.scrollTop += 1800; await new Promise((r) => requestAnimationFrame(r)); }
    return true;
  });
  await page.keyboard.type('TYPE-WHILE-SCROLL ' + 'xyz '.repeat(80), { delay: 0 });
  await scrolling;
  const lat = await latencyStats(page);
  C.measure('(C) input latency p95 / max while scrolling (ms)', `${lat.p95} / ${lat.max}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
  lt = await longTasks(page);
  C.measure('(C) long tasks while typing+scrolling (count/max ms)', `${lt.count}/${lt.max}`, 'max < 100', lt.max < 100);
  s = await settle(page, 240000);
  C.check('(C) settles after typing while scrolling', s.ok, s);
  const around = await page.evaluate(() => {
    const e = window.__mdr.app.editor;
    const l = e.view.state.doc.line(170000);
    return e.getText().slice(l.from, l.from + 40);
  });
  C.check('(C) the typed text landed at line 170000', around.includes('TYPE-WHILE-SCROLL'), around);
  sc = await structureCheck(page);
  C.check('(C) structure tiles after typing+scrolling', sc.problems.length === 0, sc);

  // ---- (D) resize storm while scrolled deep
  await page.evaluate(() => { window.__longTasks.length = 0; });
  for (const w of [500, 1400, 700, 1200, 400, 1400, 900, 1400]) {
    await page.setViewportSize({ width: w, height: 900 });
    await sleep(120);
  }
  await sleep(1500);
  lt = await longTasks(page);
  C.measure('(D) long tasks during the resize storm (count/max ms)', `${lt.count}/${lt.max}`, 'max < 100', lt.max < 100);
  v = await viewportState();
  C.check('(D) viewport filled after the resize storm', v.total > 0 && v.pending === 0 && v.empty === 0, v);
  sc = await structureCheck(page);
  C.check('(D) structure tiles after the resize storm', sc.problems.length === 0, sc);
  const overflow = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth }));
  C.check('(D) no horizontal page overflow after the resize storm', overflow.docW <= overflow.vw, overflow);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s25 scroll storm', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
