// bench/electron/fixE-nav-events.mjs — which webContents events fire for an app-origin main-frame
// navigation that is aborted (V1), a reload, and a committed 404 (V2)? Input for the S1/V1 fix.
//   MDR_APP_DIR=/path/to/unpacked-app node bench/electron/fixE-nav-events.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-fixE-nav-'));
let app = null;
const timer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await done(); process.exit(2); }, 80000);
async function done() {
  if (app) {
    const pid = app.process()?.pid;
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    app = null;
  }
  fs.rmSync(prof, { recursive: true, force: true });
}
try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__ev = [];
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (const n of ['did-start-navigation', 'did-navigate', 'did-frame-navigate', 'did-fail-load', 'did-fail-provisional-load', 'did-stop-loading', 'did-start-loading', 'did-finish-load']) {
      wc.on(n, (...a) => {
        const d = a[0] && typeof a[0] === 'object' && 'url' in a[0] ? a[0] : null;
        globalThis.__ev.push(`${n} ${d ? `${d.url} main=${d.isMainFrame} same=${d.isSameDocument}` : a.slice(1, 5).map((x) => String(x).slice(0, 50)).join(' ')}`);
      });
    }
    const { ipcMain } = require('electron');
    ipcMain.on('mdr:readyForFiles', () => globalThis.__ev.push('IPC readyForFiles'));
  }).catch(async () => {
    // ESM app: require is not defined in evaluate; retry without the ipc hook
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      globalThis.__ev = [];
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const n of ['did-start-navigation', 'did-navigate', 'did-frame-navigate', 'did-fail-load', 'did-fail-provisional-load', 'did-stop-loading', 'did-start-loading', 'did-finish-load']) {
        wc.on(n, (...a) => {
          const d = a[0] && typeof a[0] === 'object' && 'url' in a[0] ? a[0] : null;
          globalThis.__ev.push(`${n} ${d ? `${d.url} main=${d.isMainFrame} same=${d.isSameDocument}` : a.slice(1, 5).map((x) => String(x).slice(0, 50)).join(' ')}`);
        });
      }
      ipcMain.on('mdr:readyForFiles', () => globalThis.__ev.push('IPC readyForFiles'));
    });
  });
  const run = async (label, fn) => {
    await app.evaluate(() => { globalThis.__ev = []; });
    await fn();
    await sleep(2000);
    const ev = await app.evaluate(() => globalThis.__ev.slice());
    console.log(`== ${label}`);
    for (const e of ev) console.log(`   ${e}`);
  };
  const exec = (js) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code).catch(() => null), js);
  // Since S3 (0.2.0 stage 2b) will-navigate cancels every navigation the page starts: the page-side
  // case shows the cancel; the aborted (V1) and committed-404 (V2) navigations come from the main process.
  await run('S3 page location.href (cancelled by will-navigate)', () => exec(`(() => { location.href = 'app://mdreader/index.html?x=1'; return 1; })()`));
  await run('V1 aborted (main-process loadURL + stop)', () => app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.loadURL('app://mdreader/index.html?x=1').catch(() => {}); wc.stop(); }));
  await run('reload', () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload()));
  await run('V2 404 commit (main-process loadURL)', () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.loadURL('app://mdreader/nonexistent.md').catch(() => {}); }));
} finally {
  clearTimeout(timer);
  await done();
}
