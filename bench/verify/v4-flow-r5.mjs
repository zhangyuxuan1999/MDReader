// bench/verify/v4-flow-r5.mjs — verify-flows (round-3 re-verification): R5 (H5) variations. A crash draft is
// seeded in IndexedDB, the document opens with the recovery offer, the user changes the text and takes the
// change back in different ways; the crash draft must still be stored and be offered by the next tab.
//   [MDR_URL=http://localhost:5434/] [MDR_BASE_URL='http://localhost:5444/?perf=1' | ''] node bench/verify/v4-flow-r5.mjs [case …]
// The baseline (0.1.1) is expected to fail the take-back cases (H5 is pre-existing). Writes nothing into the
// tree. Global timeout 110 s.
import { sleep, until, runBoth, seedDraft, storedRecord, toasts, offers, toastButton, answer, hide, unhide, bootAt, opfsOpen, opfsRead, allDrafts } from './v4-flow-lib.mjs';

const FUTURE = () => Date.now() + 3600_000;
const CRASH = 'CRASH TEXT\n';
async function offered(page, text, name) {
  await seedDraft(page, { docId: `text:${name}`, version: 9, text: CRASH, at: FUTURE() });
  await page.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]);
  return !!(await until(page, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000));
}
async function nextTab(ctx, url, text, name) {
  const p2 = await ctx.newPage();
  await bootAt(p2, url);
  await p2.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]);
  await sleep(900);
  const n2 = await offers(p2);
  await p2.close();
  return n2;
}
const keys = async (page, list) => {
  for (const k of list) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); await sleep(25); }
};
/** Generic: offer, focus the editor at the end, run `act`, wait past the debounce, hide the tab, read the store,
 *  close without beforeunload, and ask a fresh tab. */
