// bench/verify/v5-chb-wait.mjs — challenge-b (round 4): variations of CHA-2 (P-F amended: a wait is abandoned when the
// user turns elsewhere and never takes the focus back) and P-G (one toast when queued input is discarded), for the
// resumes that are not a click: a split (Enter), a merge (Backspace), ⌘Z, a paste; and for a waiting task checkbox.
// The slow-worker hook holds the structure and HTML for `delay` ms; meanwhile the user clicks into the editor pane
// and types EDIT there. Checks: EDIT is in the editor at line 1, the session took no focus back, the toast exactly when
// queued text was dropped. (Built from v5-chb-pb.mjs, itself from challenger A's v5-cha-pb.mjs.) Other block kinds (code, nested list, quote, raw HTML, display formula),
// an editor-pane change instead of a session write, the history / paste / merge resumes, click at the line start and end,
// keys at human speed during the wait, and a delay beyond the 10 s bound (P-G: one toast, nothing written). After each
// case: Esc, then the editor's undo back to the original byte for byte.
// (Header of the original:) P-B with a slow worker. A session's write changes the line
// count of the document above a block C (Enter, a paste of two paragraphs, an emptied block); the structure update
// is delayed by `delay` ms (the slow-worker hook of v3-ses-preview.mjs: structure deltas and HTML both held); `wait`
// ms after the write the user clicks into C and types Z. P-B: the session on C may start only on a wrapper that
// shows C's CURRENT source, so Z must land where it was clicked and nothing else may change.
// Run: MDR_PORT=5486 node bench/verify/v5-chb-wait.mjs [case ...]   (RUNS=n repeats every case)
// Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } = await import('./v4-sesa-lib.mjs');

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}
const D1 = 'Alpha beta\n\nGamma delta\n\nOmega words\n';
const TL = 'Intro\n\n- [ ] one\n- [ ] two\n\nend\n';
// [name, doc, start needle, caret after, keys in the session, typed before turning away, delay, then: 'editor' | 'toolbar', want(src) -> bool, toast]
const C = [
  ['split-editor', D1, 'Alpha', 'Alpha', ['Enter'], '', 1500, 'editor', (s) => s === 'EDITAlpha\n\nbeta\n\nGamma delta\n\nOmega words\n', null],
  ['split-keys-editor', D1, 'Alpha', 'Alpha', ['Enter'], 'Q', 1500, 'editor', (s) => s === 'EDITAlpha\n\nbeta\n\nGamma delta\n\nOmega words\n', 'drop'],
  ['merge-editor', D1, 'Gamma', 'Gamma', ['Home', 'Backspace'], '', 1500, 'editor', (s) => s === 'EDITAlpha betaGamma delta\n\nOmega words\n', null],
  ['merge-keys-editor', D1, 'Gamma', 'Gamma', ['Home', 'Backspace'], 'Q', 1500, 'editor', (s) => s === 'EDITAlpha betaGamma delta\n\nOmega words\n', 'drop'],
  ['undo-editor', D1, 'Alpha', 'Alpha', ['X', 'wait:700', 'Meta+z'], '', 1500, 'editor', (s) => s === 'EDITAlpha beta\n\nGamma delta\n\nOmega words\n', null],
  ['undo-keys-editor', D1, 'Alpha', 'Alpha', ['X', 'wait:700', 'Meta+z'], 'Q', 1500, 'editor', (s) => s === 'EDITAlpha beta\n\nGamma delta\n\nOmega words\n', 'drop'],
  ['paste-editor', D1, 'Alpha', 'Alpha', ['paste:P1\n\nP2'], '', 1500, 'editor', (s) => s === 'EDITAlphaP1\n\nP2 beta\n\nGamma delta\n\nOmega words\n', null],
  ['split-toolbar', D1, 'Alpha', 'Alpha', ['Enter'], 'Q', 1500, 'toolbar', (s) => s === 'Alpha\n\nbeta\n\nGamma delta\n\nOmega words\n', 'drop'],
  ['empty-type-editor', D1, 'Gamma', 'Gamma', ['Meta+a', 'Backspace', 'wait:400', 'N'], '', 1500, 'editor', (s) => s === 'EDITAlpha beta\n\nN\n\nOmega words\n', null],
  // fix-session-f (CONTRACT §11, Checkpoint-C / Checkpoint-D decisions, U16 as amended a second time: a tick does not
  // wait): task-editor and task-session-editor tick at the click (was: the click waited and the press in the editor gave
  // it up with the toast). task-session-editor: the released block's held re-render mounts in the frame after Esc, before
  // this click; a click inside that frame would meet Fix B's wait (answer 'wait'), the known limit.
  ['task-editor', TL, null, null, ['esc'], 'box1', 1500, 'editor', (s) => s === 'EDITIntro\n\n- [ ] one\n- [x] two\n\nend\n', null],
  ['task-slow-editor', TL, 'one', 'one', ['slow', 'X', 'esc'], 'box1', 1500, 'editor', (s) => s === 'EDITIntro\n\n- [ ] oneX\n- [ ] two\n\nend\n', 'task'],
  ['task-slow-wait', TL, 'one', 'one', ['slow', 'X', 'esc'], 'box1', 1500, 'none', (s) => s === 'Intro\n\n- [ ] oneX\n- [x] two\n\nend\n', null],
  ['task-slow-box2', TL, 'one', 'one', ['slow', 'X', 'esc'], 'box1', 1500, 'box0', (s) => s === 'Intro\n\n- [x] oneX\n- [x] two\n\nend\n', null],
  ['task-session-editor', TL, 'one', 'one', ['X', 'esc'], 'box1', 1500, 'editor', (s) => s === 'EDITIntro\n\n- [ ] oneX\n- [x] two\n\nend\n', null],
];
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, start, at, keys, pre, delay, then, want, toastWant] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, doc);
        await page.evaluate(() => { window.__chbT = []; window.__chbO?.disconnect(); window.__chbO = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.textContent) window.__chbT.push(n.textContent); }); window.__chbO.observe(document.body, { childList: true, subtree: true }); });
        if (start) {
          await clickText(page, start, Math.min(1, start.length - 1), { side: 'right' });
          const v0 = await waitSession(page);
          if (!v0.editing) throw new Error('no session');
          await sleep(80);
          await caretTo(page, at, 'after');
          await sleep(80);
        }
        for (const key of keys) {
          if (key.startsWith('paste:')) { await slowWorker(delay); await page.evaluate((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, key.slice(6)); }
          else if (key.startsWith('wait:')) await sleep(Number(key.slice(5)));
          else if (key === 'slow') await slowWorker(delay);
          else if (key === 'esc') { await slowWorker(delay); await page.keyboard.press('Escape'); }
          else { if (key !== 'X' && key !== 'Meta+a') await slowWorker(delay); if (key.length === 1) await page.keyboard.type(key); else await page.keyboard.press(key); }
          await sleep(30);
        }
        if (pre === 'box1') {
          const p = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[1]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
          const t0 = Date.now();
          await page.mouse.click(p.x, p.y);
          if (process.env.CHB_TRACE) {
            const tr = await page.evaluate(async () => { const out = []; const t0 = performance.now(); for (let i = 0; i < 12; i++) { const s = window.__mdr.app.getText(); out.push(Math.round(performance.now() - t0) + ':' + (s.includes('[x] two') ? 'X' : '-') + (document.activeElement?.tagName || '')); await new Promise((r) => setTimeout(r, 25)); } return out.join(' '); });
            console.log('trace', Date.now() - t0, tr);
          }
        } else if (pre) await page.keyboard.type(pre);
        await sleep(200);
        if (then === 'editor') {
          const e = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(0); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
          await page.mouse.click(e.x, e.y);
          await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: 0 } }); });
          for (const ch of 'EDIT') { await page.keyboard.type(ch); await sleep(130); }
        } else if (then === 'none') {
          /* nothing */
        } else if (then === 'box0') {
          const p = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[0]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
          await page.mouse.click(p.x, p.y);
        } else {
          const t = await page.evaluate(() => { const b = document.querySelector('.mdr-toolbar button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 2, y: r.top + 2 }; });
          if (!t) throw new Error('no toolbar button');
          await page.mouse.move(t.x, t.y); await page.mouse.down(); await page.mouse.move(t.x + 400, t.y + 300); await page.mouse.up();
        }
        await sleep(delay + 900);
        await slowWorker(0);
        await settle(600);
        const v = await view(page);
        const act = await page.evaluate(() => { const a = document.activeElement; return a && a.closest('.cm-editor') ? 'editor' : a && a.closest('.mdr-preview') ? 'preview' : a ? a.tagName : 'none'; });
        const ts = await page.evaluate(() => window.__chbT.slice());
        const drop = ts.filter((t) => t.includes('预览尚未更新完')).length, task = ts.filter((t) => t.includes('没有勾选')).length;
        const toastOk = toastWant === 'drop' ? drop === 1 && task === 0 : toastWant === 'task' ? task === 1 && drop === 0 : drop === 0 && task === 0;
        const ok = want(v.src) && toastOk && (then !== 'editor' || act === 'editor');
        if (!check(nm, ok, `observed=${J(v.src)} active=${act} drop=${drop} task=${task} editing=${J(v.editing && v.editing.text.slice(0, 20))}`)) bad++;
        await page.keyboard.press('Escape'); await settle(300);
        for (let u = 0; u < 12 && (await B.source()) !== doc; u++) { await page.evaluate(() => window.__mdr.app.editor.view.focus()); await page.keyboard.press('Meta+z'); await sleep(150); }
        const back = await B.source();
        if (!check(nm + ':undo', back === doc, `after undo=${J(back)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
