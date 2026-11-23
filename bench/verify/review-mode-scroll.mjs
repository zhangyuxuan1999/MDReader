// bench/verify/review-mode-scroll.mjs — suspected bug: App.applyMode() calls layout.setMode() (display:none on the
// pane being hidden) BEFORE sync.syncNow(prev pane). A display:none scroller reports scrollTop = 0, so the follower
// is positioned from line 1 instead of the master's real top line. Checks split→preview, preview→edit, split→edit→split.
// Run: node bench/verify/review-mode-scroll.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'medium.md';
const { browser, page, errors } = await openPage();
const state = () => page.evaluate(() => {
  const a = window.__mdr.app;
  return {
    mode: a.layout.getMode(),
    editorTop: a.editor.topVisible().line,
    editorScrollTop: a.editor.view.scrollDOM.scrollTop,
    previewTop: a.preview.topVisible().line,
    previewScrollTop: a.preview.el.scrollTop,
  };
});
const results = [];
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  const target = 8000;
  // put both panes around the target line via the sync (editor master)
  await page.evaluate((l) => { window.__mdr.app.editor.scrollToLine(l, 0); }, target);
  await sleep(800);
  const s0 = await state();
  console.log('split, after scroll:', s0);

  // 1. split → preview
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(600);
  const s1 = await state();
  console.log('preview:', s1);
  results.push({ name: 'split→preview keeps preview position (top line)', value: `${s0.previewTop} → ${s1.previewTop}`, target: `≈ ${s0.previewTop} (±50 lines)`, pass: Math.abs(s1.previewTop - s0.previewTop) <= 50 });

  // 2. preview → edit
  await page.evaluate(() => window.__mdr.mode('edit'));
  await sleep(600);
  const s2 = await state();
  console.log('edit:', s2);
  results.push({ name: 'preview→edit lands the editor on the preview top line', value: `preview was ${s1.previewTop}, editor now ${s2.editorTop}`, target: `≈ ${s1.previewTop} (±50 lines)`, pass: Math.abs(s2.editorTop - s1.previewTop) <= 50 });

  // 3. edit → split (editor master) : preview should follow editor
  await page.evaluate((l) => { window.__mdr.app.editor.scrollToLine(l, 0); }, target);
  await sleep(300);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(800);
  const s3 = await state();
  console.log('split again:', s3);
  results.push({ name: 'edit→split: preview follows the editor', value: `editor ${s3.editorTop}, preview ${s3.previewTop}`, target: 'same ±50 lines', pass: Math.abs(s3.editorTop - s3.previewTop) <= 50 });

  // 4. split → preview → split: should come back near target
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(500);
  const s4a = await state();
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(800);
  const s4 = await state();
  console.log('preview then split:', s4a, s4);
  results.push({ name: 'split→preview→split round trip keeps the position', value: `${target} → preview ${s4a.previewTop} → split editor ${s4.editorTop} / preview ${s4.previewTop}`, target: `≈ ${target} (±50)`, pass: Math.abs(s4.editorTop - target) <= 50 && Math.abs(s4.previewTop - target) <= 50 });

  // raw evidence of the mechanism: read scrollTop of the hidden pane
  const raw = await page.evaluate(async () => {
    const a = window.__mdr.app;
    a.editor.scrollToLine(5000, 0);
    await new Promise((r) => requestAnimationFrame(r));
    const before = a.editor.view.scrollDOM.scrollTop;
    const lineBefore = a.editor.topVisible().line;
    a.layout.setMode('preview');
    const hidden = a.editor.view.scrollDOM.scrollTop;
    const top = a.editor.topVisible().line;
    a.layout.setMode('split');
    const restored = a.editor.view.scrollDOM.scrollTop;
    return { before, lineBefore, hidden, topVisibleWhileHidden: top, restored };
  });
  console.log('raw scrollTop evidence (editor scroller before/while display:none/after):', raw);
  // The browser itself reports scrollTop 0 for a display:none scroller (raw.hidden); the API must not leak that.
  results.push({ name: 'editor.topVisible() while its pane is display:none', value: `raw scrollTop ${raw.before} → ${raw.hidden}, topVisible line ${raw.lineBefore} → ${raw.topVisibleWhileHidden}`, target: 'topVisible line unchanged', pass: raw.topVisibleWhileHidden === raw.lineBefore });
  report(`review-mode-scroll ${DOC}`, results);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
