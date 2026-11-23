// bench/verify/v5-offp-probes.mjs — verify-off-preview: gestures with 预览可编辑 OFF that the audit matrix does not
// have, each applied to the candidate and to 0.1.1 and compared with the observations of bench/verify/v5-offd-lib.mjs
// (copied text/html byte for byte after the two origins are made equal): a real IME composition (CDP) with the focus
// in the preview, held-key repeat (ArrowDown / PageDown / Space / Shift+ArrowRight for 2 s), keys pressed during a
// pointer drag (Shift, Escape, a letter, ⌘C), a drag that leaves the window, a mode switch in the middle of a drag,
// ⌘A then typing, Shift+arrows after a double-click word selection, a context-menu press on a link / image / text,
// a wheel during a drag.
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 MDR_STRICT_CLIP=1 node bench/verify/v5-offp-probes.mjs [name ...]
// Global timeout 115 s (run a few names per call). Writes nothing into the tree.
import * as L from './v5-offd-lib.mjs';

L.globalTimeout(Number(process.env.MDR_TIMEOUT || 115000));
const only = process.argv.slice(2);
const normClip = (o) => { if (o && o.clip && typeof o.clip['text/html'] === 'string') o.clip['text/html'] = o.clip['text/html'].replace(/localhost:\d+/g, 'ORIGIN'); return o; };

async function textPt(S, needle, k = 0) {
  return S.page.evaluate(([needle, k]) => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const q = r.getBoundingClientRect();
      if (q.top < root.getBoundingClientRect().top || q.bottom > root.getBoundingClientRect().bottom) { n.parentElement.scrollIntoView({ block: 'center' }); const q2 = r.getBoundingClientRect(); return { x: q2.left + 1, y: q2.top + q2.height / 2 }; }
      return { x: q.left + 1, y: q.top + q.height / 2 };
    }
    return null;
  }, [needle, k]);
}
const D = (S) => S.page;

