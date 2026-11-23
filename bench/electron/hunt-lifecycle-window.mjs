// bench/electron/hunt-lifecycle-window.mjs — hunt:lifecycle, window-state scenarios.
//   node bench/electron/hunt-lifecycle-window.mjs [scenario ...]     (default: all)
//   MDR_EXE=/path/to/MDReader node bench/electron/hunt-lifecycle-window.mjs
// Each scenario: fresh isolated profile, synthetic docs, one JSON line {scenario, expected, actual, pass}.
import * as L from './hunt-lifecycle-lib.mjs';

L.watchdog(Number(process.env.MDR_HUNT_TIMEOUT || 110000));
const dir = L.tmpDir('mdr-hunt-docs-');
const A = L.writeDoc(dir, 'hunt-a.md', 3);
const B = L.writeDoc(dir, 'hunt-b.md', 5);
const mk = (d) => ({ marker: `标题 ${d.name} ${d.blocks / 2}` });
const isDoc = (s, d) => !!s && s.title?.includes(d.name) && s.matchesExpected === true && s.editorChars === d.length;

async function boot() {
  const ctx = await L.launch();
  const w = await L.readyWindow(ctx.app);
  await L.sleep(700);
  await L.instrumentSends(ctx.app);
  return { ...ctx, w };
}
async function closeWin(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await L.sleep(800);
}
async function newWindowAfter(app, fn, timeout = 8000) {
  const p = app.waitForEvent('window', { timeout }).catch(() => null);
  await fn();
  const w = await p;
  if (w) await w.waitForSelector('.cm-content', { timeout: 15000 }).catch(() => {});
  return w;
}

