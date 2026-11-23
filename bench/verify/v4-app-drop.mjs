// bench/verify/v4-app-drop.mjs — verify-app (0.2.0 stage 2d). H2 / U17 on the app side: after a FILE drop
// (synthetic DragEvent with a real DataTransfer + File, web build) the editor, the preview, the title, the
// dirty flag and the stored drafts agree, also when the drop lands on a live preview session, on an emptied
// block, on the TOC / status bar / toolbar, or while the find panel has the focus.
// Prints RESULT lines (values) so candidate and baseline can be diffed.
//   Candidate:   MDR_PORT=5436 node bench/verify/v4-app-drop.mjs [filter]
//   Baseline:    MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-drop.mjs [filter]
// On the baseline (no preview editing) the "session" steps type into the editor pane instead.
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = ['# 原文档', '', '甲段落文字 alpha。', '', '乙段落文字 beta。', '', '- 项一', '- 项二', ''].join('\n');
const DROPPED = '# DROPPED 标题\n\n拖入的正文 dropped body.\n';
const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
const answer = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label);
  if (!b) return false; b.click(); return true;
}, label);
const drafts = () => page.evaluate(async () => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return [];
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      try {
        const st = db.transaction('keyval', 'readonly').objectStore('keyval');
        const out = [];
        const c = st.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { res(out); db.close(); return; }
          if (String(cur.key).startsWith('mdr.draft:')) out.push({ key: String(cur.key).slice(10), text: String(cur.value?.text ?? '') });
          cur.continue();
        };
        c.onerror = () => { res(out); db.close(); };
      } catch { res([]); db.close(); }
    };
    r.onerror = () => res([]);
  });
});
/** Dispatches dragenter/dragover/drop with files on the element matched by `sel` (or at a point). */
const drop = (sel, files) => page.evaluate(({ sel, files }) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }));
  const el = typeof sel === 'string' ? document.querySelector(sel) : document.elementFromPoint(sel.x, sel.y);
  if (!el) return `no element ${JSON.stringify(sel)}`;
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + Math.min(20, r.width / 2), clientY: r.top + Math.min(10, r.height / 2) };
  const res = {};
  for (const e of ['dragenter', 'dragover', 'drop']) { const ev = new DragEvent(e, o); el.dispatchEvent(ev); res[e] = ev.defaultPrevented; }
  return { target: el.tagName + '.' + String(el.className).split(' ')[0], prevented: res };
}, { sel, files });
const MD = (name, text = DROPPED) => ({ name, text, type: 'text/markdown' });
const snap = async () => page.evaluate(() => {
  const pv = document.querySelector('.mdr-preview');
  return {
    title: document.title,
    editor: window.__mdr.app.getText(),
    previewHead: pv.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
    editing: !!pv.querySelector('.is-editing, [contenteditable="true"]'),
    ghosts: pv.querySelectorAll('.is-gone, .md-block--gone, [data-mdr-gone]').length,
    dupIds: (() => { const ids = [...pv.querySelectorAll('.md-block[data-id]')].map((e) => e.dataset.id); return ids.length - new Set(ids).size; })(),
    dragover: document.querySelector('.is-dragover') !== null,
  };
});
const isSession = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
async function startSession(needle) {
  if (!(await page.evaluate(() => typeof window.__mdr.app.preview.elementOfBlock === 'function'))) return false;   // 0.1.1: no preview editing
  const line = DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
  await B.clickLine(line, 'first', needle.slice(0, 2));
  await sleep(150);
  const s = await isSession();
  if (s) await B.caretAt(needle);
  return s;
}
async function typeSomewhere(needle, text) {
  const s = await startSession(needle);
  if (s) { await page.keyboard.type(text); return 'session'; }
  await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(text); return 'editor';
}
const reset = async (name = 'orig.md') => {
  await page.keyboard.press('Escape');
  await answer('取消');
  await B.loadDoc('', 'reset.md');
  await B.loadDoc(DOC, name);
  await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); window.__mdr.app.preview.scrollToLine(1, 0, 'instant'); });
  await sleep(700);
};
const probe = async (k, fn) => { if (only && !k.startsWith(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };

try {
  await B.boot('mode=split');
  await probe('D1 clean doc, idle session, drop on the session block', async () => {
    await reset();
    const s = await startSession('乙段落文字');
    const d = await drop('.mdr-preview .is-editing, .mdr-preview .md-block:nth-of-type(3)', [MD('d1.md')]);
    await sleep(1200);
    const q = await dialogs();
    const st = await snap();
    await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+z'); await B.settle(200);
    return { s, d, q, ...st, afterUndo: (await B.source()) === DROPPED };
  });
  await probe('D2 session typed XY 0 ms, drop on the session block: question; 取消 then 丢弃', async () => {
    await reset();
    const how = await typeSomewhere('乙段落文字 beta。', 'XY');
    const d = await drop(how === 'session' ? '.mdr-preview .is-editing' : '.cm-content', [MD('d2.md')]);
    await sleep(1000);
    const q1 = await dialogs();
    await answer('取消'); await B.settle(300);
    const afterCancel = await snap();
    const sessionAfterCancel = await isSession();
    await page.keyboard.type('Z'); await B.settle(300);
    const srcZ = await B.source();
    const d2 = await drop('.mdr-preview', [MD('d2.md')]);
    await sleep(1000);
    const q2 = await dialogs();
    await answer('丢弃'); await sleep(1200); await B.settle(200);
    const afterDiscard = await snap();
    await sleep(1500);
    const dr = (await drafts()).map((x) => ({ key: x.key.slice(0, 20), hasXY: x.text.includes('XY') }));
    return { how, d: d.prevented, q1, cancelEditorHasXY: afterCancel.editor.includes('XY'), cancelTitle: afterCancel.title, sessionAfterCancel, zAfterCancel: srcZ.includes('XYZ') ? 'XYZ' : srcZ.includes('Z') ? 'Z elsewhere' : 'lost', d2: d2.prevented, q2, discard: { ...afterDiscard, editorIsDropped: afterDiscard.editor === DROPPED, editor: undefined }, drafts: dr };
  });
  await probe('D3 emptied block, drop on it: question; 丢弃', async () => {
    await reset();
    const s = await startSession('乙段落文字');
    let how = 'editor';
    if (s) {
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el); const g = getSelection(); g.removeAllRanges(); g.addRange(r); });
      await page.keyboard.press('Backspace'); how = 'session';
    } else { await page.click('.cm-content'); await page.keyboard.type('E'); }
    await sleep(30);
    const d = await drop(how === 'session' ? '.mdr-preview .is-editing' : '.cm-content', [MD('d3.md')]);
    await sleep(1000);
    const q = await dialogs();
    await answer('丢弃'); await sleep(1200); await B.settle(200);
    const st = await snap();
    return { how, d: d.prevented, q, ...st, editorIsDropped: st.editor === DROPPED, editor: undefined };
  });
  for (const [k, sel] of [['toc', '.mdr-toc'], ['statusbar', '.mdr-statusbar'], ['toolbar', '.mdr-toolbar'], ['gutter', '.cm-gutters'], ['editor-empty-area', '.cm-scroller']]) {
    await probe(`D4 dirty doc (editor typing), drop on ${k}`, async () => {
      await reset();
      await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('Q'); await B.settle(200);
      const d = await drop(sel, [MD(`d4-${k}.md`)]);
      await sleep(1000);
      const q = await dialogs();
      await answer('丢弃'); await sleep(1200);
      const st = await snap();
      return { d: typeof d === 'string' ? d : d.prevented, q: q.length, editorIsDropped: st.editor === DROPPED, title: st.title, dragover: st.dragover };
    });
  }
  await probe('D5 drop of [png, md] on the preview of a clean doc', async () => {
    await reset();
    const d = await drop('.mdr-preview', [{ name: 'pic.png', text: 'PNG', type: 'image/png' }, MD('d5.md')]);
    await sleep(1200);
    const st = await snap();
    return { d: d.prevented, q: await dialogs(), toasts: (await toasts()).slice(-2), editorIsDropped: st.editor === DROPPED, title: st.title };
  });
  await probe('D6 find panel open with focus in its field, drop on the editor', async () => {
    await reset();
    await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+f'); await sleep(300);
    await page.keyboard.type('alp');
    const d = await drop('.cm-line', [MD('d6.md')]);
    await sleep(1200);
    const st = await snap();
    const field = await page.evaluate(() => document.querySelector('.cm-search input[name=search], .cm-textfield')?.value ?? null);
    return { d: d.prevented, q: await dialogs(), editorIsDropped: st.editor === DROPPED, title: st.title, field };
  });
  await probe('D7 png dropped on a live session holding XY: toast, text kept, session usable', async () => {
    await reset();
    const how = await typeSomewhere('甲段落文字 alpha。', 'XY');
    const d = await drop(how === 'session' ? '.mdr-preview .is-editing' : '.cm-content', [{ name: 'pic.png', text: 'PNG', type: 'image/png' }]);
    await sleep(600);
    await page.keyboard.type('W'); await B.settle(300);
    const src = await B.source();
    const st = await snap();
    return { how, d: d.prevented, toasts: (await toasts()).slice(-1), q: await dialogs(), xyw: src.includes('XYW') ? 'XYW' : src.includes('XY') ? 'XY only' : 'lost', title: st.title, editing: st.editing };
  });
  await probe('D8 dropped doc then type in it: draft holds only the new text', async () => {
    await reset();
    await drop('.mdr-preview', [MD('d8.md')]);
    await sleep(1200);
    await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('NEW'); await sleep(2500);
    const dr = await drafts();
    return { title: await page.evaluate(() => document.title), drafts: dr.map((x) => ({ key: x.key.slice(0, 24), isNew: x.text === DROPPED + 'NEW', hasOrig: x.text.includes('原文档') })) };
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
