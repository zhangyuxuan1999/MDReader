// bench/electron/verify-hotfix-review-r2.mjs — adversarial review (verify:review#2) of the 0.1.1 hotfix
// main process. Isolated profile, documents delivered with app.emit('open-file'), app.addRecentDocument
// stubbed (keeps temp paths out of the macOS recents list). Prints one JSON line per case.
//
//   MDR_EXE=/Users/zyx/LocalDocuments/MDReader/release/hotfix/MDReader.app/Contents/MacOS/MDReader \
//     node bench/electron/verify-hotfix-review-r2.mjs [T1 T2 T3 ...]
//   MDR_APP_DIR=/path/to/unpacked-app node bench/electron/verify-hotfix-review-r2.mjs [...]   (project's electron)
//
// T1  dirty-close dialog + open-file + 不保存 → new window; the new window must still guard a dirty close
// T2  menu 打开… chosen in the same tick as the window's close → the new window must run 打开…
// T3  a relative link in the preview (`[x](other.md)`) must not navigate the window away from the doc;
//     after it, open-file must still show the next document
// T4  valid UTF-8 Markdown with sparse NUL bytes must open as UTF-8 text (0.1.0 did)
// T5  window closed, then open-file A, B, A within 60 ms: the last request (A) must be on screen
// T6  quit dialog (dirty) up, renderer crashes, then open-file: the file must be shown (or the app quit)
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE || '/Users/zyx/LocalDocuments/MDReader/release/hotfix/MDReader.app/Contents/MacOS/MDReader';
// MDR_APP_DIR=/path/to/unpacked-app runs the project's electron on that app directory instead of MDR_EXE.
const APP_DIR = process.env.MDR_APP_DIR || '';
const only = process.argv.slice(2);
const want = (t) => only.length === 0 || only.includes(t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-rev2-')));
const errors = [];
let app = null;
let pid = null;
let prof = null;

const globalTimer = setTimeout(async () => {
  console.log(JSON.stringify({ case: 'GLOBAL', timeout: true }));
  await cleanup();
  process.exit(2);
}, Number(process.env.MDR_TIMEOUT_MS || 100000));

function makeDoc(tag, extra = '') {
  const name = `rev2-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  const marker = `marker-${tag}`;
  fs.writeFileSync(file, `# ${h1}\n\n${marker}\n\n${extra}`, 'utf8');
  return { file, name, h1, marker };
}

async function launch() {
  prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-rev2-'));
  app = await electron.launch(APP_DIR
    ? { args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 }
    : { executablePath: EXE, args: [`--user-data-dir=${prof}`], timeout: 30000 });
  pid = app.process()?.pid;
  app.on('window', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e && e.message).slice(0, 160)}`));
  });
  await app.evaluate(({ app: a, BrowserWindow }) => {
    a.addRecentDocument = () => {};
    globalThis.__sent = [];
    globalThis.__mainErr = [];
    process.on('uncaughtException', (e) => globalThis.__mainErr.push(String(e && e.message)));
    const hook = (w) => {
      const wc = w.webContents;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => { globalThis.__sent.push({ win: w.id, ch, arg: rest[0] }); return orig(ch, ...rest); };
    };
    for (const w of BrowserWindow.getAllWindows()) hook(w);
    a.on('browser-window-created', (_e, w) => hook(w));
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  return page;
}

async function cleanup() {
  if (app) {
    try { await app.evaluate(({ app: a }) => a.exit(0)); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  }
  if (pid) {
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { break; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
  app = null; pid = null;
  if (prof) fs.rmSync(prof, { recursive: true, force: true });
  prof = null;
}

const emitOpen = (p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
const nWin = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const execMain = (js) => app.evaluate(({ BrowserWindow }, code) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w || w.webContents.isLoading() || w.webContents.isCrashed()) return null;
  return Promise.race([
    w.webContents.executeJavaScript(code).catch((e) => ({ err: String(e && e.message) })),
    new Promise((r) => setTimeout(() => r(null), 1500)),
  ]);
}, js);
const state = () => execMain(`({ href: location.href, title: document.title,
  editor: (document.querySelector('.cm-content')?.textContent ?? '').length,
  h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
  buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()),
  body: (document.body?.innerText ?? '').slice(0, 40) })`);
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  let s = null;
  while (Date.now() < end) {
    s = await state().catch(() => null);
    const n = await nWin().catch(() => -1);
    if (pred(s, n)) return { ok: true, s, n };
    await sleep(150);
  }
  return { ok: false, s, n: await nWin().catch(() => -1) };
}
const clickBtn = (label) => execMain(`(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')]
  .find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
const livePage = () => app.windows().filter((x) => !x.isClosed()).at(-1);
async function makeDirty(text) {
  const pg = livePage();
  await pg.click('.cm-content');
  await pg.keyboard.press('Meta+End');
  await pg.keyboard.type(text, { delay: 5 });
  await pg.waitForFunction(() => document.title.startsWith('●'), null, { timeout: 4000 }).catch(() => {});
  await sleep(400);
}
const shows = (doc) => (s, n) => n === 1 && s && s.title?.includes(doc.name) && s.h1 === doc.h1;
const report = (o) => console.log(JSON.stringify(o));

async function T1() {
  await launch();
  const a = makeDoc('t1-a'); const b = makeDoc('t1-b');
  await emitOpen(a.file);
  const sa = await waitFor(shows(a));
  await makeDirty('DIRTY-A');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const dlg = await waitFor((s) => (s?.buttons || []).includes('不保存'));
  await emitOpen(b.file);
  await sleep(500);
  const discard = await clickBtn('不保存');
  const sb = await waitFor(shows(b), 12000);
  // the NEW window: make it dirty, then close — the 保存/不保存/取消 dialog must come up
  await makeDirty('DIRTY-B');
  const dirtyTitle = (await state())?.title;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.close());
  const guard = await waitFor((s, n) => n === 1 && (s?.buttons || []).includes('不保存'), 5000);
  const mainErr = await app.evaluate(() => globalThis.__mainErr.slice()).catch(() => ['app gone']);
  report({ case: 'T1', pass: sa.ok && dlg.ok && discard && sb.ok && guard.ok, aShown: sa.ok, closeDialog: dlg.ok, discard,
    bShownInNewWindow: sb.ok, dirtyTitle: dirtyTitle?.startsWith('●'), guardOnSecondWindow: guard.ok, windowsAfter: guard.n, mainErr });
  if (guard.ok) await clickBtn('不保存');
  await cleanup();
}

