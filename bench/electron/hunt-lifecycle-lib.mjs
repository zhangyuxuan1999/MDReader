// bench/electron/hunt-lifecycle-lib.mjs — shared helpers for the hunt-lifecycle-*.mjs scripts
// (finder "hunt:lifecycle", 2026-11-20). Launches MDReader with an ISOLATED profile (fresh mktemp
// --user-data-dir), never the user's real one, and drives the main process through Playwright.
//   MDR_EXE=/path/to/MDReader  selects another executable (default: the installed app).
// Prints only lengths / counts / titles of the synthetic test documents it writes itself.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXE = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpRoots = [];
export function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpRoots.push(d);
  return d;
}
export function cleanupTmp() {
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** A synthetic non-empty document: `n` headings + paragraphs. Returns {path, length, blocks}. */
export function writeDoc(dir, name, n = 3) {
  let text = '';
  for (let i = 1; i <= n; i++) text += `# 标题 ${name} ${i}\n\n段落 ${i}：这里有内容，不应该显示为空。\n\n`;
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return { path: p, length: text.length, blocks: n * 2, name };
}

const launched = new Set();
/** Launch with an isolated profile. `profile` reuses an existing temp profile dir. */
export async function launch({ args = [], profile, cwd } = {}) {
  const prof = profile || tmpDir('mdr-hunt-prof-');
  const logs = [];
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`, ...args], cwd, timeout: 30000 });
  launched.add(app);
  // Keep the synthetic paths out of the macOS recent-documents list (keyed by bundle id, not profile).
  await app.evaluate(({ app: a }) => { a.addRecentDocument = () => {}; }).catch(() => {});
  const proc = app.process();
  proc.stdout?.on('data', (d) => logs.push(`[main-out] ${String(d).trim()}`.slice(0, 300)));
  proc.stderr?.on('data', (d) => { const s = String(d).trim(); if (/error|exception|fatal/i.test(s)) logs.push(`[main-err] ${s}`.slice(0, 300)); });
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300)); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`.slice(0, 300)));
    page.on('crash', () => errors.push('page crash'));
  };
  app.on('window', watch);
  for (const w of app.windows()) watch(w);
  return { app, prof, errors, logs, pid: proc.pid };
}

export async function closeApp(app) {
  try {
    await Promise.race([app.evaluate(({ app: a }) => { setTimeout(() => a.exit(0), 10); }).catch(() => {}), sleep(3000)]);
    await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  } finally {
    try { app.process().kill('SIGKILL'); } catch { /* gone */ }
    launched.delete(app);
  }
}
export async function closeAll() { for (const a of [...launched]) await closeApp(a); }

export const emitOpen = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
export const winCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
export const mainState = (app) => app.evaluate(({ app: a, BrowserWindow }) => {
  const ws = BrowserWindow.getAllWindows();
  return {
    windows: ws.length,
    visible: ws.filter((w) => w.isVisible()).length,
    minimized: ws.filter((w) => w.isMinimized()).length,
    hidden: process.platform === 'darwin' ? a.isHidden() : null,
    crashed: ws.filter((w) => w.webContents.isCrashed()).length,
  };
});

/** Renderer snapshot (no document content: lengths and counts only). */
export async function snap(page, expect) {
  return page.evaluate((exp) => {
    const cm = document.querySelector('.cm-content');
    let len = null;
    try { len = cm?.cmView?.view?.state?.doc?.length ?? null; } catch { len = null; }
    const txt = cm?.textContent ?? '';
    const body = document.querySelector('.mdr-preview__body');
    const dialogs = [...document.querySelectorAll('.mdr-dialog')].map((d) => [...d.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()).join('/'));
    const toasts = [...document.querySelectorAll('.mdr-toast')].map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40));
    const docText = cm?.cmView?.view?.state?.doc?.toString?.() ?? txt;
    const st = (document.querySelector('.mdr-statusbar')?.textContent ?? '').replace(/\s+/g, ' ');
    const m = /字符\s*(\d+)/.exec(st);
    return {
      title: document.title,
      editorChars: m ? Number(m[1]) : null,
      editorTextLen: len ?? txt.length,
      previewBlocks: body ? body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,table,blockquote,ul,ol,hr').length : null,
      previewTextLen: body ? (body.textContent || '').length : null,
      previewH1: body ? body.querySelectorAll('h1').length : null,
      matchesExpected: exp ? exp.marker ? docText.includes(exp.marker) : null : null,
      dialogs,
      toasts,
      status: (document.querySelector('.mdr-statusbar')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    };
  }, expect || null).catch((e) => ({ error: String(e).slice(0, 200) }));
}

/** First window that has finished booting the editor. */
export async function readyWindow(app, timeout = 20000) {
  const w = app.windows()[0] || (await app.waitForEvent('window', { timeout }));
  await w.waitForSelector('.cm-content', { timeout });
  return w;
}

/** Window currently alive (last created). */
export async function liveWindow(app, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ws = app.windows().filter((w) => !w.isClosed());
    if (ws.length) return ws[ws.length - 1];
    await sleep(100);
  }
  return null;
}

export async function waitTitle(page, frag, timeout = 6000) {
  return page.waitForFunction((f) => document.title.includes(f), frag, { timeout }).then(() => true).catch(() => false);
}

/** Global watchdog: kills everything and exits if a script runs too long. */
export function watchdog(ms = 100000) {
  const t = setTimeout(async () => {
    console.log(JSON.stringify({ watchdog: 'TIMEOUT', ms }));
    for (const a of [...launched]) { try { a.process().kill('SIGKILL'); } catch { /* gone */ } }
    cleanupTmp();
    process.exit(2);
  }, ms);
  t.unref?.();
  return t;
}

export async function typeInEditor(page, text) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(text, { delay: 5 });
  await sleep(200);
}
export async function clickDialog(page, label) {
  return page.evaluate((l) => {
    const bs = [...document.querySelectorAll('.mdr-dialog__btn')].filter((x) => x.textContent.trim() === l);
    const b = bs[bs.length - 1];
    if (!b) return false;
    b.click();
    return true;
  }, label);
}

/** Record every 'mdr:open-file' the main process sends to any renderer (paths' basenames only). */
export const instrumentSends = (app) => app.evaluate(({ webContents }) => {
  const any = webContents.getAllWebContents()[0];
  const proto = Object.getPrototypeOf(any);
  if (proto.__huntWrapped) return true;
  const orig = proto.send;
  globalThis.__huntSends = [];
  proto.send = function (ch, ...args) {
    if (ch === 'mdr:open-file' || ch === 'mdr:command') {
      globalThis.__huntSends.push({ ch, arg: ch === 'mdr:open-file' ? String(args[0]).split('/').pop() : args[0], wc: this.id, destroyed: this.isDestroyed(), crashed: this.isCrashed(), loading: this.isLoading(), t: Date.now() });
    }
    return orig.call(this, ch, ...args);
  };
  proto.__huntWrapped = true;
  return true;
});
export const sends = (app) => app.evaluate(() => globalThis.__huntSends || []);