const S = {
  // Known cause, characterised.
  async closedThenOpen({ app }) {
    await closeWin(app);
    const before = await L.mainState(app);
    const w = await newWindowAfter(app, () => L.emitOpen(app, A.path));
    await L.sleep(2500);
    const s = w ? await L.snap(w, mk(A)) : null;
    return { expected: `1 window showing ${A.name} (${A.length} chars)`, actual: { before, after: await L.mainState(app), snap: s }, pass: isDoc(s, A) };
  },
  async closedThenTwoFiles({ app }) {
    await closeWin(app);
    const w = await newWindowAfter(app, () => app.evaluate(({ app: a }, [p1, p2]) => {
      a.emit('open-file', { preventDefault() {} }, p1);
      a.emit('open-file', { preventDefault() {} }, p2);
    }, [A.path, B.path]));
    await L.sleep(2500);
    const s = w ? await L.snap(w, mk(B)) : null;
    return { expected: `${B.name} on screen last (A then B both delivered)`, actual: { after: await L.mainState(app), snap: s, sends: await L.sends(app) }, pass: isDoc(s, B) };
  },
  async closedThenTwoFiles50ms({ app }) {
    await closeWin(app);
    const w = await newWindowAfter(app, () => L.emitOpen(app, A.path));
    await L.sleep(50);
    await L.emitOpen(app, B.path);
    await L.sleep(2500);
    const s = w ? await L.snap(w, mk(B)) : null;
    return { expected: `${B.name} on screen`, actual: { after: await L.mainState(app), snap: s }, pass: isDoc(s, B) };
  },
  async closedActivateThenOpen({ app }) {
    await closeWin(app);
    const w = await newWindowAfter(app, () => app.evaluate(({ app: a }) => { a.emit('activate', { preventDefault() {} }, false); }));
    await L.sleep(1500);
    await L.emitOpen(app, A.path);
    await L.sleep(1500);
    const s = w ? await L.snap(w, mk(A)) : null;
    return { expected: `${A.name}`, actual: { after: await L.mainState(app), snap: s }, pass: isDoc(s, A) };
  },
  async closedOpenThenActivate({ app }) {
    await closeWin(app);
    const w = await newWindowAfter(app, () => app.evaluate(({ app: a }, p) => {
      a.emit('open-file', { preventDefault() {} }, p);
      a.emit('activate', { preventDefault() {} }, false);
    }, A.path));
    await L.sleep(2500);
    const s = w ? await L.snap(w, mk(A)) : null;
    return { expected: `${A.name}`, actual: { after: await L.mainState(app), snap: s }, pass: isDoc(s, A) };
  },
  async minimized({ app, w }) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await L.sleep(800);
    const before = await L.mainState(app);
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(800);
    const s = await L.snap(w, mk(A));
    const after = await L.mainState(app);
    return { expected: `${A.name}, window restored`, actual: { before, after, snap: s }, pass: isDoc(s, A) && after.minimized === 0 };
  },
  async windowHidden({ app, w }) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await L.sleep(600);
    const before = await L.mainState(app);
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(800);
    const s = await L.snap(w, mk(A));
    const after = await L.mainState(app);
    return { expected: `${A.name}, window visible`, actual: { before, after, snap: s }, pass: isDoc(s, A) && after.visible === 1 };
  },
  async appHidden({ app, w }) {
    await app.evaluate(({ app: a }) => a.hide());
    await L.sleep(800);
    const before = await L.mainState(app);
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(1000);
    const s = await L.snap(w, mk(A));
    const after = await L.mainState(app);
    return { expected: `${A.name}, app unhidden and window visible`, actual: { before, after, snap: s }, pass: isDoc(s, A) && after.visible === 1 && after.hidden === false };
  },
  async fullscreen({ app, w }) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await L.sleep(1500);
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(800);
    const s = await L.snap(w, mk(A));
    const fs1 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    // then close the window while fullscreen and reopen (the known path)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false));
    await L.sleep(1500);
    return { expected: `${A.name} in fullscreen`, actual: { snap: s, fullscreen: fs1 }, pass: isDoc(s, A) };
  },
  async openClean({ app, w }) {
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(600);
    const s1 = await L.snap(w, mk(A));
    await L.emitOpen(app, B.path);
    await L.waitTitle(w, B.name);
    await L.sleep(600);
    const s2 = await L.snap(w, mk(B));
    return { expected: `A then B`, actual: { s1, s2 }, pass: isDoc(s1, A) && isDoc(s2, B) };
  },
  async sameFileAgain({ app, w }) {
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(600);
    const s1 = await L.snap(w, mk(A));
    await L.emitOpen(app, A.path);
    await L.sleep(1200);
    const s2 = await L.snap(w, mk(A));
    return { expected: `A still shown, unchanged`, actual: { s1, s2 }, pass: isDoc(s1, A) && isDoc(s2, A) };
  },
  async rendererCrashThenOpen({ app, w }) {
    await L.emitOpen(app, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await L.sleep(1500);
    const afterCrash = await L.mainState(app);
    await L.emitOpen(app, B.path);
    await L.sleep(3000);
    const after = await L.mainState(app);
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
    const alive = after.crashed === 0;
    const s = alive ? await L.snap(app.windows().filter((x) => !x.isClosed()).pop(), mk(B)) : null;
    return { expected: `window recovers and shows ${B.name}`, actual: { afterCrash, after, url, snap: s }, pass: isDoc(s, B) };
  },
  async rendererCrashThenCloseThenOpen({ app }) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await L.sleep(1500);
    await closeWin(app);
    const before = await L.mainState(app);
    const w = await newWindowAfter(app, () => L.emitOpen(app, A.path));
    await L.sleep(2500);
    const s = w ? await L.snap(w, mk(A)) : null;
    return { expected: `${A.name}`, actual: { before, after: await L.mainState(app), snap: s }, pass: isDoc(s, A) };
  },
  async reloadThenOpenImmediately({ app }) {
    await app.evaluate(({ app: a, BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0].webContents.reload();
      setTimeout(() => a.emit('open-file', { preventDefault() {} }, p), 30);
    }, A.path);
    await L.sleep(3500);
    const w = app.windows().filter((x) => !x.isClosed()).pop();
    const s = await L.snap(w, mk(A));
    return { expected: `${A.name} (open-file 30 ms into a renderer reload)`, actual: { snap: s }, pass: isDoc(s, A) };
  },
  async secondInstanceWindowOpen({ app, w }) {
    await app.evaluate(({ app: a }, p) => { a.emit('second-instance', {}, [process.execPath, p], '/'); }, A.path);
    await L.waitTitle(w, A.name);
    await L.sleep(600);
    const s = await L.snap(w, mk(A));
    return { expected: `${A.name}`, actual: { snap: s, state: await L.mainState(app) }, pass: isDoc(s, A) };
  },
  async secondInstanceWindowClosed({ app }) {
    await closeWin(app);
    const w = await newWindowAfter(app, () => app.evaluate(({ app: a }, p) => { a.emit('second-instance', {}, [process.execPath, p], '/'); }, A.path), 5000);
    await L.sleep(1500);
    const s = w ? await L.snap(w, mk(A)) : null;
    return { expected: `a window opens showing ${A.name}`, actual: { newWindow: !!w, state: await L.mainState(app), snap: s }, pass: isDoc(s, A) };
  },
  async menuOpenWindowClosed({ app }) {
    await closeWin(app);
    const r = await app.evaluate(({ Menu, BrowserWindow, dialog }) => {
      // Do not show a real panel: record whether anything would react to 文件 → 打开… / 新建.
      const item = Menu.getApplicationMenu().getMenuItemById('file.open');
      const n = Menu.getApplicationMenu().getMenuItemById('file.new');
      const before = BrowserWindow.getAllWindows().length;
      item.click(); n.click();
      return { hasItem: !!item, before, after: BrowserWindow.getAllWindows().length };
    });
    await L.sleep(1500);
    return { expected: '打开… / 新建 with no window: a window (or open panel) appears', actual: { ...r, later: await L.mainState(app) }, pass: (await L.winCount(app)) > 0 };
  },
  async closeViaDiscardThenOpen({ app, w }) {
    await L.typeInEditor(w, 'xyz');
    await L.sleep(400);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await L.sleep(800);
    const dlg = (await L.snap(w)).dialogs;
    await L.clickDialog(w, '不保存');
    await L.sleep(1000);
    const before = await L.mainState(app);
    const nw = await newWindowAfter(app, () => L.emitOpen(app, A.path));
    await L.sleep(2500);
    const s = nw ? await L.snap(nw, mk(A)) : null;
    return { expected: `${A.name}`, actual: { dialogShown: dlg, before, snap: s }, pass: isDoc(s, A) };
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(S);
const results = [];
for (const name of names) {
  const t0 = Date.now();
  let ctx;
  try {
    ctx = await boot();
    const r = await S[name](ctx);
    results.push({ scenario: name, ...r, sends: await L.sends(ctx.app).catch(() => null), errors: ctx.errors, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ scenario: name, pass: false, threw: String(e).slice(0, 300), errors: ctx?.errors, ms: Date.now() - t0 });
  } finally {
    if (ctx) await L.closeApp(ctx.app);
  }
  console.log(JSON.stringify(results[results.length - 1]));
}
L.cleanupTmp();
console.log(JSON.stringify({ exe: L.EXE, summary: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}`) }));
process.exit(0);
