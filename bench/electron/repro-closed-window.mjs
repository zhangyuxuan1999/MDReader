// Repro: installed MDReader.app, isolated profile. A) open-file with the window open; B) close the window
// (app stays alive, macOS convention), then open-file again — the same handler Finder's double-click hits.
//   MDR_EXE=/path/to/MDReader.app/Contents/MacOS/MDReader node bench/electron/repro-closed-window.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
//   MDR_APP_DIR=/path/to/unpacked-app node bench/electron/repro-closed-window.mjs   (project's electron; integrator, round 3)
// With neither set the script refuses: it must never launch the user's installed app by default.
const exe = process.env.MDR_EXE || '';
const APP_DIR = process.env.MDR_APP_DIR || '';
if (!exe && !APP_DIR) { console.error('set MDR_EXE (packaged executable) or MDR_APP_DIR (unpacked app directory)'); process.exit(64); }
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-'));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-repro-')));
const file = path.join(dir, 'mdr-nonempty.md');
fs.writeFileSync(file, '# 非空文件\n\n这里有内容，不应该显示为空。\n');
const errors = [];
const watch = (p, label) => {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text().slice(0, 200)}`); });
  p.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${String(e && e.message).slice(0, 200)}`));
};
const cleanup = () => { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); };
const app = await electron.launch(exe ? { executablePath: exe, args: [`--user-data-dir=${prof}`] } : { args: [APP_DIR, `--user-data-dir=${prof}`] });
const pid = app.process()?.pid;
const quit = async () => {
  await Promise.race([app.evaluate(({ app }) => app.exit(0)).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (pid) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
};
const timer = setTimeout(async () => { console.log('TIMEOUT'); await quit(); cleanup(); process.exit(2); }, 60000);
let code = 0;
try {
  // Keep the macOS recent-documents list (keyed by bundle id, not by profile) untouched.
  await app.evaluate(({ app }) => { app.addRecentDocument = () => {}; });
  let n = 0;
  app.on('window', (p) => watch(p, `w${++n}`));
  const snap = (w) => w.evaluate(() => ({ title: document.title, editor: (document.querySelector('.cm-content')?.textContent ?? '').slice(0, 30), previewH1: document.querySelector('.mdr-preview__body h1')?.textContent ?? null, status: (document.querySelector('.mdr-statusbar')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80) }));
  const emitOpen = (p) => app.evaluate(({ app }, p) => { app.emit('open-file', { preventDefault() {} }, p); }, p);
  const w1 = await app.firstWindow();
  if (n === 0) watch(w1, 'w1');
  await w1.waitForSelector('.cm-content', { timeout: 20000 });
  await w1.waitForTimeout(500);
  await emitOpen(file);
  await w1.waitForFunction(() => document.title.includes('mdr-nonempty')
    && !!document.querySelector('.mdr-preview__body h1'), null, { timeout: 6000 }).catch(() => {});
  const A = await snap(w1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 1000));
  const windowsAfterClose = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const winP = app.waitForEvent('window', { timeout: 15000 });
  await emitOpen(file);
  const w2 = await winP;
  await w2.waitForSelector('.cm-content', { timeout: 20000 });
  await w2.waitForTimeout(2500);
  const B = await snap(w2);
  const ok = (s) => s.title.includes('mdr-nonempty') && !s.title.includes('未命名') && s.previewH1 === '非空文件';
  console.log(JSON.stringify({ exe, A_windowOpen: A, windowsAfterClose, B_afterWindowClosed: B, errors }, null, 1));
  console.log(`A ${ok(A) ? 'SHOWS FILE' : 'WRONG'}; B ${ok(B) ? 'SHOWS FILE' : 'WRONG (empty/untitled)'}; console/page errors: ${errors.length}`);
  code = ok(A) && ok(B) ? 0 : 1;
} catch (e) {
  console.log(`ERROR ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`);
  code = 1;
} finally {
  clearTimeout(timer);
  await quit();
  cleanup();
}
process.exit(code);
