// bench/electron/verify-final-review-normal.mjs — final:verify-review#1 (2026-11-20).
// Normal-use regression probes, meant to be run on BOTH the hotfix and the installed 0.1.0 and the
// JSON lines compared. Native panels are stubbed in the main process (dialog.showOpenDialog /
// showSaveDialog / shell.openExternal); menu commands are fired with MenuItem.click(); documents
// arrive through app.emit('open-file'); recent documents are stubbed; isolated profile per case.
//   MDR_EXE=/path/to/MDReader node bench/electron/verify-final-review-normal.mjs [N1 N2 ...]
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE;
// MDR_APP_DIR=/path/to/unpacked-app runs the project's electron on that app directory instead of MDR_EXE.
const APP_DIR = process.env.MDR_APP_DIR || '';
if (!EXE && !APP_DIR) { console.error('set MDR_EXE or MDR_APP_DIR'); process.exit(64); }
const only = process.argv.slice(2);
const want = (t) => only.length === 0 || only.includes(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-fr-n-')));
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
  const name = `frn-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  fs.writeFileSync(file, `# ${h1}\n\nmarker-${tag}\n`, 'utf8');
  return { file, name, h1 };
}

async function launch(extraArgs = []) {
  prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-frn-'));
  exited = false;
  app = await electron.launch(APP_DIR
    ? { args: [APP_DIR, `--user-data-dir=${prof}`, ...extraArgs], timeout: 30000 }
    : { executablePath: EXE, args: [`--user-data-dir=${prof}`, ...extraArgs], timeout: 30000 });
  pid = app.process()?.pid;
  app.process()?.on('exit', () => { exited = true; });
  await app.evaluate(({ app: a, BrowserWindow, dialog, shell }) => {
    a.addRecentDocument = () => {};
    globalThis.__mainErr = [];
    globalThis.__sent = [];
    globalThis.__ext = [];
    globalThis.__openPick = null;
    globalThis.__savePick = null;
    process.on('uncaughtException', (e) => globalThis.__mainErr.push(String(e && e.message)));
    process.on('unhandledRejection', (e) => globalThis.__mainErr.push(`rej ${String(e && e.message)}`));
    dialog.showOpenDialog = async () => (globalThis.__openPick ? { canceled: false, filePaths: [globalThis.__openPick] } : { canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => (globalThis.__savePick ? { canceled: false, filePath: globalThis.__savePick } : { canceled: true, filePath: '' });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    shell.openExternal = async (u) => { globalThis.__ext.push(u); };
    const hook = (w) => {
      const wc = w.webContents;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => { globalThis.__sent.push({ win: w.id, ch, arg: rest[0] }); return orig(ch, ...rest); };
    };
    for (const w of BrowserWindow.getAllWindows()) hook(w);
    a.on('browser-window-created', (_e, w) => hook(w));
  });
  app.on('window', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e && e.message).slice(0, 160)}`));
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(700);
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
  editor: (document.querySelector('.cm-content')?.textContent ?? '').length,
  h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
  mode: document.querySelector('.mdr-app')?.className ?? document.body.className,
  buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()) })`);
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  let s = null;
  let n = -1;
  while (Date.now() < end) {
    if (exited) return { ok: false, s: null, n: 0, exited: true };
    s = await state().catch(() => null);
    n = await nWin().catch(() => -1);
    if (pred(s, n)) return { ok: true, s, n };
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
async function makeDirty(text) {
  await app.evaluate(async ({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.focus();
    await w.webContents.executeJavaScript(`(() => { const c = document.querySelector('.cm-content'); c.focus();
      const sel = window.getSelection(); sel.selectAllChildren(c); sel.collapseToEnd(); return true; })()`);
    await w.webContents.insertText(t);
  }, text);
  for (let i = 0; i < 20; i++) { const s = await state().catch(() => null); if (s?.title?.startsWith('●')) break; await sleep(200); }
  await sleep(500);
}
const menuClick = (id) => app.evaluate(({ Menu, BrowserWindow }, mid) => {
  const it = Menu.getApplicationMenu()?.getMenuItemById(mid);
  if (!it) return false;
  it.click(undefined, BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]);
  return true;
}, id);
const sent = () => app.evaluate(() => globalThis.__sent);
const mainErr = () => (exited ? [] : app.evaluate(() => globalThis.__mainErr).catch(() => ['?']));
const shows = (doc) => (s, n) => n === 1 && !!s && !!s.title?.includes(doc.name) && s.h1 === doc.h1 && !s.title.startsWith('●');
const hasDialog = (s) => !!s && s.buttons.includes('不保存');
const closeWin = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
const report = (o) => console.log(JSON.stringify(o));

const cases = {
  async N1() { // cold start without a document (argv cold start is open-lifecycle check 1: an argv
    // document would reach the macOS recent list before the stub can be installed, rule 6)
    await launch();
    const s0 = await state();
    report({ case: 'N1', pass: !!s0?.title?.includes('未命名') && s0.editor === 0, noDocTitle: s0?.title, editor: s0?.editor, mainErr: await mainErr() });
  },
  async N2() { // 打开… via the menu (stubbed panel), then 保存 and 另存为
    await launch();
    const A = makeDoc('n2');
    await app.evaluate((_, p) => { globalThis.__openPick = p; }, A.file);
    const clicked = await menuClick('file.open');
    const a = await waitFor(shows(A));
    await makeDirty(' 追加');
    await menuClick('file.save');
    const saved = await waitFor((s) => !!s && s.title === `${A.name} — MDReader` || (!!s && s.title?.includes(A.name) && !s.title.startsWith('●')), 5000);
    const disk1 = fs.readFileSync(A.file, 'utf8');
    const B = path.join(TMP, 'frn-n2-saveas.md');
    await app.evaluate((_, p) => { globalThis.__savePick = p; }, B);
    await menuClick('file.saveAs');
    const sa = await waitFor((s) => !!s && s.title?.includes('frn-n2-saveas.md') && !s.title.startsWith('●'), 5000);
    const disk2 = fs.existsSync(B) ? fs.readFileSync(B, 'utf8') : null;
    report({ case: 'N2', pass: clicked && a.ok && saved.ok && disk1.includes('追加') && sa.ok && disk2 === disk1, openShown: a.ok, saved: saved.ok, savedTitle: saved.s?.title, diskHasEdit: disk1.includes('追加'), saveAsTitle: sa.s?.title, saveAsSame: disk2 === disk1, mainErr: await mainErr() });
  },
  async N3() { // dirty close: 取消, then 不保存; activate brings a window; open-file shows a file
    await launch();
    const A = makeDoc('n3a');
    const B = makeDoc('n3b');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await makeDirty(' x');
    await closeWin();
    const d1 = await waitFor((s) => hasDialog(s));
    await clickBtn('取消');
    await sleep(600);
    const afterCancel = await state();
    const wins1 = await nWin();
    await closeWin();
    const d2 = await waitFor((s) => hasDialog(s));
    await clickBtn('不保存');
    await sleep(1000);
    const wins2 = await nWin();
    const diskA = fs.readFileSync(A.file, 'utf8');
    await app.evaluate(({ app: x }) => x.emit('activate', {}, false));
    const act = await waitFor((s, n) => n === 1 && !!s?.title?.includes('未命名'), 8000);
    await emitOpen(B.file);
    const b = await waitFor(shows(B));
    report({ case: 'N3', pass: a.ok && d1.ok && wins1 === 1 && afterCancel?.title?.startsWith('●') && d2.ok && wins2 === 0 && !diskA.includes(' x') && act.ok && b.ok, dialog1: d1.ok, afterCancelTitle: afterCancel?.title, wins1, dialog2: d2.ok, winsAfterDiscard: wins2, diskUnchanged: !diskA.includes(' x'), activateWindow: act.ok, activateTitle: act.s?.title, bShown: b.ok, mainErr: await mainErr() });
  },
  async N4() { // dirty close → 保存
    await launch();
    const A = makeDoc('n4');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await makeDirty(' 保存我');
    await closeWin();
    const d = await waitFor((s) => hasDialog(s));
    await clickBtn('保存');
    let wins = -1;
    for (let i = 0; i < 30; i++) { wins = await nWin(); if (wins === 0) break; await sleep(200); }
    const disk = fs.readFileSync(A.file, 'utf8');
    report({ case: 'N4', pass: a.ok && d.ok && wins === 0 && disk.includes('保存我') && !exited, dialog: d.ok, winsAfterSave: wins, diskSaved: disk.includes('保存我'), appAlive: !exited, mainErr: await mainErr() });
  },
  async N5() { // quit: clean exits; dirty → 保存 saves and exits
    await launch();
    await app.evaluate(({ app: x }) => { setTimeout(() => x.quit(), 0); });
    const ex1 = await waitExit(6000);
    await cleanup();
    await launch();
    const A = makeDoc('n5');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await makeDirty(' 退出保存');
    await app.evaluate(({ app: x }) => { setTimeout(() => x.quit(), 0); });
    const d = await waitFor((s) => hasDialog(s));
    await clickBtn('保存');
    const ex2 = await waitExit(8000);
    const disk = fs.readFileSync(A.file, 'utf8');
    report({ case: 'N5', pass: ex1 && a.ok && d.ok && ex2 && disk.includes('退出保存'), cleanQuitExited: ex1, dirtyDialog: d.ok, dirtyQuitExited: ex2, diskSaved: disk.includes('退出保存') });
  },
  async N6() { // menu commands with a window open: every one reaches the renderer
    await launch();
    const A = makeDoc('n6');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    const ids = ['view.mode.preview', 'view.mode.edit', 'view.mode.split', 'view.toggleToc', 'view.toggleToc', 'view.cycleMode', 'view.toggleTheme', 'view.toggleTheme', 'edit.find', 'view.palette', 'view.mountAll', 'edit.undo', 'edit.redo'];
    const clicked = [];
    for (const id of ids) { clicked.push(await menuClick(id)); await sleep(120); }
    await sleep(400);
    const got = (await sent()).filter((x) => x.ch === 'mdr:command').map((x) => x.arg);
    const missing = ids.filter((id, i) => got.filter((g) => g === id).length < ids.slice(0, i + 1).filter((x) => x === id).length);
    report({ case: 'N6', pass: a.ok && clicked.every(Boolean) && missing.length === 0, clicked: clicked.filter(Boolean).length, delivered: got.length, missing, mainErr: await mainErr() });
  },
  async N7() { // minimised window: open-file and second-instance restore it and show the file
    await launch();
    const A = makeDoc('n7a');
    const B = makeDoc('n7b');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(800);
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await sleep(500);
    const min1 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(800);
    await app.evaluate(({ app: x }, [exe, f]) => x.emit('second-instance', {}, [exe, f], '/'), [EXE, B.file]);
    const b = await waitFor(shows(B));
    await sleep(500);
    const min2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(800);
    await app.evaluate(({ app: x }) => x.emit('activate', {}, false));
    await sleep(800);
    const min3 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    report({ case: 'N7', pass: a.ok && !min1 && b.ok && !min2 && !min3, openFileShown: a.ok, minimisedAfterOpenFile: min1, secondInstanceShown: b.ok, minimisedAfterSecondInstance: min2, minimisedAfterActivate: min3, mainErr: await mainErr() });
  },
  async N8() { // window-state persistence across a close and a new window
    await launch();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1010, height: 690 }));
    await sleep(900);
    await closeWin();
    await sleep(1000);
    const file = path.join(prof, 'window-state.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    await app.evaluate(({ app: x }) => x.emit('activate', {}, false));
    await waitFor((s, n) => n === 1 && !!s, 8000);
    const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    report({ case: 'N8', pass: !!saved && saved.width === 1010 && saved.height === 690 && b.width === 1010 && b.height === 690, saved, reopened: b });
  },
  async N9() { // external link: openExternal, no navigation, the next open-file still shows
    await launch();
    const A = makeDoc('n9');
    await execMain(`(() => { window.open('https://example.invalid/x', '_blank'); return true; })()`);
    await sleep(600);
    // a main-frame navigation attempt to an external URL (link without target)
    await execMain(`(() => { const a = document.createElement('a'); a.href = 'https://example.invalid/y'; document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
    await sleep(800);
    const ext = await app.evaluate(() => globalThis.__ext);
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    report({ case: 'N9', pass: ext.length >= 1 && url.startsWith('app://mdreader') && a.ok, ext, url, windows: await nWin(), nextOpenShown: a.ok, mainErr: await mainErr() });
  },
  async N10() { // menu command while the dirty-close dialog is up AND a document was held (closeAsked)
    await launch();
    const A = makeDoc('n10a');
    const B = makeDoc('n10b');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await makeDirty(' y');
    await closeWin();
    const d = await waitFor((s) => hasDialog(s));
    await emitOpen(B.file);
    await sleep(500);
    const before = (await sent()).length;
    await menuClick('view.toggleTheme');
    await sleep(600);
    const during = (await sent()).slice(before).map((x) => `${x.ch}:${x.arg}`);
    const dlg = await state();
    await clickBtn('取消');
    await sleep(1500);
    const afterCancel = (await sent()).slice(before).map((x) => `${x.ch}:${x.arg}`);
    const s2 = await state();
    report({ case: 'N10', aShown: a.ok, dialog: d.ok, sentDuringDialog: during, buttonsDuringDialog: dlg?.buttons, sentAfterCancel: afterCancel, stateAfterCancel: s2, mainErr: await mainErr() });
  },
  async N11() { // 导出 HTML… (stubbed save panel), then the next open-file and menu command still arrive
    await launch();
    const A = makeDoc('n11a');
    const B = makeDoc('n11b');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    const out = path.join(TMP, 'frn-n11-export.html');
    await app.evaluate((_, p) => { globalThis.__savePick = p; }, out);
    await menuClick('file.exportHtml');
    await sleep(2500);
    const exported = fs.existsSync(out) ? fs.statSync(out).size : 0;
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
    const before = (await sent()).length;
    await emitOpen(B.file);
    const b = await waitFor(shows(B));
    await menuClick('view.toggleTheme');
    await sleep(500);
    const after = (await sent()).slice(before).map((x) => `${x.ch}:${x.arg}`);
    report({ case: 'N11', pass: a.ok && b.ok && after.length === 2, exportedBytes: exported, url, bShown: b.ok, sentAfterExport: after, mainErr: await mainErr() });
  },
  async N12() { // dirty-close dialog up, window minimised, then open-file B and activate: is it restored?
    await launch();
    const A = makeDoc('n12a');
    const B = makeDoc('n12b');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    await makeDirty(' z');
    await closeWin();
    const d = await waitFor((s) => hasDialog(s));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(900);
    await emitOpen(B.file);
    await sleep(900);
    const minAfterOpen = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    await app.evaluate(({ app: x }) => x.emit('activate', {}, false));
    await sleep(900);
    const minAfterActivate = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized());
    const s2 = await state();
    report({ case: 'N12', aShown: a.ok, dialog: d.ok, minimisedAfterOpenFile: minAfterOpen, minimisedAfterActivate: minAfterActivate, state: s2, mainErr: await mainErr() });
  },
};

let failed = 0;
try {
  for (const [name, fn] of Object.entries(cases)) {
    if (!want(name)) continue;
    try { await fn(); } catch (e) { failed++; report({ case: name, pass: false, scriptError: String(e && e.message).slice(0, 300) }); }
    await cleanup();
  }
} finally {
  clearTimeout(globalTimer);
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ case: 'ERRORS', consoleAndPageErrors: errors });
}
process.exit(failed ? 1 : 0);
