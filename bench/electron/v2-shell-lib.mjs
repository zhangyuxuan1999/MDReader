// bench/electron/v2-shell-lib.mjs — helpers for the verify-shell (0.2.0 stage 2a) attack scripts.
// Launches the project's Electron on an UNPACKED app directory (MDR_TARGET=staging|baseline, or
// MDR_APP_DIR) through ./_electron.mjs (isolated profile + recent-documents stub). Documents and
// profiles live under MDR_V2_TMP (default: os.tmpdir()). Main-process instrumentation: every
// 'mdr:open-file' / 'mdr:command' sent to any webContents is logged in globalThis.__v2Sent.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const TARGETS = {
  staging: path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */,
  baseline: path.join(ROOT, 'release/baseline-0.1.1.noindex'),
};
export const TARGET = process.env.MDR_TARGET || 'staging';
export const APP_DIR = process.env.MDR_APP_DIR || TARGETS[TARGET];
if (!APP_DIR || !fs.existsSync(APP_DIR)) {
  console.error(`no app dir for MDR_TARGET=${TARGET}`);
  process.exit(64);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE_TMP = fs.realpathSync(process.env.MDR_V2_TMP || os.tmpdir());
export const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE_TMP, 'v2shell-docs-')));
const profiles = [];
const apps = new Set();
export const results = [];

export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

export function makeDoc(tag, dir = TMP, ext = '.md') {
  const name = `v2-${tag}${ext}`;
  const file = path.join(dir, name);
  const h1 = `标题 ${tag}`;
  const marker = `marker-${tag}-正文`;
  fs.writeFileSync(file, `# ${h1}\n\n${marker}\n`, 'utf8');
  return { file, name, h1, marker };
}

export async function launch(label, extraArgs = [], opts = {}) {
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'v2shell-prof-'));
  profiles.push(prof);
  const args = [...(opts.noAppDir ? [] : [APP_DIR]), ...extraArgs, `--user-data-dir=${prof}`];
  const app = await electron.launch({ args, timeout: 30000, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  apps.add(app);
  const pid = app.process()?.pid;
  const errors = [];
  app.on('window', (p) => {
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${String(e && e.message).slice(0, 200)}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  });
  await app.evaluate(({ app: a, BrowserWindow, dialog }) => {
    globalThis.__v2Sent = [];
    globalThis.__v2Boxes = [];
    const wrap = (w) => {
      const wc = w.webContents;
      if (wc.__v2) return;
      wc.__v2 = true;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => {
        if (ch === 'mdr:open-file' || ch === 'mdr:command') globalThis.__v2Sent.push({ t: Date.now(), win: w.id, ch, arg: rest[0], url: wc.getURL(), loading: wc.isLoading() });
        return orig(ch, ...rest);
      };
    };
    for (const w of BrowserWindow.getAllWindows()) wrap(w);
    a.on('browser-window-created', (_e, w) => wrap(w));
    const box = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...xs) => {
      const o = xs.find((x) => x && typeof x === 'object' && 'message' in x);
      globalThis.__v2Boxes.push(o ? o.message : '?');
      return box(...xs);
    };
  });
  return { app, pid, prof, errors, label };
}

