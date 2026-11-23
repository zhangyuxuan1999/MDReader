// bench/verify/v5-rvt-trust.mjs — review-trust (0.2.0, review of the checkpoint-B decisions). Four cases, each
// measured on the candidate (switch off, MDR_PORT) and on 0.1.1 (MDR_BASE_PORT, vite preview of the 0.1.1 dist):
//   raw-overlay: a raw-HTML checkbox inside a task item, positioned by a style attribute over the box of ANOTHER task of
//     the same list; a click on that other task's visible box ticks the item that holds the raw box (both builds:
//     "- [x] victim"). Any raw checkbox inside a task item ticks that item (U24: only the task's own box may).
//   dup-wait: A1 (b) — a waiting tick survives a click into the editor pane; the user duplicates a line there
//     (Shift-Alt-Down) while the tick waits; taskOf's neighbour rule then names another task with the same text: the
//     duplicate is UNticked, the clicked task stays unticked, no toast. Needs the slow-worker hook (DELAY ms, default
//     1500; the hook of bench/verify/v3-ses-preview.mjs; 0.1.1 ticks at the click). Before fix-session-e (Fix B) the
//     press in the editor gives the tick up with the toast; after A1 (b) this case shows the defect.
//   gone-block: A1 (b) with the slow-worker hook — the user ticks a task of list 1 (it waits), then deletes list 1 in the
//     editor; the wait falls back to the block now at list 1's line (list 2) and taskOf's unique-text rule ticks list
//     2's task of the same text. 0.1.1 ticked list 1's task at the click (then deleted with it): list 2 untouched.
//   dup-human: dup-wait at human speed without the slow worker, with the queue of A1 (a): 3 image-only tasks above 100
//     formula tasks; four ticks 120 ms apart, then image task b, then (GAP ms, default 200) a click into the editor on
//     the line of image a and Shift-Alt-Down: the queue ticks the duplicate of a, b stays unticked, no toast.
//   dup-wait, gone-block and dup-human show the defect only on a tree that implements A1 (a) and (b) (fix-session-e, or
//   the review copy's patch kept as scratchpad/rvt/rvt-patch.diff); on Fix B (the snapshot of round 4 after Fix B) the press in the
//   editor gives the tick up with the toast (PASS by the second criterion).
//   MDR_PORT=<cand> MDR_BASE_PORT=<0.1.1> node bench/verify/v5-rvt-trust.mjs [raw-overlay] [dup-wait] [gone-block] [dup-human]
// Starts no server, writes nothing into the tree.
import { open, loadDoc, source, idle, sleep } from './v5-atp-lib.mjs';
const DELAY = Number(process.env.DELAY || 1500);
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['raw-overlay', 'dup-wait', 'gone-block', 'dup-human'];
const diff = (a, b) => { const x = a.split('\n'), y = b.split('\n'); const o = []; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) o.push(`${i + 1}:${JSON.stringify(y[i]).slice(0, 40)}`); return o.join(' ') || '(unchanged)'; };
async function slow(B, ms) {
  await B.page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = true;
  }, ms);
}
const boxCentres = (B) => B.page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type=checkbox]')).map((b) => { const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }));
const CASES = {
  async 'raw-overlay'(B) {
    await loadDoc(B, ['# overlay', '', '- [ ] other task one', '- [ ] other task two', '- [ ] victim <input type="checkbox" style="position:absolute;left:-60px;top:-80px;width:900px;height:120px;opacity:0;margin:0;z-index:9">', ''].join('\n'));
    const s0 = await source(B);
    const pts = await B.page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input.task-list-item-checkbox')).map((b) => { const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }));
    await B.page.mouse.click(pts[0][0], pts[0][1]); await idle(B, 400);
    return `click on the visible box of "other task one" -> ${diff(s0, await source(B))} (expected: line 3 ticked)`;
  },
  async 'dup-wait'(B) {
    await B.page.evaluate(() => { window.__toasts = []; new MutationObserver(() => { for (const t of document.querySelectorAll('[class*=toast]')) { const s = t.textContent.trim(); if (s && !window.__toasts.includes(s)) window.__toasts.push(s); } }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
    await loadDoc(B, ['Intro', '', '- [ ] ![](a.png)', '- [ ] ![](b.png)', '- [ ] ![](c.png)', '', 'end', ''].join('\n'));
    const boxes = await boxCentres(B);
    const line3 = await B.page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(v.state.doc.line(3).to); return [c.left - 2, (c.top + c.bottom) / 2]; });
    await slow(B, DELAY);
    await B.page.mouse.click(boxes[0][0], boxes[0][1]); await sleep(150);
    await B.page.mouse.click(boxes[1][0], boxes[1][1]); await sleep(250);
    await B.page.mouse.click(line3[0], line3[1]); await sleep(120);
    await B.page.keyboard.press('Shift+Alt+ArrowDown');
    await sleep(DELAY + 2500);
    await B.page.evaluate(() => { window.__delay = false; });
    await idle(B, 300);
    const got = (await source(B)).split('\n').slice(2, 6);
    const toasts = await B.page.evaluate(() => window.__toasts.length);
    const ok = JSON.stringify(got) === JSON.stringify(['- [x] ![](a.png)', '- [x] ![](a.png)', '- [x] ![](b.png)', '- [ ] ![](c.png)'])
      || (toasts > 0 && JSON.stringify(got) === JSON.stringify(['- [x] ![](a.png)', '- [x] ![](a.png)', '- [ ] ![](b.png)', '- [ ] ![](c.png)']));
    return `${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(got)} toasts=${JSON.stringify(await B.page.evaluate(() => window.__toasts))} (expected a, its copy and b ticked, c not; or b refused WITH the toast)`;
  },
  async 'gone-block'(B) {
    await B.page.evaluate(() => { window.__toasts = []; new MutationObserver(() => { for (const t of document.querySelectorAll('[class*=toast]')) { const s = t.textContent.trim(); if (s && !window.__toasts.includes(s)) window.__toasts.push(s); } }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
    await loadDoc(B, ['Intro', '', '- [ ] milk', '- [ ] eggs', '', '* [ ] milk', '* [ ] bread', '', 'end', ''].join('\n'));
    const boxes = await boxCentres(B);
    const l3 = await B.page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(v.state.doc.line(3).from); return [c.left + 1, (c.top + c.bottom) / 2]; });
    await slow(B, DELAY);
    await B.page.mouse.click(boxes[1][0], boxes[1][1]); await sleep(150);       // eggs: applied, the list is now behind
    await B.page.mouse.click(boxes[0][0], boxes[0][1]); await sleep(250);       // milk of the first list: waits
    await B.page.mouse.click(l3[0], l3[1]); await sleep(120);                   // into the editor, start of line 3
    await B.page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await B.page.keyboard.press('Shift+ArrowDown');
    await B.page.keyboard.press('Backspace');                                     // the first list is deleted
    await sleep(DELAY + 2500);
    await B.page.evaluate(() => { window.__delay = false; });
    await idle(B, 300);
    const s = await source(B);
    return `${/\* \[x\] milk/.test(s) ? 'FAIL (the second list\'s milk was ticked)' : 'PASS'} ${JSON.stringify(s)} toasts=${JSON.stringify(await B.page.evaluate(() => window.__toasts))}`;
  },
  // dup-human: no slow worker. A list of 3 image-only tasks and 100 formula tasks (its re-render takes about 250 ms):
  // four ticks 120 ms apart queue (A1 a), the image task b is ticked 120 ms later, the user clicks into the editor on
  // the line of image a and duplicates it (Shift-Alt-Down) GAP ms later, while b still waits.
  async 'dup-human'(B) {
    const GAP = Number(process.env.GAP || 200);
    await B.page.evaluate(() => { window.__toasts = []; new MutationObserver(() => { for (const t of document.querySelectorAll('[class*=toast]')) { const s = t.textContent.trim(); if (s && !window.__toasts.includes(s)) window.__toasts.push(s); } }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
    const giant = Array.from({ length: 100 }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`);
    await loadDoc(B, ['Intro', '', '- [ ] ![](a.png)', '- [ ] ![](b.png)', '- [ ] ![](c.png)', ...giant, '', 'end', ''].join('\n'));
    await B.page.waitForFunction(() => document.querySelectorAll('.mdr-preview input[type=checkbox]').length >= 103, null, { timeout: 15000 }); await sleep(500);
    const boxes = await boxCentres(B);
    const line3 = await B.page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(v.state.doc.line(3).to); return [c.left - 2, (c.top + c.bottom) / 2]; });
    const t0 = Date.now();
    for (const k of [3, 4, 5, 6]) { await B.page.mouse.click(boxes[k][0], boxes[k][1]); await sleep(120); }
    await B.page.mouse.click(boxes[1][0], boxes[1][1]); await sleep(GAP);
    await B.page.mouse.click(line3[0], line3[1]); await sleep(120);
    await B.page.keyboard.press('Shift+Alt+ArrowDown');
    const t1 = Date.now() - t0;
    await sleep(4000); await idle(B, 300);
    const got = (await source(B)).split('\n').slice(2, 10);
    const toasts = await B.page.evaluate(() => window.__toasts.length);
    const ticked = got.slice(5).every((l) => l.startsWith('- [x]'));
    const ok = ticked && (JSON.stringify(got.slice(0, 4)) === JSON.stringify(['- [ ] ![](a.png)', '- [ ] ![](a.png)', '- [x] ![](b.png)', '- [ ] ![](c.png)'])
      || (toasts > 0 && JSON.stringify(got.slice(0, 4)) === JSON.stringify(['- [ ] ![](a.png)', '- [ ] ![](a.png)', '- [ ] ![](b.png)', '- [ ] ![](c.png)'])));
    return `${ok ? 'PASS' : 'FAIL'} gestures took ${t1} ms; ${JSON.stringify(got)} toasts=${toasts}`;
  },
};
for (const build of ['cand', 'base']) for (const n of names) {
  const B = await open(build);
  try { console.log(build, n, await CASES[n](B)); } catch (e) { console.log(build, n, 'ERROR', String(e).slice(0, 200)); } finally { await B.close(); }
}
