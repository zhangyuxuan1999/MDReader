// s10c — evidence for two s10b findings. (1) Layout with the TOC hidden (Mod-Shift-O) at 1400 px and
// at 900 px: pane rects + screenshots; can the user still type/see the preview? (2) Which mode switch
// loses the reading position: split→preview, edit→preview, split→edit.
// Run: node bench/verify/s10c_toc_hidden_and_preview_switch.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/out';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const { browser, page, log } = await launch();
const C = makeChecker();
const rects = () => page.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), display: getComputedStyle(e).display }; };
  return { vw: innerWidth, mode: window.__mdr.app.layout.getMode(), tocAttr: document.querySelector('.mdr-app').dataset.toc, toc: r('.mdr-pane--toc'), editor: r('.mdr-pane--editor'), gutter: r('.mdr-gutter'), preview: r('.mdr-pane--preview'), cmContent: r('.cm-content'), cols: getComputedStyle(document.querySelector('.mdr-main')).gridTemplateColumns };
});

try {
  await open(page, '?doc=/test-data/small.md&mode=split');
  await settle(page, 60000);
  await page.screenshot({ path: `${OUT}/s10c-1400-toc-open.png` });
  let g = await rects();
  C.check('(1) 1400 px, TOC open: editor and preview have width', g.editor.w > 150 && g.preview.w > 150, g);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+o' : 'Control+Shift+o');
  await sleep(300);
  g = await rects();
  console.log('TOC hidden @1400:', JSON.stringify(g));
  await page.screenshot({ path: `${OUT}/s10c-1400-toc-hidden.png` });
  C.check('(1) 1400 px, TOC hidden via Mod-Shift-O: editor and preview still have width', g.editor.w > 150 && g.preview.w > 150, g);
  // can the user click into the editor?
  const clickable = await page.evaluate(() => { const e = document.querySelector('.cm-content'); const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + 10, b.y + 10); return { rect: { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }, hit: hit ? hit.tagName + '.' + hit.className : null }; });
  C.check('(1) TOC hidden: editor content area is hit-testable', !!clickable.hit && /cm-/.test(clickable.hit), clickable);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+o' : 'Control+Shift+o');
  await sleep(300);

  await page.setViewportSize({ width: 900, height: 700 });
  await sleep(400);
  g = await rects();
  console.log('TOC open @900:', JSON.stringify(g));
  await page.screenshot({ path: `${OUT}/s10c-900.png` });
  C.check('(1) 900 px, TOC attr open: editor and preview have width', g.editor.w > 150 && g.preview.w > 150, g);
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(400);

  // (2) which switch loses the position
  await open(page, '?doc=/test-data/medium.md&mode=split');
  await settle(page, 60000);
  const top = () => page.evaluate(() => ({ mode: window.__mdr.app.layout.getMode(), ed: window.__mdr.app.editor.topVisible().line, pv: window.__mdr.app.preview.topVisible().line, edScroll: Math.round(window.__mdr.app.editor.view.scrollDOM.scrollTop), pvScroll: Math.round(window.__mdr.app.preview.el.scrollTop) }));
  const goto = async (l) => { await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 0); ed.focus(); }, l); await sleep(600); };
  const sw = async (m) => { await page.evaluate((m) => window.__mdr.mode(m), m); await sleep(600); return top(); };

  await goto(8000);
  let b = await top();
  let a = await sw('preview');
  C.check('(2) split→preview: preview top line stays near 8000', Math.abs(a.pv - b.ed) <= 5, { before: b, after: a });
  a = await sw('split');
  // gotoLine(8000) centres the cursor, so the pre-switch top line is ~7990; the round trip must keep THAT line.
  C.check('(2) preview→split: both panes keep the pre-switch top line', Math.abs(a.ed - b.ed) <= 5 && Math.abs(a.pv - b.ed) <= 5, { before: b, after: a });

  await page.evaluate(() => window.__mdr.mode('split'));
  await goto(8000);
  await sw('edit');
  b = await top();
  a = await sw('preview');
  C.check('(2) edit→preview: preview top line near editor line', Math.abs(a.pv - b.ed) <= 5, { before: b, after: a });

  await page.evaluate(() => window.__mdr.mode('split'));
  await goto(8000);
  b = await top();
  a = await sw('edit');
  C.check('(2) split→edit: editor top kept', Math.abs(a.ed - b.ed) <= 5, { before: b, after: a });
  a = await sw('split');
  C.check('(2) edit→split: preview follows editor (±5 lines)', Math.abs(a.pv - a.ed) <= 5, a);

  // Same via the keyboard shortcut cycle (Mod-/) — the user-facing path
  await page.evaluate(() => window.__mdr.mode('split'));
  await goto(8000);
  b = await top();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+/' : 'Control+/');
  await sleep(600);
  a = await top();
  C.check('(2) Mod-/ split→preview keeps the reading position', a.mode === 'preview' && Math.abs(a.pv - b.ed) <= 5, { before: b, after: a });

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s10c toc hidden + preview switch', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
