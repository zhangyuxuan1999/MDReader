// bench/electron/verify-final-review-fileio.mjs — final:verify-review#1 (2026-11-20).
// The new main.mjs with the OLD (0.1.0) fileIO.mjs: reads that hang (FIFO named .md) or throw
// (deleted file, folder named .md, binary) — does the open queue / crash restore / close / quit
// end up worse than 0.1.0? Run on both executables and compare.
//   F1 window open: open-file FIFO, then open-file A; then close the window, open-file B; then quit.
//   F2 window open showing A; A deleted; renderer crash → what the reloaded window shows; quit.
//   F3 open-file of a folder named x.md and of a binary .md, then A: errors shown, A shown last.
//   MDR_EXE=/path/to/MDReader node bench/electron/verify-final-review-fileio.mjs [F1 F2 F3]
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE;
if (!EXE) { console.error('set MDR_EXE'); process.exit(64); }
const only = process.argv.slice(2);
const want = (t) => only.length === 0 || only.includes(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-fr-f-')));
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
}, Number(process.env.MDR_TIMEOUT_MS || 100000));

function makeDoc(tag) {
  const name = `frf-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  fs.writeFileSync(file, `# ${h1}\n\nmarker-${tag}\n`, 'utf8');
  return { file, name, h1 };
}

async function launch() {
  prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-frf-'));
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
  toasts: [...document.querySelectorAll('.mdr-toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 3) })`);
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  let s = null;
  let n = -1;
  while (Date.now() < end) {
    if (exited) return { ok: false, s: null, n: 0 };
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
const shows = (doc) => (s, n) => n === 1 && !!s && !!s.title?.includes(doc.name) && s.h1 === doc.h1;
const mainErr = () => (exited ? [] : app.evaluate(() => globalThis.__mainErr).catch(() => ['?']));
const report = (o) => console.log(JSON.stringify(o));

const cases = {
  async F1() {
    const fifo = path.join(TMP, 'frf-fifo.md');
    execFileSync('mkfifo', [fifo]);
    await launch();
    const A = makeDoc('f1a');
    const B = makeDoc('f1b');
    await emitOpen(fifo);
    await sleep(800);
    await emitOpen(A.file);
    const a = await waitFor(shows(A), 4000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(1200);
    const winsAfterClose = await nWin();
    await emitOpen(B.file);
    const b = await waitFor(shows(B), 8000);
    await app.evaluate(({ app: x }) => { setTimeout(() => x.quit(), 0); });
    const ex = await waitExit(Number(process.env.MDR_F1_WAIT || 8000));
    let alive = null;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    // release the blocked reader so nothing lingers
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* no reader left */ }
    report({ case: 'F1', aShownAfterFifo: a.ok, aState: a.s, winsAfterClose, bShownAfterClose: b.ok, bState: b.s, quitExited: ex, processAliveAfterWait: alive, mainErr: ex ? [] : await Promise.race([mainErr(), sleep(2000).then(() => ['evaluate timed out'])]) });
  },
  async F2() {
    await launch();
    const A = makeDoc('f2');
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    fs.rmSync(A.file);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await sleep(3500);
    const s = await state().catch(() => null);
    const crashed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.isCrashed()));
    const B = makeDoc('f2b');
    await emitOpen(B.file);
    const b = await waitFor(shows(B), 8000);
    await app.evaluate(({ app: x }) => { setTimeout(() => x.quit(), 0); });
    const ex = await waitExit(8000);
    report({ case: 'F2', aShown: a.ok, afterCrash: s, crashed, nextOpenShown: b.ok, quitExited: ex });
  },
  async F3() {
    await launch();
    const dir = path.join(TMP, 'frf-folder.md');
    fs.mkdirSync(dir);
    const bin = path.join(TMP, 'frf-binary.md');
    fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x1b, 0x07, 0x00, 0x00]));
    const A = makeDoc('f3');
    await emitOpen(dir);
    await sleep(800);
    const s1 = await state();
    await emitOpen(bin);
    await sleep(800);
    const s2 = await state();
    await emitOpen(A.file);
    const a = await waitFor(shows(A));
    report({ case: 'F3', folder: s1, binary: s2, aShown: a.ok, mainErr: await mainErr() });
  },
};

try {
  for (const [name, fn] of Object.entries(cases)) {
    if (!want(name)) continue;
    try { await fn(); } catch (e) { report({ case: name, scriptError: String(e && e.message).slice(0, 300) }); }
    await cleanup();
  }
} finally {
  clearTimeout(globalTimer);
  await cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ case: 'ERRORS', consoleAndPageErrors: errors });
}
process.exit(0);