const PROBES = {
  // a real composition (CDP Input.imeSetComposition / insertText) after a click on preview text
  'ime-real': ['small', async (S) => {
    const q = await textPt(S, '这是一个', 2); await D(S).mouse.click(q.x, q.y); await L.sleep(200);
    const cdp = await D(S).context().newCDPSession(D(S));
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }); await L.sleep(80);
    await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 }); await L.sleep(80);
    await cdp.send('Input.insertText', { text: '你好' }); await L.sleep(300);
    await cdp.detach();
  }],
  'repeat-arrowdown': ['small', async (S) => { const q = await textPt(S, '这是一个', 2); await D(S).mouse.click(q.x, q.y); await L.sleep(150); for (let i = 0; i < 60; i++) { await D(S).keyboard.down('ArrowDown'); await L.sleep(33); } await D(S).keyboard.up('ArrowDown'); }],
  'repeat-pagedown': ['small', async (S) => { const q = await textPt(S, '这是一个', 2); await D(S).mouse.click(q.x, q.y); await L.sleep(150); for (let i = 0; i < 20; i++) { await D(S).keyboard.down('PageDown'); await L.sleep(50); } await D(S).keyboard.up('PageDown'); }],
  'repeat-space': ['small', async (S) => { const q = await textPt(S, '这是一个', 2); await D(S).mouse.click(q.x, q.y); await L.sleep(150); for (let i = 0; i < 20; i++) { await D(S).keyboard.down(' '); await L.sleep(50); } await D(S).keyboard.up(' '); }],
  'repeat-shift-right': ['small', async (S) => { const q = await textPt(S, '这是一个', 0); await D(S).mouse.click(q.x, q.y); await L.sleep(150); await D(S).keyboard.down('Shift'); for (let i = 0; i < 40; i++) { await D(S).keyboard.down('ArrowRight'); await L.sleep(33); } await D(S).keyboard.up('ArrowRight'); await D(S).keyboard.up('Shift'); await D(S).keyboard.press('Meta+c'); }],
  'drag-keys': ['rich', async (S) => {
    const a = await textPt(S, 'First', 0) || await textPt(S, 'a', 0); const b = await textPt(S, 'e', 0);
    const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down();
    for (let i = 1; i <= 8; i++) { await p.mouse.move(a.x + 20 * i, a.y + 14 * i); await L.sleep(25); }
    await p.keyboard.down('Shift'); await L.sleep(30); await p.keyboard.up('Shift');
    await p.keyboard.press('a'); await p.keyboard.press('Meta+c'); await p.keyboard.press('Escape');
    for (let i = 9; i <= 14; i++) { await p.mouse.move(a.x + 20 * i, a.y + 14 * i); await L.sleep(25); }
    await p.mouse.up(); void b; await L.sleep(150); await p.keyboard.press('Meta+c');
  }],
  'drag-leave-window': ['small', async (S) => {
    const a = await textPt(S, '这是一个', 0); const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down();
    for (let i = 1; i <= 10; i++) { await p.mouse.move(a.x + 30 * i, a.y + 20 * i); await L.sleep(25); }
    for (let i = 1; i <= 10; i++) { await p.mouse.move(1400 + 30 * i, 900 + 20 * i); await L.sleep(40); }
    await L.sleep(400); await p.mouse.move(a.x + 200, a.y + 100); await p.mouse.up(); await L.sleep(200); await p.keyboard.press('Meta+c');
  }],
  'drag-mode-switch': ['small', async (S) => {
    const a = await textPt(S, '这是一个', 0); const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down();
    for (let i = 1; i <= 6; i++) { await p.mouse.move(a.x + 30 * i, a.y + 20 * i); await L.sleep(25); }
    await p.evaluate(() => window.__mdr.mode('preview')); await L.sleep(300);
    for (let i = 7; i <= 12; i++) { await p.mouse.move(a.x + 30 * i, a.y + 20 * i); await L.sleep(25); }
    await p.mouse.up(); await L.sleep(200); await p.keyboard.press('Meta+c');
    await p.evaluate(() => window.__mdr.mode('split')); S.mode = 'split'; await L.sleep(300);
  }],
  'drag-wheel': ['small', async (S) => {
    const a = await textPt(S, '这是一个', 0); const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down();
    for (let i = 1; i <= 6; i++) { await p.mouse.move(a.x + 30 * i, a.y + 10 * i); await L.sleep(25); }
    await p.mouse.wheel(0, 500); await L.sleep(400); await p.mouse.move(a.x + 220, a.y + 80); await p.mouse.up(); await L.sleep(200); await p.keyboard.press('Meta+c');
  }],
  'selall-type': ['rich', async (S) => { const q = await textPt(S, 'e', 0); await D(S).mouse.click(q.x, q.y); await L.sleep(150); await D(S).keyboard.press('Meta+a'); await L.sleep(100); await D(S).keyboard.type('abc 中'); await D(S).keyboard.press('Backspace'); await D(S).keyboard.press('Enter'); }],
  'dbl-shift-arrows': ['small', async (S) => { const q = await textPt(S, 'Markdown', 3); await D(S).mouse.dblclick(q.x, q.y); await L.sleep(200); for (const k of ['Shift+ArrowRight', 'Shift+ArrowRight', 'Alt+Shift+ArrowRight', 'Shift+ArrowDown', 'Shift+ArrowLeft']) await D(S).keyboard.press(k); await D(S).keyboard.press('Meta+c'); }],
  'triple-shift-down': ['small', async (S) => { const q = await textPt(S, '这是一个', 3); await D(S).mouse.click(q.x, q.y, { clickCount: 1 }); await D(S).mouse.click(q.x, q.y, { clickCount: 2 }); await D(S).mouse.click(q.x, q.y, { clickCount: 3 }); await L.sleep(200); await D(S).keyboard.press('Shift+ArrowDown'); await D(S).keyboard.press('Shift+ArrowDown'); await D(S).keyboard.press('Meta+c'); }],
  'ctx-link': ['rich', async (S) => { const q = await S.page.evaluate(() => { const a = document.querySelector('.mdr-preview a[href]'); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 }; }); await D(S).mouse.click(q.x, q.y, { button: 'right' }); await L.sleep(200); await D(S).keyboard.press('Escape'); }],
  'ctx-img': ['rich', async (S) => { const q = await S.page.evaluate(() => { const a = document.querySelector('.mdr-preview img'); if (!a) return null; a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.left + 3, y: r.top + 3 }; }); if (q) { await D(S).mouse.click(q.x, q.y, { button: 'right' }); await L.sleep(200); await D(S).keyboard.press('Escape'); } }],
  'ctx-selection-copy': ['small', async (S) => { const q = await textPt(S, 'Markdown', 3); await D(S).mouse.dblclick(q.x, q.y); await L.sleep(150); await D(S).mouse.click(q.x, q.y, { button: 'right' }); await L.sleep(150); await D(S).keyboard.press('Escape'); await D(S).keyboard.press('Meta+c'); }],
  'typing-during-drag-editor': ['small', async (S) => {
    // a drag selection in the preview held while the document changes in the editor pane (dispatched edit at the top)
    const a = await textPt(S, '这是一个', 0); const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down();
    for (let i = 1; i <= 6; i++) { await p.mouse.move(a.x + 30 * i, a.y + 20 * i); await L.sleep(25); }
    await p.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'Typed above.\n\n' }, userEvent: 'input.type' }); });
    await L.sleep(300);
    for (let i = 7; i <= 10; i++) { await p.mouse.move(a.x + 30 * i, a.y + 20 * i); await L.sleep(25); }
    await p.mouse.up(); await L.sleep(300); await p.keyboard.press('Meta+c');
  }],
  // selections that start outside every block (J5 without a session): beside a block, below the last block, in the
  // preview's left padding, and from the blank space up over several blocks; each then copied
  'drag-beside-in': ['rich', async (S) => { const p = D(S); const q = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const s = Array.from(root.querySelectorAll('section.md-block')).find((x) => x.querySelector('p') && x.getBoundingClientRect().top > root.getBoundingClientRect().top + 60); const r = s.getBoundingClientRect(); const pr = root.getBoundingClientRect(); return { x: pr.right - 30, y: r.top + 4 }; }); const t = await textPt(S, 'e', 0); await p.mouse.move(q.x, q.y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(q.x + (t.x - q.x) * i / 10, q.y + (t.y - q.y) * i / 10); await L.sleep(25); } await p.mouse.up(); await L.sleep(150); await p.keyboard.press('Meta+c'); }],
  'drag-gutter-down': ['small', async (S) => { const p = D(S); const q = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const pr = root.getBoundingClientRect(); return { x: pr.left + 3, y: pr.top + 80 }; }); await p.mouse.move(q.x, q.y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(q.x + 2, q.y + 30 * i); await L.sleep(25); } await p.mouse.up(); await L.sleep(150); await p.keyboard.press('Meta+c'); }],
  'drag-gutter-up-back': ['small', async (S) => { const p = D(S); const q = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const pr = root.getBoundingClientRect(); return { x: pr.left + 3, y: pr.top + 500 }; }); await p.mouse.move(q.x, q.y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(q.x + 40 * i, q.y - 35 * i); await L.sleep(25); } await p.mouse.up(); await L.sleep(150); await p.keyboard.press('Meta+c'); }],
  'drag-below-up': ['rich', async (S) => { const p = D(S); await p.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = r.scrollHeight; }); await L.settle(S, 600); const q = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const pr = root.getBoundingClientRect(); return { x: pr.left + pr.width / 2, y: pr.bottom - 12 }; }); await p.mouse.move(q.x, q.y); await p.mouse.down(); for (let i = 1; i <= 12; i++) { await p.mouse.move(q.x - 15 * i, q.y - 30 * i); await L.sleep(25); } await p.mouse.up(); await L.sleep(150); await p.keyboard.press('Meta+c'); }],
  'blank-click-selall-copy': ['rich', async (S) => { const p = D(S); const q = await p.evaluate(() => { const root = document.querySelector('.mdr-preview'); const pr = root.getBoundingClientRect(); return { x: pr.right - 20, y: pr.top + 40 }; }); await p.mouse.click(q.x, q.y); await L.sleep(150); await p.keyboard.press('Meta+a'); await p.keyboard.press('Meta+c'); }],
  // the tab hidden (another tab in front) while the document changes in the editor (dispatched edits above a task),
  // then shown again; a drag-copy and a task tick right after it is shown
  'hidden-tab-edit-tick': ['tasks', async (S) => {
    const p = D(S);
    const other = await S.context.newPage(); await other.goto('about:blank'); await other.bringToFront(); await L.sleep(300);
    S.hiddenState = await p.evaluate(() => document.visibilityState);
    await p.evaluate(() => { const v = window.__mdr.app.editor.view; for (let i = 0; i < 30; i++) v.dispatch({ changes: { from: 0, insert: 'h' + i + '\n\n' }, userEvent: 'input.type' }); });
    await L.sleep(1500);
    await p.bringToFront(); await other.close(); await L.sleep(30);
    const b = await p.evaluate(() => { const x = document.querySelectorAll('.mdr-preview li input[type=checkbox]')[1]; if (!x) return null; x.scrollIntoView({ block: 'center' }); const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (b) await p.mouse.click(b.x, b.y);
    await L.sleep(400);
  }],
  // real clipboard contents pasted with ⌘V while the focus is in the preview, and drops of a link / an image file
  'paste-real-html': ['rich', async (S) => { const p = D(S); const q = await textPt(S, 'e', 0); await p.mouse.click(q.x, q.y); await L.sleep(150); await p.evaluate(async () => { const it = new ClipboardItem({ 'text/html': new Blob(['<b>bold</b> <a href="https://x.example/">l</a>'], { type: 'text/html' }), 'text/plain': new Blob(['bold l'], { type: 'text/plain' }) }); await navigator.clipboard.write([it]); }); await p.keyboard.press('Meta+v'); await L.sleep(300); }],
  'paste-real-image': ['rich', async (S) => { const p = D(S); const q = await textPt(S, 'e', 0); await p.mouse.click(q.x, q.y); await L.sleep(150); await p.evaluate(async () => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; const blob = await new Promise((r) => c.toBlob(r, 'image/png')); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); }); await p.keyboard.press('Meta+v'); await L.sleep(300); }],
  'drop-link-image': ['rich', async (S) => { const p = D(S); const q = await textPt(S, 'e', 0); const r = await p.evaluate(async (q) => { const t = document.elementFromPoint(q.x, q.y); const out = []; for (const mk of ['link', 'image']) { const dt = new DataTransfer(); if (mk === 'link') { dt.setData('text/uri-list', 'https://x.example/a'); dt.setData('text/plain', 'https://x.example/a'); } else { const c = document.createElement('canvas'); c.width = 4; c.height = 4; const blob = await new Promise((rs) => c.toBlob(rs, 'image/png')); dt.items.add(new File([blob], 'pic.png', { type: 'image/png' })); } const o = { dataTransfer: dt, bubbles: true, cancelable: true, composed: true, clientX: q.x, clientY: q.y }; for (const ty of ['dragenter', 'dragover', 'drop']) { const e = new DragEvent(ty, o); t.dispatchEvent(e); out.push(mk + ':' + ty + (e.defaultPrevented ? '!' : '')); } } return out.join(' '); }, q); S.dropRet = r; await L.sleep(500); }],
  // a preview selection (no session) whose OWN block re-renders because the editor changed that block
  'sel-block-rerender-word': ['small', async (S) => {
    const q = await textPt(S, 'Markdown', 3); await D(S).mouse.dblclick(q.x, q.y); await L.sleep(150);
    await S.page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.indexOf('这是一个用于性能测试的段落'); v.dispatch({ changes: { from: i, insert: 'QQ' }, userEvent: 'input.type' }); });
    await L.sleep(700); await D(S).keyboard.press('Meta+c');
  }],
  'sel-block-rerender-span': ['small', async (S) => {
    const a = await textPt(S, '这是一个', 2); const b = await textPt(S, 'quick', 2); const p = D(S); await p.mouse.move(a.x, a.y); await p.mouse.down(); for (let i = 1; i <= 8; i++) { await p.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8); await L.sleep(25); } await p.mouse.up(); await L.sleep(150);
    await S.page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.indexOf('The quick'); v.dispatch({ changes: { from: i, insert: 'ZZ ' }, userEvent: 'input.type' }); });
    await L.sleep(700); await p.keyboard.press('Shift+ArrowRight'); await p.keyboard.press('Meta+c');
  }],
  'sel-block-rerender-shiftclick': ['small', async (S) => {
    const q = await textPt(S, 'Markdown', 3); await D(S).mouse.click(q.x, q.y); await L.sleep(150);
    await S.page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc.toString(); const i = d.indexOf('这是一个用于性能测试的段落'); v.dispatch({ changes: { from: i, insert: 'QQ' }, userEvent: 'input.type' }); });
    await L.sleep(700); const r = await textPt(S, '流畅', 1); await D(S).keyboard.down('Shift'); await D(S).mouse.click(r.x, r.y); await D(S).keyboard.up('Shift'); await L.sleep(150); await D(S).keyboard.press('Meta+c');
  }],
  'sel-survives-edit': ['small', async (S) => {
    const q = await textPt(S, 'Markdown', 3); await D(S).mouse.dblclick(q.x, q.y); await L.sleep(150);
    await D(S).page?.(); await S.page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '\n\nAppended at the end.\n' }, userEvent: 'input.type' }); });
    await L.sleep(500); await D(S).keyboard.press('Shift+ArrowRight'); await D(S).keyboard.press('Meta+c');
  }],
};

