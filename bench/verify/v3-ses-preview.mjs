// bench/verify/v3-ses-preview.mjs — verify-session stage 2c: the fix step's createPreview change (unkeepReusedId, held)
// and the session's block identity while other structure changes are on their way. A sampler records the preview's
// block texts every animation frame (no duplicated / vanished block may show at any time), and the final state is
// checked: source = screen, no stale (dimmed) block in view, the session where the user typed.
// Run: MDR_PORT=5382 node bench/verify/v3-ses-preview.mjs [name-filter]      (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, clickText, undoTo, redoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 118_000), B.close);
const { page } = B;
const settle = async (ms = 350) => { await sleep(ms); await B.settle(200); };
async function waitSession(ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
async function start(doc, needle, k = null) {
  await page.evaluate(() => { window.__delay = false; });
  await B.loadDoc(doc);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0, 'instant'));
  await sleep(700);
  await clickText(page, needle, k ?? needle.length - 1, { side: 'right' });
  const v = await waitSession();
  if (!v.editing) throw new Error('no session ' + J(v).slice(0, 200));
}
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = true;
  }, ms);
}
/** Samples the visible block texts every frame until stopSampler(); returns the distinct snapshots. */
const startSampler = () => page.evaluate(() => {
  window.__snaps = [];
  window.__lastSnap = null;
  window.__sampling = true;
  const tick = () => {
    if (!window.__sampling) return;
    const out = [];
    for (const s of document.querySelectorAll('.mdr-preview section.md-block')) {
      const r = s.getBoundingClientRect();
      if (r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
      const t = s.textContent.replace(/\s+/g, ' ').trim();
      if (t) out.push((s.classList.contains('is-stale') ? '~' : '') + t);
    }
    const j = JSON.stringify(out);
    if (window.__lastSnap !== j) { window.__lastSnap = j; window.__snaps.push(Math.round(performance.now() - (window.__t0 ?? 0)) + 'ms ' + j + (document.querySelector('.mdr-preview .md-ghost-holder') ? ' [holder]' : '')); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopSampler = () => page.evaluate(() => { window.__sampling = false; return window.__snaps; });
const press = (k) => page.keyboard.press(k);
const type = (t) => page.keyboard.type(t);
const cases = [];
const def = (name, fn) => cases.push({ name, fn });

def('old-delta-lands-after-deletion', async () => {
  // a write of the session (X typed) and then the block's deletion, both before the first structure arrives
  await start('aaa\n\nmid\n\nzzz\n', 'mid');
  await slowWorker(300);
  await type('X');
  await sleep(40);
  await startSampler();
  await press('Meta+a'); await press('Backspace');
  await page.evaluate(() => { window.__t0 = performance.now(); window.__snaps.push('--- deleted'); });
  await sleep(1200);
  const snaps = await stopSampler();
  await page.evaluate(() => { window.__delay = false; });
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  const after = snaps.slice(snaps.indexOf('--- deleted') + 1);
  const bad = after.filter((s) => s.includes('mid'));
  console.log('   snaps', J(snaps));
  return { ok: bad.length === 0 && v.src === 'aaa\n\nzzz\n' && J(sh) === J(['aaa', 'zzz']), detail: `framesShowingDeleted=${bad.length} ${J(bad.slice(0, 2))} src=${J(v.src)} shown=${J(sh)} editing=${!!v.editing}` };
});
def('old-delta-after-deletion-first-lead', async () => {
  await start('\nmid\n\nzzz\n', 'mid');
  await slowWorker(300);
  await type('X');
  await sleep(40);
  await startSampler();
  await press('Meta+a'); await press('Backspace');
  await page.evaluate(() => { window.__t0 = performance.now(); window.__snaps.push('--- deleted'); });
  await sleep(1200);
  const snaps = await stopSampler();
  await page.evaluate(() => { window.__delay = false; });
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await type('N'); await settle();
  const v2 = await view(page);
  const after = snaps.slice(snaps.indexOf('--- deleted') + 1);
  const bad = after.filter((s) => s.includes('mid'));
  console.log('   snaps', J(snaps));
  return { ok: bad.length === 0 && v.src === '\nzzz\n' && v2.src === '\nN\n\nzzz\n', detail: `framesShowingDeleted=${bad.length} ${J(bad.slice(0, 2))} src=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)}` };
});
def('old-delta-after-deletion-same-next', async () => {
  await start('aaa\n\nsame\n\nsame\n\nzzz\n', 'same');
  await slowWorker(300);
  await type('X');
  await sleep(40);
  await startSampler();
  await press('Meta+a'); await press('Backspace');
  await page.evaluate(() => { window.__t0 = performance.now(); window.__snaps.push('--- deleted'); });
  await sleep(1200);
  const snaps = await stopSampler();
  await page.evaluate(() => { window.__delay = false; });
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  const after = snaps.slice(snaps.indexOf('--- deleted') + 1);
  const bad = after.filter((s) => s.includes('sameX') || (s.match(/same/g) || []).length > 1);
  console.log('   snaps', J(snaps));
  return { ok: bad.length === 0 && v.src === 'aaa\n\nsame\n\nzzz\n' && J(sh) === J(['aaa', 'same', 'zzz']), detail: `badFrames=${bad.length} ${J(bad.slice(0, 2))} src=${J(v.src)} shown=${J(sh)}` };
});
def('editor-paste-300-above-session', async () => {
  const doc = 'top\n\n' + Array.from({ length: 20 }, (_, i) => `p${i}`).join('\n\n') + '\n\ntarget here\n\nend\n';
  await start(doc, 'target');
  await B.caretAt('target'); await type('X');
  await sleep(60);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: Array.from({ length: 300 }, (_, i) => `ins${i}`).join('\n\n') + '\n\n' } }); });
  await sleep(100);
  await type('Y');
  await settle(800);
  const v = await view(page);
  const st = await page.evaluate(() => { const e = document.querySelector('.mdr-preview .is-editing'); return e ? { stale: e.classList.contains('is-stale'), h: e.getBoundingClientRect().height } : null; });
  return { ok: v.src.includes('\n\ntargetXY here\n\n') && v.src.startsWith('ins0\n\n') && !!v.editing && st && !st.stale && v.dupIds.length === 0, detail: `line=${J(v.src.split('\n').find((l) => l.startsWith('target')))} editing=${J(v.editing && v.editing.text)} el=${J(st)} dup=${J(v.dupIds)}` };
});
def('editor-replace-all-while-ghost', async () => {
  await start('para one\n\npara mid\n\npara two\n', 'mid');
  await press('Meta+a'); await press('Backspace'); await settle();
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = v.state.doc.toString(); v.dispatch({ changes: { from: 0, to: t.length, insert: t.replace(/para/g, 'PARA') } }); });
  await settle();
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  const v0 = await view(page);
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === 'PARA one\n\nN\n\nPARA two\n' && J(sh) === J(['PARA one', 'N', 'PARA two']), detail: `ghostLive=${!!v0.editing} src=${J(v.src)} shown=${J(sh)}` };
});
def('same-next-scroll-away-back', async () => {
  const doc = 'same\n\nsame\n\n' + Array.from({ length: 500 }, (_, i) => `filler paragraph ${i}`).join('\n\n') + '\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  const sh0 = (await shownText(page)).slice(0, 3);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(990, 0, 'instant'));
  await sleep(1500);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0, 'instant'));
  await sleep(1500);
  const sh1 = (await shownText(page)).slice(0, 3);
  const v0 = await view(page);
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  await type('N'); await settle();
  const v = await view(page);
  const sh2 = (await shownText(page)).slice(0, 3);
  return { ok: J(sh0) === J(sh1) && v.src.startsWith('N\n\nsame\n\nfiller paragraph 0\n') && J(sh2) === J(['N', 'same', 'filler paragraph 0']), detail: `before=${J(sh0)} afterScroll=${J(sh1)} ghost=${!!v0.editing} src=${J(v.src.slice(0, 50))} shown=${J(sh2)}` };
});
def('first-lead-same-next-undo-redo', async () => {
  const doc = '\nsame\n\nsame\n\nzzz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  const s1 = await B.source();
  await type('N'); await settle();
  const fin = await B.source();
  const sh = await shownText(page);
  const u = await undoTo(B, doc, 8);
  const shU = await shownText(page);
  const r = await redoTo(B, fin, 8);
  const shR = await shownText(page);
  return { ok: s1 === '\nsame\n\nzzz\n' && fin === '\nN\n\nsame\n\nzzz\n' && u.ok && r.ok && J(shU) === J(['same', 'same', 'zzz']) && J(shR) === J(['N', 'same', 'zzz']), detail: `empty=${J(s1)} fin=${J(fin)} shown=${J(sh)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)} shownU=${J(shU)} redo=${r.ok ? r.n : 'FAIL'} shownR=${J(shR)}` };
});
def('ghost-click-reused-block', async () => {
  // the block that inherited the emptied block's id is clicked while the emptied element lives
  await start('\nsame\n\nsame\n\nzzz\n', 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await clickText(page, 'same', 3, { side: 'right' });
  await waitSession();
  await type('Q'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === '\nsameQ\n\nzzz\n' && J(sh) === J(['sameQ', 'zzz']) && !v.ghost, detail: `src=${J(v.src)} shown=${J(sh)} ghost=${v.ghost}` };
});
def('ghost-then-editor-deletes-reused-block', async () => {
  await start('\nsame\n\nsame\n\nzzz\n', 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  // the editor removes the block that inherited the id ("same", now lines 2-3)
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc; v.dispatch({ changes: { from: d.line(2).from, to: d.line(4).from } }); });
  await settle();
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  const v0 = await view(page);
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: J(sh) === J(['N', 'zzz']) && v.src.includes('N') && v.src.endsWith('zzz\n'), detail: `src0=${J(v0.src)} ghost=${!!v0.editing} src=${J(v.src)} shown=${J(sh)}` };
});
def('two-first-blocks-emptied-in-a-row', async () => {
  await start('\none\n\ntwo\n\nzzz\n', 'one');
  await press('Meta+a'); await press('Backspace');
  await sleep(40);
  await clickText(page, 'two', 2, { side: 'right' });
  await waitSession(1000);
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await type('N'); await settle();
  const v2 = await view(page);
  const sh2 = await shownText(page);
  return { ok: v.src === '\nzzz\n' && J(sh) === J(['zzz']) && v2.src === '\nN\n\nzzz\n' && J(sh2) === J(['N', 'zzz']), detail: `empty=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)} shown2=${J(sh2)}` };
});

let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      const r = await c.fn();
      if (!check(c.name, r.ok, r.detail)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.evaluate(() => { window.__delay = false; window.__sampling = false; }); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
