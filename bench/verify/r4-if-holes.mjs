// bench/verify/r4-if-holes.mjs — fix-session-f (round 4, CONTRACT §11 Checkpoint-D decisions): the holes of the
// prototype of "the tick that does not wait", probed on the candidate with the switch OFF (stored '0').
//   ring-<n>[-elsewhere]: <n> single-character transactions with the preview hidden (editor-only mode), into a task of
//     the 100-task formula list (or into the last paragraph, below the list: -elsewhere), back to split, a click 30 ms later on task5:
//     within the ring (n <= 4096 edits since the list's last render) ticked at once; above it nothing, the toast, no wait.
//   lostscroll: tick task3, scroll the preview to the bottom 10 ms later, back after 300 ms, click task5 30 ms later
//     (the list is stale with its refresh dropped: `lost`, not released): ticked at once.
//   pending: the list far down a long document; both panes jump to it and the editor types into the list at once;
//     the box of task5 is clicked the moment it shows (whatever the block's state); rounds where it was stale with an
//     older payload are counted: the answer must be its line (known through the payload's stamp), never another task.
// Each case prints: the answer of THE function at the click (window.__mdr.app.preview.taskLine), whether the block was
// stale, the ms from the click to the box showing its tick, the toasts (through the bus), the ticked tasks.
// Run: MDR_PORT=5465 node bench/verify/r4-if-holes.mjs <case ...>   (needs the dev server; writes nothing into the tree)
import { chromium } from '@playwright/test';
const port = process.env.MDR_PORT;
if (!port) throw new Error('MDR_PORT');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, Number(process.env.T_MS ?? 110_000));
const b = await chromium.launch({ headless: true });
try {
  const page = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`http://localhost:${port}/?mode=split`); await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await page.reload(); await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 }); await sleep(500);
  const GIANT = 'Intro paragraph\n\n' + Array.from({ length: 100 }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n';
  const TAIL = Array.from({ length: 600 }, (_, i) => `\nParagraph ${i} with some words to make it a line of text.\n`).join('');
  const load = async (t) => { await page.evaluate((t) => window.__mdr.loadText(t, 'v.md'), t); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(800); };
  const hook = () => page.evaluate(() => {
    window.__t = []; window.__cl = []; window.__pd = [];
    if (!window.__hk) {
      window.__hk = true; window.__mdr.app.bus.on('toast', (e) => window.__t.push(e.text));
      document.addEventListener('pointerdown', (e) => { const t = e.target; window.__pd.push(`${t.tagName}:${(t.closest?.('li')?.textContent || '').trim().split(/\s+/)[0]}`); }, true);
    }
    // capture on window: runs before the preview's listeners, so the answer is THE function's at that moment
    if (window.__clHooked) return;
    window.__clHooked = true;
    window.addEventListener('click', (e) => {
      const t = e.target; if (!(t instanceof HTMLInputElement)) return;
      const pv = window.__mdr.app.preview; const w = t.closest('section.md-block');
      const st = w && pv.taskStampOf ? pv.taskStampOf(w) : undefined;
      const t0 = performance.now(); const ans = pv.taskLine ? pv.taskLine(t) : 'n/a'; const ms = performance.now() - t0;
      window.__cl.push({ ans, answerMs: Math.round(ms * 100) / 100, stale: !!w?.classList.contains('is-stale'), stamp: st, ev: window.__mdr.app.editor.version, text: (t.closest('li')?.textContent || '').trim().split(/\s+/)[0] });
    }, { capture: true });
  });
  const boxPt = (name) => page.evaluate((name) => { const bx = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').trim().split(/\s+/)[0] === name); if (!bx) return null; bx.scrollIntoView({ block: 'nearest' }); const r = bx.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, name);
  const shownAfter = (name) => page.evaluate((name) => new Promise((res) => { const t0 = performance.now(); const loop = () => { const bx = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').trim().split(/\s+/)[0] === name); if (bx?.checked) return res(Math.round(performance.now() - t0)); if (performance.now() - t0 > 8000) return res('never'); requestAnimationFrame(loop); }; loop(); }), name);
  const outcome = async () => ({ pd: await page.evaluate(() => window.__pd), cl: await page.evaluate(() => window.__cl), toasts: await page.evaluate(() => window.__t), ticked: await page.evaluate(() => (window.__mdr.app.getText().match(/\[x\] task\d+/g) || []).map((x) => x.slice(4))), textareas: await page.evaluate(() => document.querySelectorAll('.mdr-preview textarea').length) });

  for (const name of only) {
    const m = /^ring-(\d+)(-elsewhere)?$/.exec(name);
    if (m) {
      const n = Number(m[1]);
      await load(GIANT);
      await hook();
      await page.evaluate(() => window.__mdr.mode('edit')); await sleep(300);
      await page.evaluate(({ n, elsewhere }) => {
        const v = window.__mdr.app.editor.view;
        for (let i = 0; i < n; i++) { const d = v.state.doc.toString(); const at = elsewhere ? d.length - 1 : d.indexOf('task50 ') + 6; v.dispatch({ changes: { from: at, insert: 'z' }, userEvent: 'input.type' }); }
      }, { n, elsewhere: !!m[2] });
      await sleep(1500);
      await page.evaluate(() => window.__mdr.mode('split')); await sleep(30);
      const p = await boxPt('task5'); await page.mouse.click(p.x, p.y);
      const shown = await shownAfter('task5');
      await sleep(2500); await page.evaluate(() => window.__mdr.waitIdle());
      console.log(name, J({ shownAfterMs: shown, ...(await outcome()) }));
      continue;
    }
    if (name === 'lostscroll') {
      for (let run = 0; run < 3; run++) {
        await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
        await load(GIANT + TAIL);
        let p = await boxPt('task3'); await page.mouse.click(p.x, p.y); await sleep(10);
        await page.evaluate(() => { const el = document.querySelector('.mdr-preview'); el.scrollTop = el.scrollHeight; });
        await sleep(300);
        await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; }); await sleep(30);
        await hook();
        p = await boxPt('task5'); if (!p) { console.log('lostscroll', run, 'no box (block pending)'); continue; }
        await page.mouse.click(p.x, p.y);
        const shown = await shownAfter('task5');
        await sleep(2500); await page.evaluate(() => window.__mdr.waitIdle());
        console.log('lostscroll', run, J({ shownAfterMs: shown, ...(await outcome()) }));
      }
      continue;
    }
    if (name === 'pending') {
      const LIST = Array.from({ length: 40 }, (_, i) => `- [ ] task${i} $x_${i}$ $\\frac{${i}}{3}$`).join('\n');
      const doc = 'Intro\n' + TAIL + TAIL + '\n' + LIST + '\n\nend\n';
      const listLine = doc.split('\n').findIndex((l) => l.startsWith('- [ ] task0 ')) + 1;
      const tally = {};
      for (let run = 0; run < Number(process.env.ROUNDS ?? 8); run++) {
        await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
        await load(doc);
        await hook();
        await page.evaluate((line) => {
          // the editor jumps there (the preview follows it: an edit makes the preview follow the editor, in 0.1.1 too)
          window.__mdr.app.editor.scrollToLine(line, 0);
          window.__mdr.app.preview.scrollToLine(line + 2, 0);
          const v = window.__mdr.app.editor.view;
          const l = v.state.doc.line(line + 2);                    // task2's line: the list changes at once
          v.dispatch({ changes: { from: l.to, insert: ' typed' }, userEvent: 'input.type' });
        }, listLine);
        let p = null; const t0 = Date.now();
        while (!p && Date.now() - t0 < 3000) p = await page.evaluate(() => { const bx = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').trim().split(/\s+/)[0] === 'task5'); if (!bx) return null; const r = bx.getBoundingClientRect(); return r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
        if (!p) { tally.nobox = (tally.nobox || 0) + 1; continue; }
        await page.mouse.click(p.x, p.y);
        await sleep(1500); await page.evaluate(() => window.__mdr.waitIdle());
        const o = await outcome();
        const c = o.cl[0];
        const key = !c ? 'noclick' : `${c.stale ? 'stale' : 'fresh'}:${typeof c.ans === 'number' ? 'line' : c.ans}:${J(o.ticked) === J(['task5']) ? 'right' : o.ticked.length ? 'WRONG' : 'nothing'}`;
        tally[key] = (tally[key] || 0) + 1;
        if (c?.stale || !J(o.ticked).includes('task5')) console.log('pending', run, J(o));
      }
      console.log('pending', J(tally));
      continue;
    }
    console.log(name, 'unknown case');
  }
} finally {
  clearTimeout(timer);
  await b.close();
}
