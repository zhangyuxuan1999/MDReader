// s10e — 500 px (and 400 px) viewport: is every toolbar control (incl. the right-aligned file name /
// dirty dot and the mode buttons) inside the visible window? Which controls are clipped? Is the
// palette usable? Screenshots to out/. Run: node bench/verify/s10e_narrow_toolbar.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';
import { mkdirSync } from 'node:fs';
const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/out';
mkdirSync(OUT, { recursive: true });

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?doc=/test-data/small.md&mode=split');
  await settle(page, 60000);
  for (const w of [500, 400, 360]) {
    await page.setViewportSize({ width: w, height: 700 });
    await sleep(400);
    const g = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const tb = document.querySelector('.mdr-toolbar');
      const r = tb.getBoundingClientRect();
      const items = Array.from(tb.querySelectorAll('button, .mdr-toolbar__file, [data-cmd]')).map((b) => {
        const br = b.getBoundingClientRect();
        return { label: (b.getAttribute('title') || b.textContent || b.className).trim().slice(0, 20), left: Math.round(br.left), right: Math.round(br.right), clipped: br.right > vw + 1 || br.left < -1 || br.width === 0 };
      });
      const cs = getComputedStyle(tb);
      return { vw, toolbar: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), overflowX: cs.overflowX, flexWrap: cs.flexWrap }, appOverflow: getComputedStyle(document.querySelector('.mdr-app')).overflow, clipped: items.filter((i) => i.clipped), total: items.length, tocOpenAttr: document.querySelector('.mdr-app').dataset.toc };
    });
    console.log(`[${w}px]`, JSON.stringify(g));
    await page.screenshot({ path: `${OUT}/s10e-${w}.png` });
    C.check(`(${w}px) toolbar fits in the viewport (no controls clipped)`, g.clipped.length === 0 && g.toolbar.right <= g.vw + 1, { toolbar: g.toolbar, clipped: g.clipped.map((c) => `${c.label}@${c.left}-${c.right}`) });
    // main grid vs viewport, per mode
    for (const mode of ['split', 'edit', 'preview']) {
      await page.evaluate((m) => window.__mdr.mode(m), mode);
      await sleep(250);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width) }; };
        const main = r('.mdr-main');
        const ed = r('.mdr-pane--editor'), pv = r('.mdr-pane--preview'), scroller = r('.cm-scroller'), pvEl = r('.mdr-preview');
        const app = r('.mdr-app'), toolbar = r('.mdr-toolbar'), status = r('.mdr-statusbar');
        const appCols = getComputedStyle(document.querySelector('.mdr-app')).gridTemplateColumns;
        const tbWrap = getComputedStyle(document.querySelector('.mdr-toolbar')).flexWrap;
        return { vw, app, appCols, toolbar, tbWrap, status, main, editor: ed, preview: pv, cmScroller: scroller, previewScroller: pvEl, cols: getComputedStyle(document.querySelector('.mdr-main')).gridTemplateColumns, minW: { editor: getComputedStyle(document.querySelector('.mdr-pane--editor')).minWidth, preview: getComputedStyle(document.querySelector('.mdr-pane--preview')).minWidth, main: getComputedStyle(document.querySelector('.mdr-main')).minWidth } };
      });
      console.log(`[${w}px ${mode}]`, JSON.stringify(m));
      C.check(`(${w}px ${mode}) main grid not wider than the viewport`, m.main.right <= m.vw + 1, { vw: m.vw, main: m.main, cols: m.cols, minW: m.minW });
      if (mode !== 'edit') C.check(`(${w}px ${mode}) preview pane fully inside the viewport (right edge visible)`, m.preview.right <= m.vw + 1, { vw: m.vw, preview: m.preview });
      if (mode !== 'preview') C.check(`(${w}px ${mode}) editor pane fully inside the viewport`, m.editor.right <= m.vw + 1, { vw: m.vw, editor: m.editor });
    }
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(200);
    // is the file name / dirty indicator visible?
    const file = g.clipped.find((c) => /\.md|未命名/.test(c.label));
    C.check(`(${w}px) file name / dirty indicator visible`, !file, file);
    // can the user reach the palette and pick a command?
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+p' : 'Control+Shift+p');
    await sleep(200);
    const pal = await page.evaluate(() => { const p = document.querySelector('.mdr-palette'); if (!p) return null; const r = p.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: document.documentElement.clientWidth, visible: getComputedStyle(p).display !== 'none' && r.width > 0 }; });
    C.check(`(${w}px) palette opens inside the viewport`, pal && pal.visible && pal.left >= -1 && pal.right <= pal.vw + 1, pal);
    await page.keyboard.press('Escape');
    await sleep(100);
  }
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s10e narrow toolbar', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
