// bench/electron/v5-offk-save.mjs — verify-off-desktop (0.2.0 r4 verification): J4 / R6 variations on the desktop.
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-save.mjs [case ...]
// The main process's mdr:writeFile handler is wrapped so a write waits (Electron's own handler map, no crash);
// dialog.showSaveDialog is stubbed to record its call and answer "cancelled" (no panel on the user's screen).
// Production renderer, no test hooks, nothing stored for the switch (off). Launch only through ./_electron.mjs.
// No full screen. Global timeout 110 s. Prints one OBS line per case (compare cand with base) and PASS/FAIL.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// fix-save (round 7, harness): MDR_TARGET=dev runs the tree's shell over a running Vite (MDR_DEV_URL=http://localhost:<port>/),
// with 预览可编辑 stored "0" (the dev renderer would start it on); MDR_APP_DIR names any other candidate directory.
const DEV = process.env.MDR_TARGET === 'dev';
const DIR = DEV ? ROOT : process.env.MDR_APP_DIR ? path.resolve(process.env.MDR_APP_DIR) : process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.join(ROOT, 'release/staging-0.2.0.noindex');
if (DEV && !process.env.MDR_DEV_URL) { console.log('MDR_TARGET=dev needs MDR_DEV_URL'); process.exit(2); }
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-save-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
const checks = [];
const check = (n, ok, d = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);

async function launch() {
  app = await electron.launch({ args: [DIR, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  if (DEV) {
    await page.evaluate(() => { localStorage.setItem('mdr.previewEdit', '0'); });
    await page.reload();
    await page.waitForSelector('.cm-content', { timeout: 20000 });
  }
  await sleep(1200);
  await app.evaluate(({ dialog }) => {
    globalThis.__offkSaveDialogs = [];
    dialog.showSaveDialog = async (...a) => { const o = a.find((x) => x && typeof x === 'object' && 'defaultPath' in x) || a[a.length - 1]; globalThis.__offkSaveDialogs.push(String(o && o.defaultPath)); return { canceled: true, filePath: undefined }; };
  });
}
const text = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const title = () => page.evaluate(() => document.title);
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
const dialogsUp = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 60)));
const clickBtn = (l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const until = async (fn, ms = 6000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(80); } return false; };
const emitOpen = (p) => app.evaluate(({ app: a }, f) => { a.emit('open-file', { preventDefault() {} }, f); }, p);
const menuClick = (id) => app.evaluate(({ Menu }, i) => { const it = Menu.getApplicationMenu().getMenuItemById(i); if (!it) return false; it.click(); return true; }, id);
const saveDialogs = () => app.evaluate(() => globalThis.__offkSaveDialogs.slice());
const doc = (n, t) => { const f = path.join(TMP, n); fs.writeFileSync(f, t); return f; };
const disk = (f) => fs.readFileSync(f, 'utf8');
/** every write waits `ms`; `fail` makes it answer as the handler answers for an error after the wait */
const slowWrites = (ms, fail = false) => app.evaluate(({ ipcMain }, [delay, bad]) => {
  const map = ipcMain._invokeHandlers;
  const orig = globalThis.__offkOrigWrite || (map && map.get('mdr:writeFile'));
  if (!orig) return false;
  globalThis.__offkOrigWrite = orig;
  ipcMain.removeHandler('mdr:writeFile');
  ipcMain.handle('mdr:writeFile', async (e, ...a) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (bad) throw new Error('EIO: simulated slow disk failure');
    return orig(e, ...a);
  });
  return true;
}, [ms, fail]);
async function openDoc(p, marker) {
  await emitOpen(p);
  return until(async () => { await clickBtn('丢弃'); return (await text()).includes(marker); });
}
async function typeEnd(s) {
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(s);
}
const save = async () => { await page.evaluate(() => document.querySelector('.cm-content').focus()); await page.keyboard.press('Meta+s'); };