async function T2() {
  await launch();
  const pick = makeDoc('t2-picked');
  await app.evaluate(({ dialog }, fp) => {
    globalThis.__openDialogCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.__openDialogCalls++; return { canceled: false, filePaths: [fp] }; };
  }, pick.file);
  if (process.env.MDR_DEBUG) report({ step: 'T2 stubbed' });
  // close (clean document) and pick 打开… from the menu in the same tick: 'close' has gone through
  // (closingWindow), 'closed' has not fired yet
  const r = await app.evaluate(({ BrowserWindow, Menu }) => {
    const w = BrowserWindow.getAllWindows()[0];
    let closeFired = false;
    w.once('close', () => { closeFired = true; });
    w.close();
    const item = Menu.getApplicationMenu().getMenuItemById('file.open');
    item.click();
    return { closeFired, hadItem: !!item, destroyedNow: w.isDestroyed() };
  });
  if (process.env.MDR_DEBUG) report({ step: 'T2 after same-tick', r });
  const s = await waitFor(shows(pick), 10000);
  const calls = await app.evaluate(() => globalThis.__openDialogCalls).catch(() => -1);
  report({ case: 'T2', pass: s.ok && calls === 1, sameTick: r, newWindows: s.n, openDialogCalls: calls,
    shownPicked: s.ok, state: s.s ? { title: s.s.title, editor: s.s.editor } : null });
  await cleanup();
}

async function T3() {
  const page = await launch();
  const a = makeDoc('t3-a', '[相对链接](other.md)\n');
  const b = makeDoc('t3-b');
  await emitOpen(a.file);
  const sa = await waitFor(shows(a));
  const before = await state();
  const pg = livePage();
  let clickErr = null;
  try { await pg.click('.mdr-preview__body a', { timeout: 5000 }); } catch (e) { clickErr = String(e.message).slice(0, 120); }
  await sleep(1500);
  const after = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    return w ? { url: w.webContents.getURL(), title: w.getTitle() } : null;
  });
  const navigatedAway = !!after && !after.url.endsWith('/index.html') && after.url !== before?.href;
  await emitOpen(b.file);
  const sb = await waitFor(shows(b), 8000);
  const sentB = await app.evaluate((_m, f) => globalThis.__sent.filter((x) => x.ch === 'mdr:open-file' && x.arg === f).length, b.file);
  report({ case: 'T3', pass: sa.ok && !navigatedAway && sb.ok, aShown: sa.ok, before: before?.href, clickErr, after,
    navigatedAway, nextOpenShown: sb.ok, nextOpenSends: sentB, nextState: sb.s ? { href: sb.s.href, title: sb.s.title, body: sb.s.body } : null });
  void page;
  await cleanup();
}