async function loadDoc(S, name) {
  const p = S.page;
  await p.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: L.docText(name), n: name + '.md' });
  await L.settle(S, 400);
  await p.evaluate(() => { getSelection().removeAllRanges(); const a = document.activeElement; if (a && a !== document.body) a.blur(); const r = document.querySelector('.mdr-preview'); const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = 0; if (r) r.scrollTop = 0; });
  await L.settle(S, 600);
  await p.evaluate(() => navigator.clipboard.writeText('<<offp-none>>'));
  await p.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; O.errs.length = 0; });
  S.pageErrors.length = 0; S.navs.length = 0; S.pts = [];
}

const P = await L.openPair({});
try {
  for (const [nm, [doc, fn]] of Object.entries(PROBES)) {
    if (only.length && !only.some((o) => nm.startsWith(o))) continue;
    await Promise.all([loadDoc(P.cand, doc), loadDoc(P.base, doc)]);
    let ec = null, eb = null;
    await Promise.all([fn(P.cand).catch((e) => { ec = String(e.message).slice(0, 120); }), fn(P.base).catch((e) => { eb = String(e.message).slice(0, 120); })]);
    await Promise.all([L.settle(P.cand, 400), L.settle(P.base, 400)]);
    const look = async () => { const [c, b] = await Promise.all([L.obs(P.cand, { clip: true }), L.obs(P.base, { clip: true })]); return [c, b, L.diff(normClip(c), normClip(b), {})]; };
    let [c, b, d] = await look();
    if (d.length) { await L.sleep(900); [c, b, d] = await look(); }
    const clipNote = c.clip && c.clip['text/plain'] !== '<<offp-none>>' ? ` clip=${JSON.stringify(c.clip['text/plain']).slice(0, 50)}` : '';
    console.log(nm, d.length ? 'DIFF ' + L.fmtDiff(d) : 'same', ec || eb ? `errors cand=${ec} base=${eb}` : '', clipNote);
    if (d.length && process.env.MDR_VERBOSE) for (const x of d) console.log('   ', x.field, JSON.stringify(x.cand)?.slice(0, 500), '|', JSON.stringify(x.base)?.slice(0, 500));
  }
} finally {
  await L.closeAll();
  process.exit(0);
}
