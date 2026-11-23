// bench/verify/v5-offa-u2.mjs — verify-off-app JOB 5: ⌘Z / ⇧⌘Z pressed OUTSIDE the editor (U2 as amended,
// switch OFF), candidate production build vs 0.1.1, same gestures. Focus after the change: the preview (a click on
// text), the outline, a toolbar button, nothing (body); split and preview mode; the change on screen and far off;
// after typing, a paste, find-and-replace; ten presses; a press with nothing to undo.
//   MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-offa-u2.mjs [case|prefix* ...] [--list]
// Verdict per case: SAME (every observation equal) or DIFF (both printed). Global timeout 115 s: run by prefix.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, runCases } from './v5-offa-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const MED = fs.readFileSync(path.join(ROOT, 'test-data/medium.md'), 'utf8');

const OBS = () => {
  const v = window.__mdr.app.editor.view;
  const head = v.state.selection.main.head;
  const ae = document.activeElement;
  const desc = (e) => (e ? e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').filter((c) => !/focus|hover|active/.test(c)).slice(0, 2).join('.') : '') : null);
  const ed = document.querySelector('.cm-scroller');
  const pv = document.querySelector('.mdr-preview');
  const tints = [...document.querySelectorAll('.mdr-preview [class*="focus"], .cm-line[class*="peer"], .cm-line[class*="focus"]')].map((e) => (e.className.match(/\S*(focus|peer)\S*/g) || []).join(',') + ':' + (e.textContent || '').slice(0, 24));
  return {
    text: v.state.doc.toString().length + ':' + v.state.doc.toString().slice(0, 0),
    hash: [...v.state.doc.toString()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
    line: v.state.doc.lineAt(head).number,
    col: head - v.state.doc.lineAt(head).from,
    active: desc(ae),
    edTop: ed ? Math.round(ed.scrollTop) : null,
    pvTop: pv ? Math.round(pv.scrollTop) : null,
    mode: document.querySelector('#app')?.firstElementChild?.className.match(/mode-\w+|is-\w+/g)?.join(',') ?? null,
    tints,
  };
};
const load = async (page, text, name = 'u2.md') => { await page.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]); await sleep(900); };
const edLine = async (page, line, ins, atEnd = true) => {
  await page.evaluate(([l, s, e]) => {
    const v = window.__mdr.app.editor.view; const L = v.state.doc.line(l); const at = e ? L.to : L.from;
    v.focus(); v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  }, [line, ins, atEnd]);
  await sleep(150);
  await page.keyboard.type(ins, { delay: 10 });
  await sleep(500);
};
const clickPreviewText = async (page, nth = 0) => {
  const pt = await page.evaluate((k) => {
    const pv = document.querySelector('.mdr-preview'); const pr = pv.getBoundingClientRect();
    const ps = [...pv.querySelectorAll('p')].filter((p) => { const r = p.getBoundingClientRect(); return r.top > pr.top + 10 && r.bottom < pr.bottom - 10 && r.width > 50; });
    const p = ps[k] || ps[0]; if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.left + 12, y: r.top + Math.min(8, r.height / 2) };
  }, nth);
  if (pt) { await page.mouse.click(pt.x, pt.y); await sleep(400); }
  return !!pt;
};
const toFocus = {
  preview: (page) => clickPreviewText(page),
  body: async (page) => { await page.evaluate(() => { document.activeElement && document.activeElement.blur(); }); await sleep(200); },
  toolbar: async (page) => { await page.evaluate(() => { const b = document.querySelector('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]') || document.querySelector('.mdr-toolbar__btn'); b.focus(); }); await sleep(200); },
  toc: async (page) => {
    const ok = await page.evaluate(() => { const a = document.querySelector('.mdr-toc a, .mdr-toc [role="treeitem"], .mdr-toc li'); if (!a) return false; a.focus ? a.focus() : null; return document.activeElement !== document.body; });
    if (!ok) { await page.keyboard.press('Meta+Shift+o'); await sleep(300); await page.evaluate(() => { const a = document.querySelector('.mdr-toc a, .mdr-toc [role="treeitem"], .mdr-toc li'); a && a.focus && a.focus(); }); }
    await sleep(200);
  },
};
const C = {};
for (const mode of ['split', 'preview']) {
  for (const [fname, focus] of Object.entries(toFocus)) {
    // change on screen (line 3 of medium.md), then focus elsewhere, then ⌘Z, ⇧⌘Z
    C[`near-${mode}-${fname}`] = async (page) => {
      await load(page, MED);
      await edLine(page, 3, ' 近改');
      if (mode === 'preview') { await page.evaluate(() => window.__mdr.app.registry.run('view.mode.preview')); await sleep(600); }
      await focus(page);
      const o0 = await page.evaluate(OBS);
      await page.keyboard.press('Meta+z'); await sleep(700);
      const o1 = await page.evaluate(OBS);
      await page.keyboard.press('Meta+Shift+z'); await sleep(700);
      const o2 = await page.evaluate(OBS);
      return { o0, o1, o2 };
    };
    // change far off screen: typed at the end of a far line, then the panes scrolled to the top
    C[`far-${mode}-${fname}`] = async (page) => {
      await load(page, MED);
      const n = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.lines);
      await edLine(page, Math.floor(n * 0.8), ' 远改');
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); });
      await sleep(200);
      if (mode === 'preview') { await page.evaluate(() => window.__mdr.app.registry.run('view.mode.preview')); await sleep(600); }
      await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; document.querySelector('.mdr-preview').scrollTop = 0; });
      await sleep(900);
      await focus(page);
      const o0 = await page.evaluate(OBS);
      await page.keyboard.press('Meta+z'); await sleep(900);
      const o1 = await page.evaluate(OBS);
      await page.keyboard.press('Meta+Shift+z'); await sleep(900);
      const o2 = await page.evaluate(OBS);
      return { o0, o1, o2 };
    };
  }
}
// after a paste into the editor, the focus to the preview
C['paste-preview'] = async (page, ctx) => {
  await load(page, MED);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(5).to } }); });
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '\n\n粘贴的段落 PASTE\n'); document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(600);
  await clickPreviewText(page, 1);
  const o0 = await page.evaluate(OBS);
  await page.keyboard.press('Meta+z'); await sleep(700);
  const o1 = await page.evaluate(OBS);
  return { o0, o1 };
};
// after find-and-replace all (the find panel), focus to the preview, ⌘Z
C['replace-all-preview'] = async (page) => {
  await load(page, MED);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press('Meta+f'); await sleep(300);
  await page.keyboard.type('的'); await sleep(200);
  const has = await page.evaluate(() => !!document.querySelector('.cm-search input[name=replace]'));
  if (has) { await page.fill('.cm-search input[name=replace]', '之'); await page.click('.cm-search button[name=replaceAll]'); await sleep(500); }
  await page.keyboard.press('Escape'); await sleep(200);
  await clickPreviewText(page, 0);
  const o0 = await page.evaluate(OBS);
  await page.keyboard.press('Meta+z'); await sleep(800);
  const o1 = await page.evaluate(OBS);
  await page.keyboard.press('Meta+Shift+z'); await sleep(800);
  const o2 = await page.evaluate(OBS);
  return { has, o0, o1, o2 };
};
// ten typed words, ten ⌘Z from the preview, then one more with nothing left
C['ten-preview'] = async (page) => {
  await load(page, '# T\n\npara one\n\npara two\n');
  for (let i = 0; i < 10; i++) { await edLine(page, 3, ' w' + i); await sleep(600); }
  await clickPreviewText(page, 0);
  const os = [];
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Meta+z'); await sleep(250); os.push(await page.evaluate(OBS)); }
  return { last: os[os.length - 1], hashes: os.map((o) => o.hash), actives: [...new Set(os.map((o) => o.active))] };
};
// A tick in the preview, then typing in the editor, then ⌘Z ×3 from the preview: the history has the order of the
// gestures (typing undone first, then the tick), and nothing else changes.
C['tick-type-order'] = async (page) => {
  const T0 = '# T\n\n- [ ] one\n- [ ] two\n\nend para\n';
  await load(page, T0);
  const box = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview li.task-list-item > input')[1]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y); await sleep(500);
  const t1 = await page.evaluate(() => window.__mdr.app.getText());
  await edLine(page, 6, ' typed');
  const t2 = await page.evaluate(() => window.__mdr.app.getText());
  await clickPreviewText(page, 0);
  const ts = [];
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Meta+z'); await sleep(500); ts.push(await page.evaluate(() => window.__mdr.app.getText())); }
  return { t1, t2, ts, ok: ts[0] === t1 && ts[1] === T0 };
};
C['nothing-body'] = async (page) => {
  await load(page, MED);
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await sleep(200);
  const o0 = await page.evaluate(OBS);
  await page.keyboard.press('Meta+z'); await sleep(500);
  await page.keyboard.press('Meta+Shift+z'); await sleep(500);
  const o1 = await page.evaluate(OBS);
  return { o0, o1 };
};
const bad = await runCases(C, { timeoutMs: 115_000 });
process.exit(bad ? 1 : 0);
