// s10b — follow-ups from s10: (1) pane widths at 500 / 700 / 900 / 1100 px viewports in split mode
// with the TOC open and closed, and in edit / preview modes (is the editor usable?);
// (2) does a mode switch keep the scroll position: single slow cycle split→preview→split,
// split→edit→split, 50 cycles at 100 ms, 50 cycles at 10 ms. Run: node bench/verify/s10b_layout_and_mode_position.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const rects = () => page.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return Math.round(b.width); };
  return { vw: innerWidth, mode: window.__mdr.app.layout.getMode(), toc: window.__mdr.app.layout.isTocVisible(), tocW: r('.mdr-pane--toc'), editorW: r('.mdr-pane--editor'), gutterW: r('.mdr-gutter'), previewW: r('.mdr-pane--preview'), mainW: r('.mdr-main'), cols: getComputedStyle(document.querySelector('.mdr-main')).gridTemplateColumns, split: getComputedStyle(document.querySelector('.mdr-app')).getPropertyValue('--split').trim(), tocVar: getComputedStyle(document.querySelector('.mdr-app')).getPropertyValue('--toc-w').trim(), docScrollW: document.documentElement.scrollWidth };
});

try {
  await open(page, '?doc=/test-data/small.md&mode=split');
  await settle(page, 60000);

  // (1) layout at several widths
  for (const w of [500, 700, 900, 1100]) {
    await page.setViewportSize({ width: w, height: 700 });
    await sleep(300);
    for (const toc of [true, false]) {
      await page.evaluate((on) => { if (window.__mdr.app.layout.isTocVisible() !== on) window.__mdr.app.registry.run('view.toggleToc'); }, toc);
      await sleep(200);
      const g = await rects();
      console.log(`[${w}px toc=${toc}]`, JSON.stringify(g));
      C.check(`(1) ${w}px split toc=${toc}: editor ≥ 150 px and preview ≥ 150 px`, g.editorW >= 150 && g.previewW >= 150, g);
    }
    await page.evaluate(() => window.__mdr.mode('edit'));
    await sleep(200);
    let g = await rects();
    C.check(`(1) ${w}px edit mode (toc closed): editor ≥ 300 px`, g.editorW >= 300, g);
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(200);
    g = await rects();
    C.check(`(1) ${w}px preview mode (toc closed): preview ≥ 300 px`, g.previewW >= 300, g);
    await page.evaluate(() => { window.__mdr.mode('split'); window.__mdr.app.registry.run('view.toggleToc'); });
    await sleep(200);
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(300);

  // (2) mode switch keeps the scroll position?
  await open(page, '?doc=/test-data/medium.md&mode=split');
  await settle(page, 60000);
  const top = () => page.evaluate(() => ({ ed: window.__mdr.app.editor.topVisible().line, pv: window.__mdr.app.preview.topVisible().line, edScroll: Math.round(window.__mdr.app.editor.view.scrollDOM.scrollTop), pvScroll: Math.round(window.__mdr.app.preview.el.scrollTop) }));
  const goto = async (l) => { await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 0); ed.focus(); }, l); await sleep(500); };

  await goto(8000);
  let b = await top();
  console.log('before', b);
  for (const [label, seq, gap] of [
    ['split→preview→split (500 ms)', ['preview', 'split'], 500],
    ['split→edit→split (500 ms)', ['edit', 'split'], 500],
    ['split→edit→preview→split (500 ms)', ['edit', 'preview', 'split'], 500],
    ['50 cycles at 100 ms', Array.from({ length: 51 }, (_, i) => ['preview', 'edit', 'split'][i % 3]), 100],
    ['50 cycles at 10 ms', Array.from({ length: 51 }, (_, i) => ['preview', 'edit', 'split'][i % 3]), 10],
  ]) {
    await goto(8000);
    b = await top();
    for (const m of seq) { await page.evaluate((m) => window.__mdr.mode(m), m); await sleep(gap); }
    await sleep(600);
    const a = await top();
    const modeNow = await page.evaluate(() => window.__mdr.app.layout.getMode());
    C.check(`(2) ${label}: editor top line kept (±5 lines)`, modeNow === 'split' && Math.abs(a.ed - b.ed) <= 5, { before: b, after: a, modeNow });
    C.check(`(2) ${label}: preview top line ≈ editor top line (±5)`, Math.abs(a.pv - a.ed) <= 5, a);
  }
  // Does the cursor line survive? (gotoLine put the cursor at 8000)
  const cur = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.lineAt(window.__mdr.app.editor.view.state.selection.main.head).number);
  C.check('(2) cursor line unchanged after the mode storms', cur === 8000, `cursor line ${cur}`);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s10b layout + mode position', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
