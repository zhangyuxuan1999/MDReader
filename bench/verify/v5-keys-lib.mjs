// bench/verify/v5-keys-lib.mjs — verify-session-keys (round 4 re-verification): shared helpers for the v5-keys-*
// scripts. Uses the renderer already listening on MDR_PORT (never starts or kills a server). Switch ON (dev server:
// nothing stored counts as on). Exports open(): { page, B, ...helpers }.
import { openBrowser, sleep } from './v2-app-lib.mjs';
export { sleep };
export const J = JSON.stringify;
export const ZWS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join('');

export async function open(opts = {}) {
  const B = await openBrowser({ viewport: opts.viewport ?? { width: 1400, height: 1000 } });
  const { page } = B;
  await B.boot(opts.query ?? 'mode=split');
  await page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const o = { s: pv.applyStructure.bind(pv), d: pv.applyStructureDelta.bind(pv), h: pv.applyHtml.bind(pv) };
    window.__wd = 0; let q = Promise.resolve(); let last = 0;
    const wrap = (f) => (m) => {
      if (!window.__wd) { f(m); return true; }
      const at = Math.max(last, performance.now() + window.__wd); last = at;
      q = q.then(() => new Promise((r) => setTimeout(() => { try { f(m); } catch (e) { console.error(e); } r(); }, Math.max(0, at - performance.now()))));
      return true;
    };
    pv.applyStructure = wrap(o.s); pv.applyStructureDelta = wrap(o.d); pv.applyHtml = wrap(o.h);
    window.__toasts = []; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text));
  });
  const setDelay = (ms) => page.evaluate((ms) => { window.__wd = ms; }, ms);
  const src = () => page.evaluate(() => window.__mdr.app.getText());
  const idle = async (ms = 300) => { await setDelay(0); await sleep(ms); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(250); };
  const toasts = () => page.evaluate(() => window.__toasts.splice(0));
  const session = () => page.evaluate(() => {
    const e = document.querySelector('.mdr-preview .is-editing');
    if (!e) return null;
    const s = getSelection();
    let before = null;
    if (s.rangeCount && e.contains(s.anchorNode)) { const r = document.createRange(); r.setStart(e, 0); r.setEnd(s.anchorNode, s.anchorOffset); before = r.toString(); }
    return { id: e.dataset.id, focused: document.activeElement === e || e.contains(document.activeElement), text: e.textContent, before };
  });
  async function load(text) {
    await setDelay(0);
    await page.keyboard.press('Escape').catch(() => {});
    await B.loadDoc(text);
    await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); window.__mdr.app.preview.scrollToLine(1, 0, 'instant'); });
    await sleep(700);
    await toasts();
  }
  /** Real click on the first occurrence of `needle` in the preview (offset k inside it, side left/right of that char). */
  async function clickText(needle, k = 0, nth = 0) {
    const pt = await page.evaluate(({ needle, k, nth }) => {
      const pv = window.__mdr.app.preview.el;
      const w = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        let i = n.data.indexOf(needle);
        while (i >= 0) {
          if (seen++ === nth) {
            const rg = document.createRange(); rg.setStart(n, i + k); rg.setEnd(n, i + k + 1);
            const b0 = rg.getBoundingClientRect(), box = pv.getBoundingClientRect();
            if (b0.top < box.top + 5 || b0.bottom > box.bottom - 5) pv.scrollTop += b0.top - (box.top + box.height / 2);
            const r = rg.getClientRects()[0] ?? rg.getBoundingClientRect();
            return { x: r.left + 1, y: r.top + r.height / 2 };
          }
          i = n.data.indexOf(needle, i + 1);
        }
      }
      return null;
    }, { needle, k, nth });
    if (!pt) throw new Error(`clickText: ${needle}#${nth} not found`);
    await page.mouse.click(pt.x, pt.y);
  }
  /** Selects the whole content of the editing block (DOM range), as the earlier scripts did. */
  const selectBlock = () => page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing'); if (!el) return false;
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  });
  /** Caret after the first occurrence of needle in the editing block's joined text. */
  const caretAfter = (needle, mode = 'after', nth = 0) => page.evaluate(({ needle, mode, nth }) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    if (!el) throw new Error('no session');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = []; let all = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    let i = all.indexOf(needle);
    for (let k = 0; k < nth && i >= 0; k++) i = all.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`caret: ${needle}#${nth} not in ${all}`);
    const off = mode === 'after' ? i + needle.length : i;
    // the text node holding the needle's edge (at a tie the earlier node's end for 'after', the later node's start for
    // 'before'), never a whitespace node between elements
    let node = nodes[0][0], o = 0;
    for (let k = 0; k < nodes.length; k++) {
      const [n, st] = nodes[k];
      const inside = mode === 'after' ? (st < off && off <= st + n.data.length) : (st <= off && off < st + n.data.length);
      if (inside) { node = n; o = off - st; break; }
    }
    const r = document.createRange(); r.setStart(node, o); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, { needle, mode, nth });
  const screen = () => page.evaluate(() => {
    const pv = document.querySelector('.mdr-preview');
    const c = pv.cloneNode(true);
    c.querySelectorAll('[data-mdr-ui], .edit-hint, textarea, .md-code__lang, button').forEach((e) => e.remove());
    c.querySelectorAll('.md-math, .katex').forEach((e) => e.replaceWith('§'));
    c.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr, td, th, div, br').forEach((e) => { e.before(' '); e.after(' '); });
    c.querySelectorAll('input[type=checkbox]').forEach((e) => e.replaceWith(e.checked ? '[x]' : '[ ]'));
    const zw = new RegExp('[' + [0x200b, 0xfeff, 0x2060].map((x) => String.fromCharCode(x)).join('') + ']', 'g');
    return c.textContent.replace(zw, '').replace(/\s+/g, ' ').trim();
  });
  const editorEdit = (from, insert, to = from) => page.evaluate(({ from, insert, to }) => {
    const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from, to, insert }, userEvent: 'input.type' });
  }, { from, insert, to });
  return { B, page, setDelay, src, idle, toasts, session, load, clickText, selectBlock, caretAfter, screen, editorEdit, close: () => B.browser.close() };
}
