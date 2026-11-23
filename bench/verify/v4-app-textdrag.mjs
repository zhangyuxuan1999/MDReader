// bench/verify/v4-app-textdrag.mjs — verify-app (0.2.0 stage 2d). Text drags after U17 (file drops now cancelled
// on window capture): moving selected text inside the editor pane, dragging a preview selection into the editor,
// dragging an image of the preview into the editor. Real mouse drags (Playwright drives Chromium's drag & drop).
// Prints RESULT lines (the source after the drag, toasts) for a candidate / baseline diff.
//   Candidate:  MDR_PORT=5436 node bench/verify/v4-app-textdrag.mjs
//   Baseline:   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-textdrag.mjs
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const GIF = 'data:image/gif;base64,R0lGODlhEAAQAIAAAP///wAAACH5BAEAAAAALAAAAAAQABAAAAIOhI+py+0Po5y02ouzPgUAOw==';
const DOC = `第一行文字 alpha\n\n第二行 beta gamma\n\n![pic](${GIF})\n\n末行。\n`;
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent).slice(-2));
const cmRect = (line, from, to) => page.evaluate(({ line, from, to }) => {
  const v = window.__mdr.app.editor.view;
  const l = v.state.doc.line(line);
  const a = v.coordsAtPos(l.from + from), b = v.coordsAtPos(l.from + to);
  return { x0: a.left, x1: b.left, y: (a.top + a.bottom) / 2 };
}, { line, from, to });
try {
  await B.boot('mode=split');
  await shimBaseline(page);
  const reset = async () => { await page.keyboard.press('Escape'); await B.loadDoc(DOC); await sleep(600); };

  await reset();
  // T1: select "beta" (line 3, cols 4..8) in the editor and drag it to the end of line 1
  {
    const r = await cmRect(3, 4, 8);
    await page.mouse.click(r.x0 + 1, r.y); await page.mouse.click(r.x0 + 1, r.y, { clickCount: 2 }); await sleep(150);
    const sel = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const m = v.state.selection.main; return v.state.sliceDoc(m.from, m.to); });
    const t = await cmRect(1, 14, 14);
    const mid = (r.x0 + r.x1) / 2;
    await page.mouse.move(mid, r.y); await page.mouse.down(); await page.mouse.move(mid + 10, r.y - 5, { steps: 4 }); await page.mouse.move(t.x0 + 2, t.y, { steps: 10 }); await page.mouse.up();
    await B.settle(300);
    out('T1 drag selected text inside the editor', { sel, src: await B.source(), toasts: await toasts() });
  }
  await reset();
  // T2: select "gamma" in the preview by double click, drag it into the editor at the end of line 1
  {
    const pt = await B.textPoint(3, 'first', 'gamma');
    await page.mouse.dblclick(pt.x + 3, pt.y); await sleep(200);
    const sel = await page.evaluate(() => getSelection().toString());
    const t = await cmRect(1, 14, 14);
    await page.mouse.move(pt.x + 6, pt.y); await page.mouse.down(); await page.mouse.move(pt.x - 20, pt.y + 5, { steps: 4 }); await page.mouse.move(t.x0 + 2, t.y, { steps: 12 }); await page.mouse.up();
    await B.settle(300);
    out('T2 drag a preview selection into the editor', { sel, src: await B.source(), toasts: await toasts(), session: await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')) });
  }
  await reset();
  // T3: drag the preview image into the editor
  {
    await B.mountLine(5);
    const img = await page.evaluate(() => { const r = document.querySelector('.mdr-preview img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const t = await cmRect(1, 14, 14);
    await page.mouse.move(img.x, img.y); await page.mouse.down(); await page.mouse.move(img.x - 20, img.y, { steps: 4 }); await page.mouse.move(t.x0 + 2, t.y, { steps: 12 }); await page.mouse.up();
    await B.settle(400);
    const s = await B.source();
    out('T3 drag the preview image into the editor', { changed: s !== DOC, line1: s.split('\n')[0].slice(0, 60), toasts: await toasts(), session: await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')) });
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