export async function hardQuit(ctx) {
  if (!ctx) return;
  const { app, pid } = ctx;
  apps.delete(app);
  try { await Promise.race([app.evaluate(({ app: a }) => { a.exit(0); }), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) {
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}

export const emitOpen = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
export const sent = (app) => app.evaluate(() => globalThis.__v2Sent.slice());
export const openSends = async (app, file) => (await sent(app)).filter((x) => x.ch === 'mdr:open-file' && x.arg === file);
export const windowsInfo = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  .map((w) => ({ id: w.id, visible: w.isVisible(), minimized: w.isMinimized(), crashed: w.webContents.isCrashed(), loading: w.webContents.isLoading(), url: w.webContents.getURL() })));

export async function waitWindows(app, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let ws = [];
  while (Date.now() < deadline) {
    ws = await windowsInfo(app).catch(() => ws);
    if (ws.length === n) return ws;
    await sleep(100);
  }
  return ws;
}

export const mainSnap = (app) => app.evaluate(async ({ BrowserWindow }) => {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const w = wins[0];
  if (!w) return { windows: 0 };
  if (w.webContents.isCrashed()) return { windows: wins.length, crashed: true };
  try {
    const r = await Promise.race([new Promise((_res, rej) => setTimeout(() => rej(new Error('executeJavaScript timeout')), 2000)),
      w.webContents.executeJavaScript(`({
      title: document.title,
      editor: document.querySelector('.cm-content')?.textContent ?? '',
      h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
      toasts: [...document.querySelectorAll('.mdr-toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 3),
      buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()),
      bridge: typeof window.mdrNative,
    })`)]);
    return { windows: wins.length, ...r };
  } catch (e) {
    return { windows: wins.length, error: String(e && e.message), url: w.webContents.getURL() };
  }
});
export const describe = (s) => (s ? `windows=${s.windows} title=${JSON.stringify(s.title ?? null)} editorLen=${s.editor?.length ?? '-'} h1=${JSON.stringify(s.h1 ?? null)}${s.crashed ? ' crashed' : ''}${s.error ? ` err=${s.error}` : ''}${s.toasts?.length ? ` toasts=${JSON.stringify(s.toasts)}` : ''}${s.buttons?.length ? ` buttons=${JSON.stringify(s.buttons)}` : ''}` : 'no snapshot');

export async function waitMain(app, pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < deadline) {
    s = await mainSnap(app).catch(() => s);
    if (s && pred(s)) return { ok: true, s };
    await sleep(150);
  }
  return { ok: false, s };
}
export const showsPred = (doc) => (s) => s.windows === 1 && !!s.title?.includes(doc.name) && !!s.editor?.includes(doc.marker) && s.h1 === doc.h1;
export const mainShows = (app, doc, timeoutMs = 12000) => waitMain(app, showsPred(doc), timeoutMs);

export const execMain = (app, js) => app.evaluate(({ BrowserWindow }, code) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  return w ? Promise.race([w.webContents.executeJavaScript(code), new Promise((r) => setTimeout(() => r('__timeout'), 3000))]) : null;
}, js);
export const clickBtn = (app, label) => execMain(app, `(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')]
  .find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);

/** Types into the CodeMirror editor of the live window (makes the document dirty). */
export async function makeDirty(app, text) {
  const pg = app.windows().filter((x) => !x.isClosed()).at(-1);
  await pg.click('.cm-content', { timeout: 5000 });
  await pg.keyboard.press('Meta+End');
  await pg.keyboard.type(text, { delay: 5 });
  await pg.waitForFunction(() => document.title.startsWith('●'), null, { timeout: 4000 }).catch(() => {});
  await sleep(300);
}

/** Ready: the first window shows the editor. */
export async function firstReady(app) {
  const page = await app.firstWindow({ timeout: 20000 });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(400);
  return page;
}

export const menuClick = (app, id) => app.evaluate(({ Menu }, i) => { const it = Menu.getApplicationMenu()?.getMenuItemById(i); if (!it) return false; it.click(); return true; }, id);

export function watchdog(ms, label = 'v2-shell') {
  const t = setTimeout(async () => {
    console.log(`FAIL ${label}: global timeout after ${ms} ms`);
    await cleanup();
    process.exit(2);
  }, ms);
  t.unref?.();
  return t;
}

export async function cleanup() {
  for (const a of [...apps]) {
    try { a.process().kill('SIGKILL'); } catch { /* gone */ }
  }
  apps.clear();
  await sleep(300);
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[${TARGET}] ${results.length - failed.length}/${results.length} PASS`);
  for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
  return failed.length;
}
