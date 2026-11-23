// bench/verify/v5-offp-j13.mjs — verify-off-preview: variations of r3 J13 (a document's label overlay turns a click
// into a tick of a hidden task) with 预览可编辑 OFF, the candidate and 0.1.1 side by side:
//   overlay-text        the r3 repro: an invisible label (absolute, 9000 px) wrapping a hidden task; click on a paragraph
//   overlay-over-box    the same overlay lies over a VISIBLE task's box; the user clicks that box
//   overlay-fixed       a position:fixed label over the whole window; the user clicks into the editor pane and types
//   raw-overlay         a raw checkbox inside a task item, absolute over the page; click on a paragraph
//   label-two           a visible label wrapping two tasks; click on the label's words
//   tab-hidden          Tab from the last visible box into the overlay's hidden box, then Space
// Per case: lines of the source that changed, the toasts, the editor's focus and what typing did.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 node bench/verify/v5-offp-j13.mjs [case ...]
// Global timeout 110 s. Writes nothing into the tree.
import { openPage, install, load, sleep, J } from './v5-chc-lib.mjs';

const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110000);
const only = process.argv.slice(2);
const OVER = 'position:absolute;left:-3000px;top:-3000px;width:9000px;height:9000px;z-index:50;opacity:0;display:block';
const FIX = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:9999;opacity:0;display:block';
const CASES = {
  'overlay-text': { doc: `Intro paragraph you click to read.\n\n- <label style="${OVER}">x\n  - [ ] wire the money\n\nlast line\n`, act: 'para' },
  'overlay-over-box': { doc: `- [ ] visible task one\n- [ ] visible task two\n\n- <label style="${OVER}">x\n  - [ ] hidden task\n\nlast line\n`, act: 'box2' },
  'overlay-fixed': { doc: `Intro paragraph.\n\n- <label style="${FIX}">x\n  - [ ] fixed hidden task\n\nlast line\n`, act: 'editor' },
  'raw-overlay': { doc: `Intro paragraph you click to read.\n\n- [ ] a task <input type="checkbox" style="${OVER}">\n\nlast line\n`, act: 'para' },
  'label-two': { doc: '- <label>Click these words\n  - [ ] first wrapped\n  - [ ] second wrapped\n  </label>\n\nend\n', act: 'labeltext' },
  'tab-hidden': { doc: `- [ ] visible task one\n\n- <label style="${OVER}">x\n  - [ ] hidden task\n\nlast line\n`, act: 'tab' },
};
const [C, B] = await Promise.all([openPage('cand'), openPage('base')]);
try {
  for (const [nm, cs] of Object.entries(CASES)) {
    if (only.length && !only.includes(nm)) continue;
    const r = await Promise.all([C.page, B.page].map(async (p) => {
      await load(p, cs.doc); await install(p);
      const before = await p.evaluate(() => window.__mdr.app.getText());
      const note = {};
      if (cs.act === 'para' || cs.act === 'box2' || cs.act === 'labeltext') {
        const q = await p.evaluate((act) => {
          let r;
          if (act === 'para') r = document.querySelector('.mdr-preview p').getBoundingClientRect();
          else if (act === 'box2') r = Array.from(document.querySelectorAll('.mdr-preview li input[type=checkbox]')).find((x) => x.closest('li').textContent.includes('two')).getBoundingClientRect();
          else { const l = document.querySelector('.mdr-preview label'); const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const rg = document.createRange(); rg.setStart(n, 2); rg.setEnd(n, 4); r = rg.getBoundingClientRect(); }
          return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 };
        }, cs.act);
        note.hit = await p.evaluate((q) => { const e = document.elementFromPoint(q.x, q.y); return e ? e.tagName : null; }, q);
        await p.mouse.click(q.x, q.y);
      } else if (cs.act === 'editor') {
        const q = await p.evaluate(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 60, y: r.top + 10 }; });
        note.hit = await p.evaluate((q) => { const e = document.elementFromPoint(q.x, q.y); return e ? e.tagName + '.' + (e.className || '') : null; }, q);
        await p.mouse.click(q.x, q.y); await sleep(200);
        await p.keyboard.type('Z');
        note.edFocus = await p.evaluate(() => window.__mdr.app.editor.view.hasFocus);
      } else if (cs.act === 'tab') {
        await p.evaluate(() => { const b = document.querySelector('.mdr-preview li input[type=checkbox]'); b.focus(); });
        await p.keyboard.press('Tab');
        note.focused = await p.evaluate(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.closest('li').textContent.trim().slice(0, 16) : a && a.tagName; });
        await p.keyboard.press('Space');
      }
      await sleep(700); await p.evaluate(() => window.__mdr.waitIdle()); await sleep(200);
      const after = await p.evaluate(() => window.__mdr.app.getText());
      const bl = before.split('\n'), al = after.split('\n');
      const changed = al.map((l, i) => (l !== bl[i] ? `${i + 1}:${l}` : null)).filter(Boolean);
      const toasts = await p.evaluate(() => window.__chc.toasts.map((t) => t.text));
      return { ...note, changed, toasts };
    }));
    console.log(nm, J({ cand: r[0], base: r[1] }));
  }
} finally {
  clearTimeout(killer);
  await Promise.all([C.browser.close(), B.browser.close()]);
}
