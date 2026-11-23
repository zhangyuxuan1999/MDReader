// bench/verify/review-reopen.mjs — the same window-replay mechanism a worker restart exercises, reached
// without killing the worker: core.setDoc resets the worker's auto-push window to lines 1..1, but
// createPreview.updateWindow re-sends `viewport` only when the
// window's first/last line changes. Re-opening a document with the same block layout (reload of the same
// file, draft restore) therefore leaves the worker with window 1..1: pending blocks still arrive via `need`,
// but edits to mounted blocks are rendered into the cache only and never pushed → the preview stops updating.
// Run: PORT=5205 node bench/verify/review-reopen.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'medium.md';
const { browser, page, errors } = await openPage();
const visible = () => page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const r = p.el.getBoundingClientRect();
  const out = [];
  for (const w of p.el.querySelectorAll('.md-block')) {
    const b = w.getBoundingClientRect();
    if (b.bottom >= r.top && b.top <= r.bottom) out.push({ id: w.dataset.id, stale: w.classList.contains('is-stale'), pending: w.classList.contains('is-pending'), text: (w.textContent || '').slice(0, 40) });
  }
  return out;
});
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  const line = await page.evaluate(() => {
    const ed = window.__mdr.app.editor; const doc = ed.view.state.doc; let l = Math.floor(doc.lines / 2);
    for (let i = 0; i < 2000; i++) { const t = doc.line(l + i).text; if (t.length > 20 && !/^\s*(#|```|~~~|\||[-*+]\s|>|\d+\.)/.test(t)) { l += i; break; } }
    ed.gotoLine(l, 3); ed.focus();
    return l;
  });
  await sleep(1200);
  await waitIdle(page);
  // count viewport messages from here on
  await page.evaluate(() => { const w = window.__mdr.app.worker; const orig = w.viewport; window.__vp = 0; w.viewport = (a, b) => { window.__vp++; return orig.call(w, a, b); }; });
  // re-open the same text (what "open the same file again" / "restore draft" do: editor.setDoc + worker.setDoc)
  await page.evaluate(async () => { await window.__mdr.loadText(window.__mdr.app.getText(), 'medium.md'); });
  await waitIdle(page);
  await sleep(500);
  const pos = await page.evaluate(() => ({ top: window.__mdr.app.preview.topVisible().line, vp: window.__vp }));
  // put the cursor back in the same visible prose line and type
  await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 3); ed.focus(); }, line);
  await sleep(1200);
  await waitIdle(page);
  const v1 = await visible();
  await page.keyboard.type('ZZQQ');
  await waitIdle(page).catch(() => {});
  await sleep(1500);
  const v2 = await visible();
  const shown = v2.some((w) => w.text.includes('ZZQQ'));
  const stale = v2.filter((w) => w.stale).length;
  const vp = await page.evaluate(() => window.__vp);
  console.log({ line, previewTopAfterReopen: pos.top, viewportMsgsAfterReopen: pos.vp, viewportMsgsTotal: vp, visibleBeforeTyping: v1.length, staleBeforeTyping: v1.filter((w) => w.stale).length, shown, stale });
  report(`review-reopen ${DOC}`, [
    { name: 'viewport re-sent to the worker after re-opening the same-shaped document', value: `${pos.vp} viewport() calls`, target: '≥ 1', pass: pos.vp >= 1 },
    { name: 'typing "ZZQQ" after the re-open shows up in the preview', value: `shown=${shown}, stale ${stale}/${v2.length}`, target: 'shown, 0 stale', pass: shown && stale === 0 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
