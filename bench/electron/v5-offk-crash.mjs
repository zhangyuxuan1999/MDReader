// bench/electron/v5-offk-crash.mjs — verify-off-desktop (0.2.0 r4 verification): a RENDERER crash
// (webContents.forcefullyCrashRenderer: no macOS dialog) after typing, with the switch OFF; what the window shows
// afterwards and whether the typed text is offered back exactly, per build:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-crash.mjs > x.log
// Cases: named file typed 1.5 s before the crash (draft written) and 0.2 s before (draft maybe not yet written);
// untitled buffer likewise. Launch only through ./_electron.mjs. No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-crash-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
async function curPage() { for (let i = 0; i < 50; i++) { const ws = app.windows(); if (ws.length) { const p = ws[ws.length - 1]; try { await p.waitForSelector('.cm-content', { state: 'attached', timeout: 1000 }); return p; } catch { /* reloading */ } } await sleep(200); } return null; }
const snap = (p) => p.evaluate(() => ({ title: document.title, text: [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'), toasts: [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()), dialogs: [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 60)) }));
async function scenario(name, named, waitMs) {
  const f = path.join(TMP, `${name}.md`); fs.writeFileSync(f, `# ${name}\n`);
  app = await electron.launch({ args: [DIR, ...(named ? [f] : []), `--user-data-dir=${path.join(TMP, 'prof-' + name)}`], timeout: 30000 });
  let page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(' 崩溃前输入');
  await sleep(waitMs);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await sleep(4000);
  const js = (code) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(c), code);
  const SNAP = "({ title: document.title, text: [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\\n'), toasts: [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()), dialogs: [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 60)) })";
  const o = { wins: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), crashed: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isCrashed()) };
  try {
    o.a = await js(SNAP);
    o.clicked = await js("(() => { const t = [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes('草稿')); const b = t && [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复'); if (b) { b.click(); return true; } return false; })()");
    await sleep(800);
    o.restored = o.clicked ? (await js(SNAP)).text : null;
  } catch (e) { o.err = String(e).split('\n')[0].slice(0, 120); }
  o.disk = fs.readFileSync(f, 'utf8');
  await quit();
  out(name, o);
}
try {
  await scenario('named-1500', true, 1500);
  await scenario('named-200', true, 200);
  await scenario('untitled-1500', false, 1500);
  await scenario('untitled-200', false, 200);
} catch (e) {
  console.log('THREW', String(e).split('\n')[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
