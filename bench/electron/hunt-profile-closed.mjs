// hunt:profile — the confirmed window-closed scenario, run on a COPY of the user's profile with the user's
// own recent documents: open doc A with the window open; close the window (app stays alive, as after the
// red button / Cmd-W); 'open-file' doc B (what Finder's double-click does); measure the new window; then
// 'open-file' doc B again into that window. Numbers and paths only, never document contents.
// Usage: MDR_PROFILE=<profile copy> MDR_DOC_A=<path> MDR_DOC_B=<path> [MDR_EXE=...]
//        node bench/electron/hunt-profile-closed.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const exe = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const prof = process.env.MDR_PROFILE;
const docA = process.env.MDR_DOC_A, docB = process.env.MDR_DOC_B;
const realProfile = path.join(os.homedir(), 'Library/Application Support/MDReader');
if (!prof || !fs.existsSync(prof) || !docA || !docB) { console.error('MDR_PROFILE (a copy), MDR_DOC_A, MDR_DOC_B required'); process.exit(2); }
if (path.resolve(prof) === path.resolve(realProfile)) { console.error('refusing to use the real profile'); process.exit(2); }
const charsLF = (p) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p)).replace(/\r\n?/g, '\n').length; } catch { return null; } };

const out = { exe, profile: prof, docA: { path: docA, charsLF: charsLF(docA) }, docB: { path: docB, charsLF: charsLF(docB) }, errors: [] };
const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${prof}`], timeout: 30000 });
const timer = setTimeout(() => { console.log(JSON.stringify({ TIMEOUT: true, ...out }, null, 1)); app.process()?.kill('SIGKILL'); process.exit(3); }, 100000);
const watch = (w, tag) => {
  w.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') out.errors.push(`${tag} ${m.type()}: ${m.text().slice(0, 200)}`); });
  w.on('pageerror', (e) => out.errors.push(`${tag} pageerror: ${String(e).slice(0, 200)}`));
};
const measure = (w) => w.evaluate(() => {
  const cm = document.querySelector('.cm-content');
  const view = cm?.cmView?.rootView?.view ?? cm?.cmTile?.root?.view ?? null;
  return {
    title: document.title, docLen: view?.state?.doc?.length ?? null, cmTextLen: (cm?.textContent ?? '').length,
    previewTextLen: (document.querySelector('.mdr-preview__body')?.textContent ?? '').length,
    mode: localStorage.getItem('mdr.mode'),
    toasts: [...document.querySelectorAll('.mdr-toast__text')].map((x) => x.textContent.slice(0, 80)),
    status: (document.querySelector('.mdr-statusbar')?.textContent ?? '').replace(/\s+/g, ' ').replace(/[^\s]*\.md/g, '<name>.md').slice(0, 100),
  };
});
const emitOpen = (p) => app.evaluate(({ app }, p) => { app.emit('open-file', { preventDefault() {} }, p); }, p);
try {
  out.pid = app.process().pid;
  const w1 = await app.firstWindow(); watch(w1, 'w1');
  await w1.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await w1.waitForTimeout(800);
  await emitOpen(docA);
  await w1.waitForFunction((b) => document.title.includes(b), path.basename(docA), { timeout: 6000 }).catch(() => {});
  await w1.waitForTimeout(800);
  out.A_windowOpen = await measure(w1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 1000));
  out.windowsAfterClose = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const winP = app.waitForEvent('window', { timeout: 15000 });
  await emitOpen(docB);
  const w2 = await winP; watch(w2, 'w2');
  await w2.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await w2.waitForTimeout(2500);
  out.B_afterWindowClosed = await measure(w2);
  out.B_bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
  out.B_EMPTY = out.B_afterWindowClosed.docLen === 0;
  await emitOpen(docB);
  await w2.waitForFunction((b) => document.title.includes(b), path.basename(docB), { timeout: 6000 }).catch(() => {});
  await w2.waitForTimeout(1500);
  out.C_secondDoubleClick = await measure(w2);
} catch (e) {
  out.fatal = String(e).slice(0, 400);
} finally {
  clearTimeout(timer);
  console.log(JSON.stringify(out, null, 1));
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  try { app.process()?.kill('SIGKILL'); } catch {}
}
