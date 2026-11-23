// bench/electron/fix2-e-navprobe.mjs — fix-shell (0.2.0 stage 2b): order of navigation events
// (did-start-navigation / will-navigate / did-fail-load / did-stop-loading ...) for page-initiated and
// main-process-initiated navigations, plus whether the shell cancelled them. Diagnostic only.
//   MDR_APP_DIR=<shell dir> node bench/electron/fix2-e-navprobe.mjs
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-fix2e-nav-'));
let app = null;
const timer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await done(); process.exit(2); }, 90000);
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
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    globalThis.__ev = [];
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (const n of ['did-start-navigation', 'will-navigate', 'did-navigate', 'did-fail-load', 'did-fail-provisional-load', 'did-stop-loading', 'did-start-loading', 'did-finish-load']) {
      wc.on(n, (...a) => {
        const d = a[0] && typeof a[0] === 'object' && 'url' in a[0] ? a[0] : null;
        const prevented = a[0] && a[0].defaultPrevented ? ' PREVENTED' : '';
        const init = d ? ` init=${d.initiator === undefined ? 'undef' : d.initiator === null ? 'null' : 'frame'}` : '';
        globalThis.__ev.push(`${n} ${d ? `${d.url} main=${d.isMainFrame} same=${d.isSameDocument}${init}` : a.slice(1, 5).map((x) => String(x).slice(0, 50)).join(' ')}${prevented}`);
      });
    }
    ipcMain.on('mdr:readyForFiles', () => globalThis.__ev.push('IPC readyForFiles'));
  });
  const run = async (label, fn) => {
    await app.evaluate(() => { globalThis.__ev = []; });
    await fn();
    await sleep(2000);
    const ev = await app.evaluate(({ BrowserWindow }) => [...globalThis.__ev, `URL ${BrowserWindow.getAllWindows()[0]?.webContents.getURL()}`]);
    console.log(`== ${label}`);
    for (const e of ev) console.log(`   ${e}`);
  };
  const exec = (js) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code).catch((e) => String(e)), js);
  await run('page link click app://mdreader/nonexistent.md', () => exec(`(() => { const a = document.createElement('a'); a.href = 'app://mdreader/nonexistent.md'; document.body.appendChild(a); a.click(); a.remove(); return 1; })()`));
  await run('page location.reload()', () => exec(`(() => { location.reload(); return 1; })()`));
  await run('page location.href = index.html?x=1', () => exec(`(() => { location.href = 'app://mdreader/index.html?x=1'; return 1; })()`));
  await run('page link click about:blank#x (cancelled, nothing opened)', () => exec(`(() => { const a = document.createElement('a'); a.href = 'about:blank#x'; document.body.appendChild(a); a.click(); a.remove(); return 1; })()`));
  await run('wc.reload()', () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload()));
  await sleep(1500);
  await run('wc.loadURL(app://mdreader/)', () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.loadURL('app://mdreader/').catch(() => {}); }));
} finally {
  clearTimeout(timer);
  await done();
}
