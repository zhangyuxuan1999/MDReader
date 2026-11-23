// bench/electron/verify-final-review-l2.mjs — final:verify-review#1 (2026-11-20).
// Interleavings around the lead's L2 edit in render-process-gone (a crash while ⌘Q waits for the
// dirty question cancels the quit and recovers). Each case: fresh isolated profile, documents via
// app.emit('open-file'), recent documents stubbed, renderer crash via forcefullyCrashRenderer().
//   C1 dirty, app.quit() → dialog; crash → window recovers (file shown); dirty again, app.quit() →
//      dialog → 不保存 → the app exits (the quit is not lost / trapped afterwards).
//   C2 dirty, app.quit() → dialog; 不保存 answered (resolveClose 'discard') and crash in the SAME tick
//      → the confirmed quit still completes (the app exits).
//   C3 dirty, window close (⌘W) → dialog; app.quit() while it is up (quitting=true, held); crash →
//      recovery; then a clean window close closes the window (no reopen while flags stale), an
//      open-file brings a new window with the file, and app.quit() exits.
//   C4 dirty, app.quit() → dialog; crash; app.quit() again while the page is still reloading →
//      the app exits (not trapped by a stale closeAsked).
//   C5 dirty, app.quit() → dialog; open-file of B (held); crash → B is shown after recovery and the
//      app still quits afterwards.
//   MDR_EXE=/path/to/MDReader node bench/electron/verify-final-review-l2.mjs [C1 C2 ...]
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE;
if (!EXE) { console.error('set MDR_EXE'); process.exit(64); }
const only = process.argv.slice(2);
const want = (t) => only.length === 0 || only.includes(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-fr-l2-')));
const errors = [];
let app = null;
let pid = null;
let prof = null;
let exited = false;

const globalTimer = setTimeout(async () => {
  console.log(JSON.stringify({ case: 'GLOBAL', timeout: true }));
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(2);
}, Number(process.env.MDR_TIMEOUT_MS || 110000));

function makeDoc(tag) {
  const name = `frl2-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  fs.writeFileSync(file, `# ${h1}\n\nmarker-${tag}\n`, 'utf8');
  return { file, name, h1 };
}

async function launch() {
  prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-frl2-'));
  exited = false;
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`], timeout: 30000 });
  pid = app.process()?.pid;
  app.process()?.on('exit', () => { exited = true; });
  await app.evaluate(({ app: a, dialog }) => {
    a.addRecentDocument = () => {};
    globalThis.__mainErr = [];
    globalThis.__boxes = [];
    process.on('uncaughtException', (e) => globalThis.__mainErr.push(String(e && e.message)));
    process.on('unhandledRejection', (e) => globalThis.__mainErr.push(`rej ${String(e && e.message)}`));
    dialog.showMessageBox = async (...x) => {
      const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {};
      globalThis.__boxes.push(o.message);
      return { response: 0, checkboxChecked: false };
    };
  });
  app.on('window', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e && e.message).slice(0, 160)}`));
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
}

