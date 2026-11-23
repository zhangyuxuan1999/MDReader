// bench/verify/r4-if-esc.mjs — fix-session-f: v5-chb-toggle's esc-hardbreak-own-box (switch ON) with the toasts counted
// through the bus (the app reuses the toast node for a repeated text, so a MutationObserver can miss one): a session in
// task one, X, Shift+Enter, 'cont', Esc, then at once a click on task one's own box (the block a session just released:
// the answer 'wait'). Prints the source, the bus toasts and whether a capture element is left behind.
// Run: MDR_PORT=<dev server> node bench/verify/r4-if-esc.mjs [runs]
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/r4-if/lib';
const { openB, sleep, globalTimeout, clickText, waitSession, load, caretTo } = await import('./v4-sesa-lib.mjs');
const B = await openB();
const stop = globalTimeout(110_000, B.close);
const { page } = B;
try {
  await B.boot('mode=split');
  for (let run = 0; run < Number(process.argv[2] || 3); run++) {
    const doc = 'Intro\n\n- [ ] one\n- [ ] two\n- [ ] three\n\nend\n';
    await load(B, doc);
    await page.evaluate(() => { window.__t = []; if (!window.__hk) { window.__hk = true; window.__mdr.app.bus.on('toast', (e) => window.__t.push(e.text)); } });
    await clickText(page, 'one', 1, { side: 'right' }); await waitSession(page); await sleep(80); await caretTo(page, 'one', 'after'); await sleep(80);
    await page.keyboard.type('X'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('cont'); await page.keyboard.press('Escape');
    const p = await page.evaluate(() => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(p.x, p.y);
    await sleep(12000);
    const out = await page.evaluate(() => ({ src: window.__mdr.app.getText(), toasts: window.__t, textareas: document.querySelectorAll('.mdr-preview textarea').length }));
    console.log('esc-hardbreak-own-box', run, JSON.stringify(out));
  }
} finally { stop(); await B.close(); }
