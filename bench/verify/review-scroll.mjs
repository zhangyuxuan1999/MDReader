// bench/verify/review-scroll.mjs — P8/P9: preview wheel 20 screens & editor PageDown×100 on large.md.
// Measures frame gaps (rAF monitor), long tasks, CDP LayoutCount/LayoutDuration deltas, and whether the
// follower pane ends up on the master's top line. Run: node bench/verify/review-scroll.mjs
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, metrics, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const { browser, page, cdp, errors } = await openPage();
try {
  await cdp.send('Performance.enable');
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await installMonitor(page);
  const results = [];

  // ---- preview wheel 20 screens
  const box = await page.evaluate(() => { const r = window.__mdr.app.preview.el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }; });
  await page.mouse.move(box.x, box.y);
  await sleep(300);
  await resetMonitor(page);
  let m0 = await metrics(cdp);
  for (let i = 0; i < 20 * 4; i++) { await page.mouse.wheel(0, box.h / 4); await sleep(40); }
  await sleep(800);
  let m1 = await metrics(cdp);
  let mon = await readMonitor(page);
  const follow1 = await page.evaluate(() => {
    const a = window.__mdr.app;
    const p = a.preview.topVisible(), e = a.editor.topVisible();
    return { previewLine: p.line, editorLine: e.line, diff: Math.abs(p.line - e.line) };
  });
  results.push(
    { name: 'preview wheel: frames > 20 ms', value: `${mon.over20} / ${mon.frames} (${r1((100 * mon.over20) / Math.max(1, mon.frames))}%, max gap ${r1(mon.maxGap)} ms)`, target: '< 3 %', pass: mon.over20 / Math.max(1, mon.frames) < 0.03 },
    { name: 'preview wheel: long tasks > 50 ms', value: `${mon.longtasks.length} ${JSON.stringify(mon.longtasks.map((t) => r1(t.dur)))}`, target: '0', pass: mon.longtasks.length === 0 },
    { name: 'preview wheel: layouts / layout ms (CDP)', value: `${m1.LayoutCount - m0.LayoutCount} layouts, ${r1((m1.LayoutDuration - m0.LayoutDuration) * 1000)} ms total`, target: 'informational', pass: true },
    { name: 'preview wheel: editor follows (top line diff)', value: `preview ${follow1.previewLine} vs editor ${follow1.editorLine}`, target: '≤ 1 block', pass: follow1.diff <= 60 },
  );

  // ---- editor PageDown ×100
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1); });
  await sleep(500);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await resetMonitor(page);
  m0 = await metrics(cdp);
  for (let i = 0; i < 100; i++) { await page.keyboard.press('PageDown'); await sleep(30); }
  await sleep(800);
  m1 = await metrics(cdp);
  mon = await readMonitor(page);
  const follow2 = await page.evaluate(() => {
    const a = window.__mdr.app;
    const p = a.preview.topVisible(), e = a.editor.topVisible();
    return { previewLine: p.line, editorLine: e.line, diff: Math.abs(p.line - e.line) };
  });
  results.push(
    { name: 'editor PageDown×100: frames > 20 ms', value: `${mon.over20} / ${mon.frames} (${r1((100 * mon.over20) / Math.max(1, mon.frames))}%, max gap ${r1(mon.maxGap)} ms)`, target: '< 3 %', pass: mon.over20 / Math.max(1, mon.frames) < 0.03 },
    { name: 'editor PageDown×100: long tasks > 50 ms', value: `${mon.longtasks.length} ${JSON.stringify(mon.longtasks.map((t) => r1(t.dur)))}`, target: '0', pass: mon.longtasks.length === 0 },
    { name: 'editor PageDown×100: layouts / layout ms (CDP)', value: `${m1.LayoutCount - m0.LayoutCount} layouts, ${r1((m1.LayoutDuration - m0.LayoutDuration) * 1000)} ms total`, target: 'informational', pass: true },
    { name: 'editor PageDown×100: preview follows (top line diff)', value: `editor ${follow2.editorLine} vs preview ${follow2.previewLine}`, target: '≤ 1 block', pass: follow2.diff <= 60 },
  );
  report(`review-scroll ${DOC}`, results);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