async function cleanup() {
  if (app && !exited) {
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
  }
  if (app) await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) {
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { break; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
  app = null; pid = null;
  if (prof) fs.rmSync(prof, { recursive: true, force: true });
  prof = null;
}

const emitOpen = (p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
const nWin = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const execMain = (js) => app.evaluate(({ BrowserWindow }, code) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w || w.webContents.isLoading() || w.webContents.isCrashed()) return null;
  return Promise.race([
    w.webContents.executeJavaScript(code).catch((e) => ({ err: String(e && e.message) })),
    new Promise((r) => setTimeout(() => r(null), 1500)),
  ]);
}, js);
const state = () => execMain(`({ title: document.title,
  h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
  buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()) })`);
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  let s = null;
  let n = -1;
  while (Date.now() < end) {
    if (exited) return { ok: pred(null, 0, true), s: null, n: 0, exited: true };
    s = await state().catch(() => null);
    n = await nWin().catch(() => -1);
    if (pred(s, n, false)) return { ok: true, s, n };
    await sleep(150);
  }
  return { ok: false, s, n };
}
async function waitExit(ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (exited) return true; await sleep(100); }
  return exited;
}
const clickBtn = (label) => execMain(`(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')]
  .find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
const livePage = () => app.windows().filter((x) => !x.isClosed()).at(-1);
async function makeDirty(text) {
  const pg = livePage();
  await pg.click('.cm-content');
  await pg.keyboard.press('Meta+End');
  await pg.keyboard.type(text, { delay: 5 });
  await pg.waitForFunction(() => document.title.startsWith('●'), null, { timeout: 4000 }).catch(() => {});
  await sleep(400);
}
// After a crash Playwright keeps the old Page marked crashed: type through the main process instead.
async function makeDirtyMain(text) {
  await app.evaluate(async ({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.focus();
    await w.webContents.executeJavaScript(`(() => { const c = document.querySelector('.cm-content'); c.focus();
      const v = c.cmView?.view; return true; })()`);
    await w.webContents.insertText(t);
  }, text);
  for (let i = 0; i < 20; i++) { const s = await state().catch(() => null); if (s?.title?.startsWith('●')) break; await sleep(200); }
  await sleep(400);
}
const shows = (doc) => (s, n) => n === 1 && !!s && !!s.title?.includes(doc.name) && s.h1 === doc.h1;
const hasDialog = (s) => !!s && s.buttons.includes('不保存');
const crash = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
const quitSoon = () => app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
const mainErr = () => (exited ? [] : app.evaluate(() => globalThis.__mainErr).catch(() => ['?']));
const report = (o) => console.log(JSON.stringify(o));

async function openAndDirty(doc) {
  await emitOpen(doc.file);
  const a = await waitFor(shows(doc));
  await makeDirty(' 改动');
  const t = await state();
  return { aShown: a.ok, dirty: !!t?.title?.startsWith('●') };
}

async function C1() {
  await launch();
  const A = makeDoc('c1');
  const pre = await openAndDirty(A);
  await quitSoon();
  const d1 = await waitFor((s) => hasDialog(s));
  await crash();
  await sleep(300);
  const rec = await waitFor(shows(A), 10000);
  const aliveAfterCrash = !exited;
  await makeDirtyMain(' 再改');
  const dirty2 = (await state())?.title ?? null;
  await quitSoon();
  const d2 = await waitFor((s) => hasDialog(s));
  const clicked = await clickBtn('不保存');
  const ex = await waitExit(8000);
  report({ case: 'C1', pass: pre.aShown && pre.dirty && d1.ok && aliveAfterCrash && rec.ok && d2.ok && clicked && ex, ...pre, quitDialog: d1.ok, aliveAfterCrash, recoveredShowsA: rec.ok, recState: rec.s, dirty2, secondQuitDialog: d2.ok, exitedAfterDiscard: ex });
  await cleanup();
}

async function C2() {
  await launch();
  const A = makeDoc('c2');
  const pre = await openAndDirty(A);
  await quitSoon();
  const d1 = await waitFor((s) => hasDialog(s));
  // The renderer's answer and the crash land in the same main-process tick.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    ipcMain.emit('mdr:resolveClose', { sender: w.webContents }, 'discard');
    w.webContents.forcefullyCrashRenderer();
  }).catch(() => {});
  const ex = await waitExit(8000);
  report({ case: 'C2', pass: pre.aShown && pre.dirty && d1.ok && ex, ...pre, quitDialog: d1.ok, exitedAfterConfirmedQuit: ex, windows: ex ? 0 : await nWin().catch(() => -1) });
  await cleanup();
}

async function C3() {
  await launch();
  const A = makeDoc('c3a');
  const B = makeDoc('c3b');
  const pre = await openAndDirty(A);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const d1 = await waitFor((s) => hasDialog(s));
  await quitSoon(); // before-quit while the close dialog is up: quitting=true, held
  await sleep(300);
  const stillUp = await waitFor((s) => hasDialog(s), 2000);
  await crash();
  await sleep(300);
  const rec = await waitFor(shows(A), 10000);
  // the recovered page shows A again; its draft logic may mark it dirty — check, then close
  const recTitle = rec.s?.title ?? null;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  let afterClose = await waitFor((s, n) => n === 0 || hasDialog(s), 4000);
  let answered = null;
  if (afterClose.n !== 0 && hasDialog(afterClose.s)) {
    answered = await clickBtn('不保存');
    afterClose = await waitFor((s, n) => n === 0, 4000);
  }
  await sleep(800);
  const winsAfterClose = exited ? 'exited' : await nWin();
  await emitOpen(B.file);
  const b = exited ? { ok: false } : await waitFor(shows(B), 10000);
  await quitSoon();
  const ex = await waitExit(8000);
  report({ case: 'C3', pass: pre.dirty && d1.ok && stillUp.ok && rec.ok && winsAfterClose === 0 && b.ok && ex, ...pre, closeDialog: d1.ok, dialogStillUpAfterQuit: stillUp.ok, recoveredShowsA: rec.ok, recTitle, answeredSecondDialog: answered, winsAfterClose, bShownInNewWindow: b.ok, bState: b.s, exitedOnQuit: ex });
  await cleanup();
}

async function C4() {
  await launch();
  const A = makeDoc('c4');
  const pre = await openAndDirty(A);
  await quitSoon();
  const d1 = await waitFor((s) => hasDialog(s));
  await app.evaluate(({ app: a, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    setTimeout(() => a.quit(), 150); // the page is reloading now
  }).catch(() => {});
  let ex = await waitExit(6000);
  let dialogAfter = null;
  if (!ex) {
    const d = await waitFor((s) => hasDialog(s), 4000);
    dialogAfter = d.ok;
    if (d.ok) { await clickBtn('不保存'); ex = await waitExit(6000); }
  }
  report({ case: 'C4', pass: pre.dirty && d1.ok && ex, ...pre, quitDialog: d1.ok, exited: ex, dialogAfterSecondQuit: dialogAfter });
  await cleanup();
}

async function C5() {
  await launch();
  const A = makeDoc('c5a');
  const B = makeDoc('c5b');
  const pre = await openAndDirty(A);
  await quitSoon();
  const d1 = await waitFor((s) => hasDialog(s));
  await emitOpen(B.file); // held: closeAsked
  await sleep(500);
  const held = await state();
  await crash();
  await sleep(300);
  const b = await waitFor(shows(B), 10000);
  let s2 = b.s;
  if (!b.ok) s2 = await state().catch(() => null);
  await quitSoon();
  let ex = await waitExit(5000);
  let dialogOnQuit = null;
  if (!ex) {
    const d = await waitFor((s) => hasDialog(s), 3000);
    dialogOnQuit = d.ok;
    if (d.ok) { await clickBtn('不保存'); ex = await waitExit(6000); }
  }
  report({ case: 'C5', pass: pre.dirty && d1.ok && b.ok && ex, ...pre, quitDialog: d1.ok, heldTitle: held?.title, bShownAfterCrash: b.ok, stateAfterCrash: s2, exitedOnQuit: ex, dialogOnQuit });
  await cleanup();
}

let failed = 0;
try {
  for (const [name, fn] of [['C1', C1], ['C2', C2], ['C3', C3], ['C4', C4], ['C5', C5]]) {
    if (!want(name)) continue;
    try { await fn(); } catch (e) { failed++; report({ case: name, pass: false, scriptError: String(e && e.message).slice(0, 300) }); await cleanup(); }
  }
} finally {
  clearTimeout(globalTimer);
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ case: 'ERRORS', consoleAndPageErrors: errors });
}
process.exit(failed ? 1 : 0);
