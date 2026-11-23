// s10 — UI stress: (A) window resized to 500 px width (no horizontal page overflow, typing works,
// preview still renders); (B) hidden tab (visibilityState=hidden) → typing → visible again: preview
// catches up, draft flushed; (C) reload mid-edit on the untitled doc → draft offered and restorable;
// (D) 50 rapid mode switches (view.cycleMode) → consistent visible panes, no long tasks > 50 ms (P12);
// (E) 50 theme flips → data-theme consistent, CM theme consistent, no long tasks > 50 ms.
// Run: node bench/verify/s10_ui_stress.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
page.on('dialog', (d) => d.accept());

const visiblePending = () => page.evaluate(() => {
  const el = window.__mdr.app.preview.el;
  const r = el.getBoundingClientRect();
  let pending = 0, total = 0;
  for (const b of el.querySelectorAll('.md-block')) {
    const br = b.getBoundingClientRect();
    if (br.bottom < r.top || br.top > r.bottom) continue;
    total++;
    if (b.classList.contains('is-pending')) pending++;
  }
  return { pending, total, H: el.clientHeight, W: el.clientWidth };
});
const setHidden = (hidden) => page.evaluate((hidden) => {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 60000);
  C.check('initial settle', s.ok, s);

  // ---------------- (A) 500 px wide window
  await page.setViewportSize({ width: 500, height: 700 });
  await sleep(500);
  let geo = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    editorW: document.querySelector('.mdr-pane--editor')?.getBoundingClientRect().width,
    previewW: document.querySelector('.mdr-pane--preview')?.getBoundingClientRect().width,
    tocW: document.querySelector('.mdr-pane--toc')?.getBoundingClientRect().width,
    toolbarH: document.querySelector('.mdr-toolbar')?.getBoundingClientRect().height,
    toolbarScrollW: document.querySelector('.mdr-toolbar')?.scrollWidth, toolbarClientW: document.querySelector('.mdr-toolbar')?.clientWidth,
    statusH: document.querySelector('.mdr-statusbar')?.getBoundingClientRect().height,
    mode: window.__mdr.app.layout.getMode(), toc: window.__mdr.app.layout.isTocVisible(),
  }));
  C.check('(A) 500 px: no horizontal page overflow', geo.scrollW <= geo.clientW + 1, geo);
  C.check('(A) 500 px: editor and preview panes both have usable width (> 120 px)', (geo.editorW ?? 0) > 120 && (geo.previewW ?? 0) > 120, geo);
  C.measure('(A) 500 px: toolbar height (px)', geo.toolbarH, 'informational (single row ≈ 40)', true);
  C.check('(A) 500 px: toolbar not overflowing/clipped', (geo.toolbarScrollW ?? 0) <= (geo.toolbarClientW ?? 0) + 1, { toolbarScrollW: geo.toolbarScrollW, toolbarClientW: geo.toolbarClientW });
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(3000, 0); ed.focus(); window.__lat.length = 0; });
  await page.keyboard.type('narrow typing 窄屏输入 ', { delay: 0 });
  let lat = await latencyStats(page);
  C.measure('(A) 500 px: input latency p95 (ms)', lat.p95, '< 100', lat.p95 < 100);
  s = await settle(page, 60000);
  await sleep(600);
  let vp = await visiblePending();
  C.check('(A) 500 px: preview visible blocks mounted after typing', vp.total > 0 && vp.pending === 0, vp);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes('narrow typing')));
  C.check('(A) 500 px: preview shows the typed text', shown);
  // resize back and forth quickly 10x
  await page.evaluate(() => { window.__longTasks.length = 0; });
  for (let i = 0; i < 10; i++) { await page.setViewportSize({ width: 500 + (i % 2) * 900, height: 700 + (i % 2) * 200 }); await sleep(60); }
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(600);
  let lt = await longTasks(page);
  C.measure('(A) 10 rapid resizes: long tasks count / max ms', `${lt.count}/${lt.max}`, '0 > 50 ms', lt.max <= 50);
  vp = await visiblePending();
  C.check('(A) after resizing back to 1400: visible blocks mounted', vp.total > 0 && vp.pending === 0, vp);
  let sc = await structureCheck(page);
  C.check('(A) structure tiles', sc.problems.length === 0, sc);

  // ---------------- (B) hidden tab, type while hidden, return
  const docId = 'text:medium.md';
  await setHidden(true);
  await sleep(300);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(6000, 0); ed.focus(); });
  await page.keyboard.type('typed while hidden ', { delay: 0 });
  await sleep(1500);
  await setHidden(false);
  s = await settle(page, 60000);
  C.check('(B) settles after returning from hidden', s.ok, s);
  await sleep(500);
  vp = await visiblePending();
  C.check('(B) visible blocks mounted after return', vp.total > 0 && vp.pending === 0, vp);
  const shownB = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes('typed while hidden')));
  C.check('(B) preview shows text typed while hidden', shownB);
  const vB = await page.evaluate(() => window.__mdr.version());
  await sleep(1500);
  const draftB = await page.evaluate(() => window.__wmsgs.draftSaved.slice(-1)[0]);
  C.check('(B) draft saved for the latest version', draftB && draftB.version === vB, { draftB, vB });

  // ---------------- (C) reload mid-edit on the untitled doc → draft restore
  await page.goto('about:blank');
  await open(page, '?mode=split');
  await settle(page, 30000);
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type('# Draft test\n\nunsaved draft text ' + 'x'.repeat(50), { delay: 0 });
  const textC = await page.evaluate(() => window.__mdr.app.editor.getText());
  await page.waitForFunction((v) => window.__wmsgs.draftSaved.some((d) => d.version === v), await page.evaluate(() => window.__mdr.version()), { timeout: 8000 }).catch(() => {});
  const savedC = await page.evaluate(() => window.__wmsgs.draftSaved.slice(-1)[0]);
  C.check('(C) draft saved before reload', !!savedC, savedC);
  const titleBefore = await page.title();
  C.check('(C) title shows dirty marker before reload', titleBefore.startsWith('●'), titleBefore);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
  await sleep(800);
  let t = await toasts(page);
  C.check('(C) after reload: draft-found toast offered', t.some((x) => x.includes('发现未保存的草稿')), t);
  const restoreBtn = page.locator('.mdr-toast__btn', { hasText: '恢复' });
  if (await restoreBtn.count()) {
    await restoreBtn.first().click();
    await sleep(300);
    const textAfter = await page.evaluate(() => window.__mdr.app.editor.getText());
    C.check('(C) restored draft text equals text before reload', textAfter === textC, `len ${textAfter.length} vs ${textC.length}`);
    s = await settle(page, 30000);
    sc = await structureCheck(page);
    C.check('(C) structure after restore tiles', sc.problems.length === 0 && sc.blocks > 0, sc);
    const stat = await page.evaluate(() => document.querySelector('.mdr-statusbar')?.textContent);
    C.check('(C) status bar shows draft state', /草稿已存/.test(stat || ''), stat);
    // discard path on a second reload: draft still exists (not cleared by restore) → offered again?
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
    await sleep(800);
    t = await toasts(page);
    C.check('(C) second reload: draft offered again (restore does not delete it)', t.some((x) => x.includes('发现未保存的草稿')), t);
    const discardBtn = page.locator('.mdr-toast__btn', { hasText: '丢弃' });
    if (await discardBtn.count()) await discardBtn.first().click();
    await sleep(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
    await sleep(800);
    t = await toasts(page);
    C.check('(C) after discard + reload: no draft toast', !t.some((x) => x.includes('发现未保存的草稿')), t);
  }

  // ---------------- (D) 50 rapid mode switches
  await open(page, '?doc=/test-data/medium.md&mode=split');
  s = await settle(page, 60000);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(8000, 0); ed.focus(); });
  await sleep(400);
  const before = await page.evaluate(() => ({ ed: window.__mdr.app.editor.topVisible(), pv: window.__mdr.app.preview.topVisible() }));
  await page.evaluate(() => { window.__longTasks.length = 0; });
  const t0 = Date.now();
  await page.evaluate(async () => { for (let i = 0; i < 50; i++) { window.__mdr.app.registry.run('view.cycleMode'); await new Promise((r) => setTimeout(r, 10)); } });
  const modeMs = Date.now() - t0;
  await sleep(800);
  lt = await longTasks(page);
  C.measure('(D) 50 mode switches: wall ms, long tasks count / max ms', `${modeMs}, ${lt.count}/${lt.max}`, 'P12 longest task < 50 ms', lt.max < 50);
  let st = await page.evaluate(() => {
    const m = window.__mdr.app.layout.getMode();
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
    return { mode: m, attr: document.querySelector('.mdr-app')?.dataset.mode, editorVisible: vis('.mdr-pane--editor'), previewVisible: vis('.mdr-pane--preview'), ed: window.__mdr.app.editor.topVisible(), pv: window.__mdr.app.preview.topVisible(), status: document.querySelector('[data-stat=mode]')?.textContent };
  });
  // 50 cycles from split: 50 % 3 = 2 → split→preview→edit... ends at 'edit' after 50 steps? (split→preview (1) →edit (2) →split (3)...) 50 mod 3 = 2 → preview? compute
  const MODES = ['edit', 'split', 'preview'];
  const expected = MODES[(MODES.indexOf('split') + 50) % 3];
  C.check(`(D) mode after 50 cycles is ${expected} and DOM matches`, st.mode === expected && st.attr === expected && st.editorVisible === (expected !== 'preview') && st.previewVisible === (expected !== 'edit'), st);
  C.check('(D) status bar mode label matches', (st.status || '').includes({ edit: '编辑', split: '分栏', preview: '预览' }[expected]), st.status);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(500);
  st = await page.evaluate(() => ({ ed: window.__mdr.app.editor.topVisible(), pv: window.__mdr.app.preview.topVisible(), edFocus: window.__mdr.app.editor.hasFocus() }));
  C.check('(D) back in split: editor top line within 5 lines of where it was', Math.abs(st.ed.line - before.ed.line) <= 5, { before: before.ed, after: st.ed });
  C.check('(D) back in split: preview top line within 5 lines of editor', Math.abs(st.pv.line - st.ed.line) <= 5, st);
  vp = await visiblePending();
  C.check('(D) back in split: visible preview blocks mounted', vp.total > 0 && vp.pending === 0, vp);
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.type('after mode storm ', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(D) input latency p95 after mode storm (ms)', lat.p95, '< 100', lat.p95 < 100);
  s = await settle(page, 60000);
  C.check('(D) settles after typing', s.ok, s);

  // ---------------- (E) 50 theme flips
  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => { window.__longTasks.length = 0; });
  const t1 = Date.now();
  await page.evaluate(async () => { for (let i = 0; i < 50; i++) { window.__mdr.app.registry.run('view.toggleTheme'); await new Promise((r) => setTimeout(r, 10)); } });
  const themeMs = Date.now() - t1;
  await sleep(500);
  lt = await longTasks(page);
  C.measure('(E) 50 theme flips: wall ms, long tasks count / max ms', `${themeMs}, ${lt.count}/${lt.max}`, 'P12 longest task < 50 ms', lt.max < 50);
  const th = await page.evaluate(() => {
    const root = document.documentElement;
    const cm = document.querySelector('.cm-editor');
    const bg = getComputedStyle(document.body).backgroundColor;
    const cmBg = getComputedStyle(cm).backgroundColor;
    const pvBg = getComputedStyle(document.querySelector('.mdr-preview')).backgroundColor;
    const lum = (c) => { const m = c.match(/\d+/g) || [0, 0, 0]; return (+m[0] * 0.299 + +m[1] * 0.587 + +m[2] * 0.114); };
    return { theme: root.dataset.theme, pref: window.__mdr.app.theme.get(), resolved: window.__mdr.app.theme.resolved(), cmDark: cm.classList.contains('cm-dark') || !!cm.querySelector('.cm-dark') || cm.closest('.cm-dark') !== null, cmDarkTheme: Array.from(cm.classList).join(' '), bgLum: lum(bg), cmLum: lum(cmBg), pvLum: lum(pvBg), stored: localStorage.getItem('mdr.theme') };
  });
  C.check('(E) after 50 flips theme equals the starting theme (even count)', th.theme === theme0 && th.resolved === theme0, { theme0, ...th });
  const dark = th.resolved === 'dark';
  C.check('(E) app / editor / preview backgrounds agree with the resolved theme', dark ? (th.bgLum < 128 && th.cmLum < 128 && th.pvLum < 128) : (th.bgLum >= 128 && th.cmLum >= 128 && th.pvLum >= 128), th);
  C.check('(E) theme persisted in localStorage', th.stored === th.resolved, th.stored);
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.type('after theme storm ', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(E) input latency p95 after theme storm (ms)', lat.p95, '< 100', lat.p95 < 100);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s10 ui stress', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