async function T4() {
  await launch();
  // valid UTF-8 (pure ASCII Markdown) with a NUL byte after every 20th character, even length
  const name = 'rev2-t4-nul.md';
  const file = path.join(TMP, name);
  const base = '# Title\n\nThis is a perfectly normal paragraph of english text written in markdown, with some words.\n';
  let s = ''; let i = 0;
  for (const ch of base.repeat(20)) { s += ch; if (++i % 20 === 0) s += '\u0000'; }
  let buf = Buffer.from(s, 'utf8');
  if (buf.length % 2) buf = Buffer.concat([buf, Buffer.from('\n')]);
  fs.writeFileSync(file, buf);
  await emitOpen(file);
  const r = await waitFor((st, n) => n === 1 && st && st.title?.includes(name), 8000);
  const ed = await execMain(`(document.querySelector('.cm-content')?.textContent ?? '')`);
  // CodeMirror shows each NUL as a special-character widget: keep printable ASCII only
  const asText = typeof ed === 'string' && ed.replace(/[^\x20-\x7e]/g, '').includes('perfectly normal');
  const toast = await execMain(`[...document.querySelectorAll('.mdr-toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 2)`);
  // edit one character at the end and save (⌘S): what lands on disk?
  let savedAscii = null; let savedBytes = null;
  if (r.ok) {
    const pg = livePage();
    await pg.click('.cm-content');
    await pg.keyboard.press('Meta+End');
    await pg.keyboard.type('x', { delay: 5 });
    await sleep(300);
    await pg.keyboard.press('Meta+s');
    const end = Date.now() + 5000;
    while (Date.now() < end && fs.readFileSync(file).equals(buf)) await sleep(150);
    const after = fs.readFileSync(file);
    savedBytes = after.length;
    savedAscii = after.toString('utf8').replace(/\u0000/g, '').includes('perfectly normal');
  }
  report({ case: 'T4', pass: r.ok && asText, bytes: buf.length, opened: r.ok, title: r.s?.title, editorHasAsciiText: asText,
    editorHead: typeof ed === 'string' ? JSON.stringify(ed.slice(0, 10)) : null, toast, savedBytes, savedFileStillHasAsciiWords: savedAscii });
  await cleanup();
}

async function T5() {
  await launch();
  const a = makeDoc('t5-a'); const b = makeDoc('t5-b');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const end = Date.now() + 6000;
  while (Date.now() < end && (await nWin()) !== 0) await sleep(100);
  await sleep(300);
  // the window is closed (app in the Dock): double-click A, then B, then A again while the new
  // window is still loading — the last request is A
  await app.evaluate(({ app: x }, [fa, fb]) => {
    x.emit('open-file', { preventDefault() {} }, fa);
    setTimeout(() => x.emit('open-file', { preventDefault() {} }, fb), 30);
    setTimeout(() => x.emit('open-file', { preventDefault() {} }, fa), 60);
  }, [a.file, b.file]);
  await sleep(500);
  const shownA = await waitFor(shows(a), 9000);
  const sends = await app.evaluate(() => globalThis.__sent.filter((x) => x.ch === 'mdr:open-file').map((x) => x.arg.split('/').pop()));
  report({ case: 'T5', pass: shownA.ok, lastRequested: a.name, shown: shownA.s?.title, sends, windows: shownA.n });
  await cleanup();
}

async function T6() {
  await launch();
  const a = makeDoc('t6-a'); const b = makeDoc('t6-b');
  await emitOpen(a.file);
  await waitFor(shows(a));
  await makeDirty('DIRTY-T6');
  // ⌘Q with unsaved changes: before-quit is prevented and the renderer shows 保存 / 不保存 / 取消
  await app.evaluate(({ app: x }) => { setTimeout(() => x.quit(), 0); });
  const dlg = await waitFor((st) => (st?.buttons || []).includes('不保存'), 6000);
  // the renderer dies while that quit dialog is up
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  await sleep(1500);
  await emitOpen(b.file);
  const shownB = await waitFor(shows(b), 8000);
  const after = await app.evaluate(({ BrowserWindow }, fb) => {
    const ws = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    return { windows: ws.length, crashed: ws.map((w) => w.webContents.isCrashed()), url: ws.map((w) => w.webContents.getURL()),
      sentB: globalThis.__sent.filter((x) => x.ch === 'mdr:open-file' && x.arg === fb).length };
  }, b.file).catch((e) => ({ appGone: String(e.message).slice(0, 80) }));
  report({ case: 'T6', pass: shownB.ok || !!after.appGone, quitDialog: dlg.ok, bShown: shownB.ok, after });
  await cleanup();
}

try {
  for (const [n, f] of [['T1', T1], ['T2', T2], ['T3', T3], ['T4', T4], ['T5', T5], ['T6', T6]]) {
    if (!want(n)) continue;
    try { await f(); } catch (e) { report({ case: n, error: String(e && e.stack || e).slice(0, 400) }); await cleanup(); }
  }
} finally {
  await cleanup();
  clearTimeout(globalTimer);
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ case: 'ERRORS', consoleAndPageErrors: errors });
}
