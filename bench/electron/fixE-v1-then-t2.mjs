// bench/electron/fixE-v1-then-t2.mjs — step-logged probe: an aborted app-origin navigation (V1),
// then 打开… in the same tick as the window's close (T2). Isolates open-lifecycle checks (25)→(26).
//   MDR_APP_DIR=/path/to/unpacked-app node bench/electron/fixE-v1-then-t2.mjs [--no-v1]
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const skipV1 = process.argv.includes('--no-v1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-fixE-')));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-fixE-'));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let app = null;
const timer = setTimeout(async () => { log('GLOBAL TIMEOUT'); await done(); process.exit(2); }, 90000);
async function done() {
  if (app) {
    const pid = app.process()?.pid;
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    app = null;
  }
  fs.rmSync(prof, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => `TIMEOUT(${label})`)]);
const snap = () => withTimeout(app.evaluate(async ({ BrowserWindow }) => {
  const ws = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const w = ws[0];
  if (!w) return { windows: 0 };
  if (w.webContents.isLoading()) return { windows: ws.length, loading: true, url: w.webContents.getURL() };
  const r = await Promise.race([w.webContents.executeJavaScript('document.title'), new Promise((x) => setTimeout(() => x('EXEC-TIMEOUT'), 1500))]);
  return { windows: ws.length, title: r, url: w.webContents.getURL() };
}), 4000, 'snap');
try {
  const name = 'fixE-picked.md';
  const file = path.join(TMP, name);
  fs.writeFileSync(file, '# picked\n\nbody\n');
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  log('launched', JSON.stringify(await snap()));
  if (!skipV1) {
    // Since S3 (0.2.0 stage 2b) a page-initiated location.href is cancelled by will-navigate: the
    // aborted app-origin navigation (V1) is started from the main process (loadURL + stop()).
    const r = await withTimeout(app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.loadURL('app://mdreader/index.html?x=1').catch(() => {});
      wc.stop();
      return true;
    }), 5000, 'v1');
    log('V1 exec', JSON.stringify(r));
    await sleep(1500);
    log('after V1', JSON.stringify(await snap()));
  }
  if (process.argv.includes('--like-25')) {
    // the extra steps of open-lifecycle check (25): send hook, open-file, theme toggled twice
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => orig(ch, ...rest);
    });
    const other = path.join(TMP, 'fixE-other.md');
    fs.writeFileSync(other, '# other\n');
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
    await sleep(1500);
    log('after open-file', JSON.stringify(await snap()));
    for (let i = 0; i < 2; i++) {
      const t = await withTimeout(app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.toggleTheme').click(); return 'ok'; }), 4000, 'theme');
      log('theme', t);
    }
    await sleep(500);
  }
  await app.evaluate(({ dialog }, fp) => {
    globalThis.__calls = 0;
    dialog.showOpenDialog = async () => { globalThis.__calls++; return { canceled: false, filePaths: [fp] }; };
  }, file);
  const r2 = await withTimeout(app.evaluate(({ BrowserWindow, Menu }) => {
    BrowserWindow.getAllWindows()[0].close();
    Menu.getApplicationMenu().getMenuItemById('file.open').click();
    return 'clicked';
  }), 5000, 'close+click');
  log('close+click', JSON.stringify(r2));
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const s = await snap();
    const calls = await withTimeout(app.evaluate(() => globalThis.__calls), 3000, 'calls');
    log('poll', JSON.stringify(s), 'calls', calls);
    if (s && s.title && String(s.title).includes(name)) { log('RESULT shown'); break; }
  }
} catch (e) {
  log('ERROR', String(e && e.stack || e).slice(0, 400));
} finally {
  clearTimeout(timer);
  await done();
}
