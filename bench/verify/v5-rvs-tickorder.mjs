// bench/verify/v5-rvs-tickorder.mjs — review-session (0.2.0, before fix-session-e): U16 as amended a second time
// (item A1 (e)) meets an editing session, switch ON. Ticks of the challenger's giant task list (100 tasks with
// formulas, re-render about 250 ms): box 3 (applied at once), box 4 60 ms later (waits for the re-render), then 60 ms
// later a click into text and 'Q' typed 30 ms after it; then Cmd-Z INSIDE the session, then Esc.
//   same   the click goes into task10's text (the tick's own block)
//   other  the click goes into a paragraph below the list (another block)
// What must hold (the invariant of A1 (e) and the gesture order): both ticks are in the source, Q is where it was
// typed, no toast; and the first Cmd-Z in the session takes back Q, never the tick of box 4 (the user ticked before
// typing, as 0.1.1 wrote it at the click). On the tree before fix-session-e the press on the text gives the tick of
// box 4 up with the toast (the old P-F rule), so the case fails there by design; it is meant for the tree after A1.
// Run: MDR_PORT=<dev server> node bench/verify/v5-rvs-tickorder.mjs [same|other ...]   (RUNS=n, default 3)
// Measured by review-session on a patched copy (A1 (b) in onAwayPress / onAwayFocus / replayToggle, the replay not
// clearing pressOn): 'other' fails 1/1 with either order of replayToggle / tryResume in afterMount / afterStructure
// (Cmd-Z in the paragraph undid box 4 and moved the session into the list); 'same' fails with the order of the tree
// (tryResume first: the tick is written inside the session's write together with Q, one Cmd-Z undoes both) and
// passes with replayToggle first. Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/rvs/lib';
const { openB, sleep, globalTimeout, J, check, summary, clickText, load } = await import('./v4-sesa-lib.mjs');

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 170_000), B.close);
const { page } = B;
page.removeAllListeners('dialog');
page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
const LIST = Array.from({ length: 100 }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n');
const DOC = `Intro\n\n${LIST}\n\npara one two three\n\nend\n`;
const boxPoint = (k) => page.evaluate((k) => { const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
async function clickBox(k) { const p = await boxPoint(k); await page.mouse.click(p.x, p.y); }
const toastsInstall = () => page.evaluate(() => {
  window.__rvsT = [];
  if (window.__rvsTw) return;
  window.__rvsTw = 1;
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && /没有勾选|没有写入/.test(n.textContent || '')) window.__rvsT.push(n.textContent.slice(0, 30)); }).observe(document.body, { childList: true, subtree: true });
});
const src = () => page.evaluate(() => window.__mdr.app.editor.getText());
const toasts = () => page.evaluate(() => window.__rvsT.slice());
const CASES = {
  same: { click: ['task10 ', 3], typed: (d) => d.replace('- [ ] task10 ', '- [ ] taskQ10 ') },
  other: { click: ['para one', 5], typed: (d) => d.replace('para one', 'para oQne') },
};
const tick = (d) => d.replace('- [ ] task3 ', '- [x] task3 ').replace('- [ ] task4 ', '- [x] task4 ');
let bad = 0;
try {
  await B.boot('mode=split');
  await page.evaluate(() => localStorage.setItem('mdr.previewEdit', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(500);
  for (const [name, c] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 3); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        await page.keyboard.press('Escape');
        await load(B, DOC);
        await page.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = 0; document.querySelector('.cm-scroller').scrollTop = 0; });
        await sleep(400);
        await toastsInstall();
        await clickBox(3); await sleep(60); await clickBox(4); await sleep(60);
        await clickText(page, c.click[0], c.click[1], { side: 'right' });
        await sleep(30); await page.keyboard.type('Q');
        await sleep(1500);
        const s1 = await src();
        const want1 = c.typed(tick(DOC));
        if (!check(`${nm}:ticks+typed`, s1 === want1, `observed=${J(s1.slice(0, 300))} toasts=${J(await toasts())}`)) bad++;
        await page.keyboard.press('Meta+z'); await sleep(1200);
        const s2 = await src();
        const want2 = tick(DOC);
        if (!check(`${nm}:undo-in-session-takes-Q-only`, s2 === want2, `observed=${J(s2.slice(0, 300))} session=${J(await page.evaluate(() => (document.querySelector('.mdr-preview [contenteditable="true"]')?.textContent || '').slice(0, 20)))}`)) bad++;
        const ts = await toasts();
        if (!check(`${nm}:no-toast`, ts.length === 0, J(ts))) bad++;
      } catch (err) { check(nm, false, 'error ' + (err && err.message)); bad++; }
    }
  }
} finally {
  summary();
  stop();
  await B.close();
  process.exit(bad ? 1 : 0);
}
