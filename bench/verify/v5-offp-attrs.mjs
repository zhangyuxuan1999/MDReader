// bench/verify/v5-offp-attrs.mjs — verify-off-preview: the attributes and leftovers a user could notice with 预览可编辑
// OFF: every attribute of the preview root, its scroller ancestors and every block wrapper (spellcheck, autocorrect,
// autocapitalize, contenteditable, tabindex, role, aria-*, class, style), elements inside the preview that are not
// blocks (a capture textarea, a hint), the preview's scroll height, and zero-width characters in the preview's text;
// compared between 0.1.1 and the candidate (a) never switched on, (b) after the switch was turned on, sessions used
// (typing, Esc, a click elsewhere, a mode switch, a waiting click with a slow re-render) and turned off again.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 node bench/verify/v5-offp-attrs.mjs
// Global timeout 110 s. Writes nothing into the tree.
import * as L from './v5-offd-lib.mjs';

L.globalTimeout(110000);
const ATTRS = () => {
  const root = document.querySelector('.mdr-preview');
  const out = {};
  const desc = (e) => Array.from(e.attributes).filter((a) => !/^(data-id|data-mdr-x)$/.test(a.name)).map((a) => `${a.name}=${a.name === 'style' ? a.value.replace(/[\d.]+px/g, 'Npx') : a.value}`).sort().join(' ');
  out.root = desc(root);
  let p = root.parentElement, k = 0; while (p && k < 4) { out['up' + k] = p.tagName + ' ' + desc(p); p = p.parentElement; k++; }
  out.sections = Array.from(root.querySelectorAll('section.md-block')).map((s) => desc(s)).filter((x, i, a) => a.indexOf(x) === i);
  out.nonBlocks = Array.from(root.children).filter((c) => !c.matches('section.md-block, .md-chunk, [data-mdr-ui]')).map((c) => c.tagName + '.' + c.className);
  out.deep = Array.from(root.querySelectorAll('textarea, [contenteditable], [spellcheck], [autocorrect], [tabindex]')).map((e) => e.tagName + ' ' + desc(e)).slice(0, 10);
  const zw = Array.from(root.textContent).filter((ch) => ch.charCodeAt(0) === 0x200b || ch.charCodeAt(0) === 0xfeff).length;
  out.zw = zw;
  out.scrollH = root.scrollHeight; out.clientH = root.clientHeight;
  out.active = document.activeElement ? document.activeElement.tagName : null;
  return out;
};
const DOC = L.docText('rich');
const SHORT = 'Short.\n\nTwo lines only.\n';

async function load(S, t) { await S.page.evaluate(({ t }) => window.__mdr.loadText(t, 'a.md'), { t }); await L.settle(S, 500); }
async function look(S) { return S.page.evaluate(ATTRS); }

const P = await L.openPair({});
try {
  await Promise.all([load(P.cand, DOC), load(P.base, DOC)]);
  const [c0, b0] = await Promise.all([look(P.cand), look(P.base)]);
  console.log('never-on', JSON.stringify(c0) === JSON.stringify(b0) ? 'same' : 'DIFF', JSON.stringify(c0) === JSON.stringify(b0) ? '' : JSON.stringify({ c0, b0 }).slice(0, 1500));
  // candidate: on, sessions, a waiting click with a slow re-render, off
  const p = P.cand.page;
  await p.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit')); await L.sleep(300);
  const pt = async (sel) => p.evaluate((sel) => { const e = Array.from(document.querySelectorAll('.mdr-preview ' + sel)).find((x) => x.textContent.length > 8); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 6 }; }, sel);
  let q = await pt('p'); await p.mouse.click(q.x, q.y); await L.sleep(300); await p.keyboard.type('Zq'); await L.sleep(150); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await L.sleep(150); await p.keyboard.press('Escape'); await L.sleep(400);
  q = await pt('li'); await p.mouse.click(q.x, q.y); await L.sleep(300); await p.evaluate(() => window.__mdr.mode('preview')); await L.sleep(300); await p.evaluate(() => window.__mdr.mode('split')); await L.sleep(300);
  // a waiting click: slow re-render, an edit in the editor, then a click on the changed block and a key
  await p.evaluate(() => { const pv = window.__mdr.app.preview; const od = pv.applyStructureDelta.bind(pv), oh = pv.applyHtml.bind(pv); pv.applyStructureDelta = (m) => { setTimeout(() => od(m), 900); return true; }; pv.applyHtml = (m) => { setTimeout(() => oh(m), 900); }; window.__restore = () => { pv.applyStructureDelta = od; pv.applyHtml = oh; }; });
  await p.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.indexOf('\n\n') + 2; v.dispatch({ changes: { from: i, insert: 'W' }, userEvent: 'input.type' }); });
  q = await pt('p'); await p.mouse.click(q.x, q.y); await L.sleep(80);
  const capDuring = await p.evaluate(() => document.querySelectorAll('.mdr-preview textarea, textarea[data-mdr-ui]').length);
  // turned off while the click waits (⌘⇧E)
  await p.keyboard.press('Meta+Shift+e'); await L.sleep(1500);
  await p.evaluate(() => window.__restore()); await L.sleep(300);
  const pressed = await p.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
  // the same document on both sides again (the candidate's source got a W)
  await Promise.all([load(P.cand, DOC), load(P.base, DOC)]);
  const [c1, b1] = await Promise.all([look(P.cand), look(P.base)]);
  console.log('after-on-off', `switch=${pressed} capDuringWait=${capDuring}`, JSON.stringify(c1) === JSON.stringify(b1) ? 'same' : 'DIFF ' + JSON.stringify(Object.fromEntries(Object.keys(c1).filter((k) => JSON.stringify(c1[k]) !== JSON.stringify(b1[k])).map((k) => [k, { c: c1[k], b: b1[k] }]))).slice(0, 1500));
  // a shorter document: the scrollable height must be the document's
  await Promise.all([load(P.cand, SHORT), load(P.base, SHORT)]);
  const [c2, b2] = await Promise.all([look(P.cand), look(P.base)]);
  console.log('short-after', JSON.stringify(c2) === JSON.stringify(b2) ? 'same' : 'DIFF ' + JSON.stringify(Object.fromEntries(Object.keys(c2).filter((k) => JSON.stringify(c2[k]) !== JSON.stringify(b2[k])).map((k) => [k, { c: c2[k], b: b2[k] }]))).slice(0, 1500));
} finally {
  await L.closeAll();
  process.exit(0);
}