function takeBack(text, name, act, { extraWait = 1800 } = {}) {
  return {
    async run(page, ctx, url) {
      const off = await offered(page, text, name);
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
      const info = await act(page);
      const back = (await page.evaluate(() => window.__mdr.app.getText())) === text.replace(/\r\n?/g, '\n');
      await sleep(extraWait);
      const s1 = await storedRecord(page, `text:${name}`);
      await hide(page);
      await sleep(400);
      const s2 = await storedRecord(page, `text:${name}`);
      await unhide(page);
      await page.close({ runBeforeUnload: false });
      const n2 = await nextTab(ctx, url, text, name);
      return { off, back, info, stored: s1 && s1.text, afterHide: s2 && s2.text, nextOffers: n2 };
    },
    expect: (r) => r.off && r.back && r.stored === CRASH && r.afterHide === CRASH && r.nextOffers === 1,
  };
}
const C = {};
C['bs-word'] = takeBack('orig line\n', 'r5a.md', (p) => keys(p, ['w', 'o', 'r', 'd', 'Backspace', 'Backspace', 'Backspace', 'Backspace']));
C['cut-paste'] = takeBack('orig line\nsecond\n', 'r5b.md', async (p) => {
  await p.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: 0, head: 4 } }); });
  await keys(p, ['Meta+x']);
  await sleep(200);
  await keys(p, ['Meta+v']);
});
C['undo-redo-undo'] = takeBack('orig line\n', 'r5c.md', (p) => keys(p, ['a', 'b', 'c', 'Meta+z', 'Meta+Shift+z', 'Meta+z']));
C['crlf'] = takeBack('l1\r\nl2\r\n', 'r5d.md', (p) => keys(p, ['x', 'Backspace']));
C['session-esc-undo'] = takeBack('para one\n\npara two\n', 'r5e.md', async (p) => {
  await until(p, () => document.querySelectorAll('.mdr-preview p').length >= 2, null, 4000);
  const pt = await p.evaluate(() => { const el = document.querySelectorAll('.mdr-preview p')[1]; const r = el.getBoundingClientRect(); return { x: r.right - 3, y: r.top + r.height / 2 }; });
  await sleep(600);
  await p.mouse.click(pt.x, pt.y);
  await sleep(400);
  await keys(p, ['End', 'Z']);
  await keys(p, ['Escape']);
  await sleep(150);
  const mid = await p.evaluate(() => window.__mdr.app.getText());
  await p.evaluate(() => window.__mdr.app.editor.focus());
  await keys(p, ['Meta+z']);
  await sleep(150);
  return mid;
});
C['session-undo-inside'] = takeBack('para one\n\npara two\n', 'r5f.md', async (p) => {
  await until(p, () => document.querySelectorAll('.mdr-preview p').length >= 2, null, 4000);
  const pt = await p.evaluate(() => { const el = document.querySelectorAll('.mdr-preview p')[1]; const r = el.getBoundingClientRect(); return { x: r.right - 3, y: r.top + r.height / 2 }; });
  await sleep(600);
  await p.mouse.click(pt.x, pt.y);
  await sleep(400);
  await keys(p, ['End', 'Z', 'Y']);
  await sleep(120);
  const mid = await p.evaluate(() => window.__mdr.app.getText());
  await keys(p, ['Meta+z']);
  await sleep(300);
  await keys(p, ['Escape']);
  await sleep(300);
  return mid;
});
C['hide-right-after'] = takeBack('orig\n', 'r5g.md', async (p) => {
  await keys(p, ['x', 'Backspace']);
  await hide(p);
  await sleep(100);
  await unhide(p);
}, { extraWait: 1500 });
// 恢复 after typing → the R4 question → 取消 (re-offer) → take the typing back.
C['restore-cancel-back'] = takeBack('orig\n', 'r5h.md', async (p) => {
  await keys(p, ['x']);
  await toastButton(p, '发现未保存的草稿', '恢复');
  await sleep(250);
  await answer(p, '取消');
  await sleep(150);
  await p.evaluate(() => window.__mdr.app.editor.focus());
  await keys(p, ['Backspace']);
});
// The offer closed with its × (not answered): the guard stays (CONTRACT R5 as implemented).
C['closed-x-back'] = takeBack('orig\n', 'r5i.md', async (p) => {
  await p.evaluate(() => { for (const t of document.querySelectorAll('.mdr-toast')) if (t.textContent.includes('发现未保存的草稿')) t.querySelector('.mdr-toast__close')?.click(); });
  await sleep(100);
  await p.evaluate(() => window.__mdr.app.editor.focus());
  await keys(p, ['x', 'Backspace']);
});
// Type, take back, then 恢复: the question is asked (text changed since the offer) and 恢复 brings the crash
// text in as ONE undo step; ⌘Z gives back the loaded text.
C['back-then-restore'] = {
  async run(page) {
    const off = await offered(page, 'orig\n', 'r5j.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
    await keys(page, ['x', 'Backspace']);
    await toastButton(page, '发现未保存的草稿', '恢复');
    await sleep(300);
    const q = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
    if (q.length) await answer(page, '恢复');
    await sleep(400);
    const t1 = await page.evaluate(() => window.__mdr.app.getText());
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await keys(page, ['Meta+z']);
    await sleep(200);
    const t2 = await page.evaluate(() => window.__mdr.app.getText());
    await sleep(1500);
    const st = await storedRecord(page, 'text:r5j.md');
    return { off, q, t1, t2, stored: st && st.text, toasts: await toasts(page) };
  },
  expect: (r) => r.off && r.t1 === CRASH && r.t2 === 'orig\n',
};
// An offer for a real (File System Access) file, then a save / 另存为 while the offer is unanswered.
async function fsaOffer(page, name, text) {
  await page.evaluate(() => { window.__ids = []; window.__mdr.app.bus.on('doc:loaded', (e) => window.__ids.push(e.docId)); });
  if (!(await opfsOpen(page, name, text))) return null;
  const id = await page.evaluate(() => window.__ids[window.__ids.length - 1]);
  await seedDraft(page, { docId: id, version: 9, text: CRASH, at: FUTURE() });
  await page.evaluate(() => { void window.__mdr.app.loadText('other\n', 'other.md'); });
  await sleep(500);
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
  const off = await until(page, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, 4000);
  return off ? id : null;
}
C['offer-then-save'] = {
  async run(page) {
    const id = await fsaOffer(page, 'os.md', 'orig\n');
    if (!id) return { error: 'no offer' };
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
    await keys(page, ['x', 'Meta+s']);
    await sleep(800);
    const disk = await opfsRead(page, 'os.md');
    const afterSave = await storedRecord(page, id);
    const offerUp = await offers(page);
    // back to the SAVED text after a change: R5's base moved to the saved text
    await keys(page, ['y', 'Backspace']);
    await sleep(1800);
    const afterBack = await storedRecord(page, id);
    await toastButton(page, '发现未保存的草稿', '恢复');
    await sleep(300);
    const q = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
    return { disk, afterSave: afterSave && afterSave.text, offerUp, afterBack: afterBack && afterBack.text, q };
  },
  expect: (r) => r.disk === 'orig\nx' && r.afterSave === CRASH && r.offerUp === 1 && r.afterBack === CRASH && r.q.length === 1,
};
C['offer-then-saveas'] = {
  async run(page) {
    const id = await fsaOffer(page, 'oa.md', 'orig\n');
    if (!id) return { error: 'no offer' };
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('oa-copy.md', { create: true });
      window.showSaveFilePicker = async () => h;
    });
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
    await keys(page, ['z']);
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.saveAs'); });
    await sleep(1000);
    const copy = await opfsRead(page, 'oa-copy.md');
    const orig = await storedRecord(page, id);
    await toastButton(page, '发现未保存的草稿', '恢复');
    await sleep(500);
    const after = { text: await page.evaluate(() => window.__mdr.app.getText()), toasts: await toasts(page), dialogs: await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent)) };
    // the original file opened again later: its crash draft is still offered
    await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const h = await root.getFileHandle('oa.md'); window.showOpenFilePicker = async () => [h]; });
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
    await sleep(400);
    if ((await page.evaluate(() => document.querySelectorAll('.mdr-dialog').length))) await answer(page, '丢弃');
    await sleep(900);
    return { copy, stored: orig && orig.text, after, reofferOrig: await offers(page), all: await allDrafts(page) };
  },
  expect: (r) => r.copy === 'orig\nz' && r.stored === CRASH && r.reofferOrig === 1,
};

process.exit((await runBoth(C)) ? 1 : 0);