const CASES = {
  // ⌘S of a dirty file, then 新建 from the MENU while the write waits; 丢弃; then type and ⌘S in the new document
  async 'new-menu-during-save'() {
    const a = doc('n1.md', '# N1\n');
    await openDoc(a, 'N1');
    await slowWrites(2500);
    await typeEnd('typed');
    await save();
    await sleep(250);
    await menuClick('file.new');
    const asked = await until(async () => (await dialogsUp()).length > 0, 1500);
    if (asked) await clickBtn('丢弃');
    await sleep(3200);
    await slowWrites(0);
    const t1 = await title(); const tx1 = await text(); const d1 = disk(a); const to1 = await toasts();
    await typeEnd('NEWDOC');
    await save();
    await sleep(1500);
    const o = { asked, t1, tx1, d1, to1, d2: disk(a), t2: await title(), dlg: await saveDialogs() };
    console.log('OBS new-menu-during-save', JSON.stringify(o));
    check('new-menu-during-save: n1.md keeps the saved text, the new document is not bound to it', o.d1 === '# N1\ntyped' && o.d2 === '# N1\ntyped' && !/n1\.md/.test(o.t1), JSON.stringify([o.d2, o.t1]));
  },
  // two replacements while one write waits: b then c; the last one must stay unbound to a
  async 'two-opens-during-save'() {
    const a = doc('m1.md', '# M1\n'); const b = doc('m2.md', '# M2\n'); const c = doc('m3.md', '# M3\n');
    await openDoc(a, 'M1');
    await slowWrites(3000);
    await typeEnd('typed');
    await save();
    await sleep(200);
    await openDoc(b, 'M2');
    await sleep(300);
    await openDoc(c, 'M3');
    await sleep(3200);
    await slowWrites(0);
    const t1 = await title();
    await typeEnd('more');
    await save();
    await sleep(1500);
    const o = { t1, a: disk(a), b: disk(b), c: disk(c), t2: await title(), to: await toasts() };
    console.log('OBS two-opens-during-save', JSON.stringify(o));
    check('two-opens-during-save', o.a === '# M1\ntyped' && o.b === '# M2\n' && o.c === '# M3\nmore' && o.t1 === 'm3.md', JSON.stringify(o));
  },
  // the same file opened again while its own save waits
  async 'reopen-same-during-save'() {
    const a = doc('r1.md', '# R1\n');
    await openDoc(a, 'R1');
    await slowWrites(2500);
    await typeEnd('typed');
    await save();
    await sleep(200);
    await emitOpen(a);
    const asked = await until(async () => (await dialogsUp()).length > 0, 1500);
    if (asked) await clickBtn('丢弃');
    await sleep(3300);
    await slowWrites(0);
    const o = { asked, t1: await title(), tx1: await text(), d1: disk(a), to1: await toasts() };
    await typeEnd('more');
    await save();
    await sleep(1500);
    o.d2 = disk(a); o.t2 = await title(); o.to2 = await toasts(); o.dlg2 = await dialogsUp();
    console.log('OBS reopen-same-during-save', JSON.stringify(o));
    check('reopen-same-during-save: nothing the user saved is overwritten silently', o.d2.includes('typed') || o.to2.some((t) => /其他程序|外部|冲突|覆盖/.test(t)), JSON.stringify([o.d2, o.to2]));
  },
  // a slow write that FAILS while another document replaced the one saved
  async 'late-failure-during-open'() {
    const a = doc('f1.md', '# F1\n'); const b = doc('f2.md', '# F2\n');
    await openDoc(a, 'F1');
    await slowWrites(2500, true);
    await typeEnd('typed');
    await save();
    await sleep(200);
    await openDoc(b, 'F2');
    await sleep(3200);
    await slowWrites(0);
    const o = { t: await title(), tx: await text(), a: disk(a), b: disk(b), to: await toasts(), btns: await page.evaluate(() => [...document.querySelectorAll('.mdr-toast button')].map((x) => x.textContent.trim())) };
    console.log('OBS late-failure-during-open', JSON.stringify(o));
    check('late-failure-during-open: f2 stays open and clean, f1 unchanged', o.t === 'f2.md' && o.a === '# F1\n' && o.b === '# F2\n', JSON.stringify(o));
  },
  // 另存为 of the untitled buffer (the panel answers a path at once), the write waits, another document opens
  async 'saveas-during-open'() {
    const target = path.join(TMP, 'saved-as.md'); const b = doc('sa2.md', '# SA2\n');
    await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }); }, target);
    await slowWrites(2500);
    await typeEnd('untitled words');
    await page.keyboard.press('Meta+Shift+s');
    await sleep(300);
    await openDoc(b, 'SA2');
    await sleep(3200);
    await slowWrites(0);
    const t1 = await title();
    await typeEnd('more');
    await save();
    await sleep(1500);
    const o = { t1, saved: fs.existsSync(target) ? disk(target) : null, b: disk(b), t2: await title(), to: await toasts() };
    console.log('OBS saveas-during-open', JSON.stringify(o));
    check('saveas-during-open', o.saved === 'untitled words' && o.b === '# SA2\nmore' && o.t1 === 'sa2.md', JSON.stringify(o));
  },
  // the close question's 保存 with a slow write; another document arrives during the write
  async 'close-save-open-during'() {
    const a = doc('c1.md', '# C1\n'); const b = doc('c2.md', '# C2\n');
    await openDoc(a, 'C1');
    await slowWrites(2500);
    await typeEnd('typed');
    await sleep(300);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    const asked = await until(async () => (await dialogsUp()).length > 0, 2500);
    const q = await dialogsUp();
    const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__btn')].map((x) => x.textContent.trim()));
    await app.evaluate(({ app: x }) => { globalThis.__offkWins = []; x.on('browser-window-created', (_e, w) => { globalThis.__offkWins.push('created'); w.on('page-title-updated', (_ev, t) => globalThis.__offkWins.push('title:' + t)); }); });
    await clickBtn('保存');
    await sleep(300);
    await emitOpen(b);
    await sleep(3500);
    await slowWrites(0).catch(() => false);
    await sleep(2500);
    const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle())).catch(() => 'gone');
    const ev = await app.evaluate(() => globalThis.__offkWins).catch(() => 'gone');
    const o = { asked, q, btns, wins, ev, a: disk(a), b: disk(b) };
    if (Array.isArray(wins) && wins.length === 1) {
      try { page = (await app.windows())[0]; o.t = await title(); o.tx = await text(); o.dlg = await dialogsUp(); o.to = await toasts(); } catch (e) { o.pageErr = String(e).split('\n')[0]; }
    }
    console.log('OBS close-save-open-during', JSON.stringify(o));
    check('close-save-open-during: c1 saved, c2 untouched', o.a === '# C1\ntyped' && o.b === '# C2\n', JSON.stringify(o));
  },
};

try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    await launch();
    try { await fn(); } catch (e) { check(name, false, 'threw ' + String(e).split('\n')[0]); }
    await quit();
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`v5-offk-save ${DEV ? 'dev' : DIR.includes('baseline') ? 'base' : 'cand'}: ${checks.filter(Boolean).length} passed, ${checks.filter((x) => !x).length} failed`);
  process.exit(0);
}
