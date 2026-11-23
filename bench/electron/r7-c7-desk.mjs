// bench/electron/r7-c7-desk.mjs — challenge-7 (round 7): R7 (c) on the desktop CLOSE path. The document is saved with a slow
// write (the main process's mdr:writeFile handler waits 2.5 s, as bench/electron/v5-offk-save.mjs does it), the window is
// closed while the write is in flight and the close question is answered 不保存; the write then completes in the main
// process (it succeeds). R7 (c) says success deletes the draft — but the renderer that would delete it is gone. The app is
// relaunched with the SAME isolated profile and the case reports whether a draft offer (发现未保存的草稿) appears for text
// that is on disk.
//   saveas-close: the untitled buffer, 另存为 (the panel stubbed to answer a path at once), close, 不保存; relaunch.
//   save-close:   a file, ⌘S, close, 不保存; relaunch, the file handed over by the shell again.
//   MDR_C7_TMP=<scratch> MDR_TARGET=dev MDR_DEV_URL=http://localhost:5465/ node bench/electron/r7-c7-desk.mjs [case ...]
//   MDR_C7_TMP=<scratch> MDR_APP_DIR=release/baseline-0.2.0.noindex node bench/electron/r7-c7-desk.mjs [case ...]
// Launch only through ./_electron.mjs (isolated profile). No full screen. Global timeout 110 s. Prints OBS lines.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = process.env.MDR_TARGET === 'dev';
const DIR = DEV ? ROOT : path.resolve(ROOT, process.env.MDR_APP_DIR || 'release/baseline-0.2.0.noindex');
if (DEV && !process.env.MDR_DEV_URL) { console.log('MDR_TARGET=dev needs MDR_DEV_URL'); process.exit(2); }
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_C7_TMP || os.tmpdir(), 'c7-desk-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
async function launch(prof) {
  app = await electron.launch({ args: [DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  if (DEV) {
    await page.evaluate(() => { localStorage.setItem('mdr.previewEdit', '0'); });
    await page.reload();
    await page.waitForSelector('.cm-content', { timeout: 20000 });
  }
  await sleep(1500);
}
const text = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const title = () => page.evaluate(() => document.title);
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
const dialogsUp = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 60)));
const clickBtn = (l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const until = async (fn, ms = 6000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(80); } return false; };
const emitOpen = (p) => app.evaluate(({ app: a }, f) => { a.emit('open-file', { preventDefault() {} }, f); }, p);
const slowWrites = (ms) => app.evaluate(({ ipcMain }, delay) => {
  const map = ipcMain._invokeHandlers;
  const orig = globalThis.__c7OrigWrite || (map && map.get('mdr:writeFile'));
  if (!orig) return false;
  globalThis.__c7OrigWrite = orig;
  ipcMain.removeHandler('mdr:writeFile');
  ipcMain.handle('mdr:writeFile', async (e, ...a) => { if (delay) await new Promise((r) => setTimeout(r, delay)); return orig(e, ...a); });
  return true;
}, ms);
async function typeEnd(s) {
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(s);
}
async function closeDiscard() {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const asked = await until(async () => (await dialogsUp()).length > 0, 2500);
  const q = await dialogsUp();
  const clicked = asked ? await clickBtn('不保存') : false;
  await sleep(4000);   // the write completes in the main process
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 'gone');
  return { asked, q, clicked, wins };
}
const CASES = {
  async 'saveas-close'(prof) {
    const target = path.join(TMP, 'saved-as.md');
    await launch(prof);
    await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }); }, target);
    await slowWrites(2500);
    await typeEnd('untitled words');
    await page.keyboard.press('Meta+Shift+s');
    await sleep(400);
    const c = await closeDiscard();
    const saved = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    await quit();
    await launch(prof);
    await sleep(2000);
    const o = { ...c, saved, relaunch: { title: await title(), text: await text(), toasts: await toasts() } };
    console.log('OBS saveas-close', JSON.stringify(o));
  },
  async 'save-close'(prof) {
    const a = path.join(TMP, 'k1.md');
    fs.writeFileSync(a, '# K1\n');
    await launch(prof);
    await emitOpen(a);
    await until(async () => (await text()).includes('K1'));
    await slowWrites(2500);
    await typeEnd('typed');
    await page.evaluate(() => document.querySelector('.cm-content').focus());
    await page.keyboard.press('Meta+s');
    await sleep(400);
    const c = await closeDiscard();
    const d1 = fs.readFileSync(a, 'utf8');
    await quit();
    await launch(prof);
    await emitOpen(a);
    await until(async () => (await text()).includes('K1'));
    await sleep(1500);
    const o = { ...c, d1, relaunch: { title: await title(), text: await text(), toasts: await toasts() } };
    console.log('OBS save-close', JSON.stringify(o));
  },
};
try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const prof = path.join(TMP, 'prof-' + name);
    try { await fn(prof); } catch (e) { console.log('ERROR', name, String(e).split('\n')[0]); }
    await quit();
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`r7-c7-desk ${DEV ? 'dev' : DIR} done`);
  process.exit(0);
}
