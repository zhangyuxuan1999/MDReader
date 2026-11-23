// bench/electron/fixF-guards.mjs — fixer-F, fix round 0.2.0: the renderer's open / discard / close flows
// end to end against the tree's Electron shell in dev mode (CONTRACT §11 "Fix-round decisions" R1–R3;
// findings F4 / F4b / F7 in docs/open-empty/lifecycle.md, the open-failure finding in docs/open-empty/files.md).
//
//   MDR_PORT=5277 node bench/electron/fixF-guards.mjs            # own Vite on MDR_PORT (default 5277)
//   MDR_BASE=http://localhost:5276 node bench/electron/fixF-guards.mjs   # an already running renderer
//                                                                # (e.g. the OLD renderer, to see it fail)
//   node bench/electron/fixF-guards.mjs F1 F4                    # only some scenarios
//
// Every launch goes through ./_electron.mjs (isolated profile, recent-documents stub). Documents are
// delivered with app.emit('open-file'). Global timeout 300 s; everything started is stopped in finally.
import { electron } from './_electron.mjs';
import { execSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.MDR_PORT || 5277);
const BASE = process.env.MDR_BASE || `http://localhost:${PORT}`;
const OWN_SERVER = !process.env.MDR_BASE;
const ONLY = process.argv.slice(2);
const GLOBAL_TIMEOUT_MS = 300_000;

const T = {
  discardQ: '当前文档尚未保存，是否放弃更改？',
  discard: '丢弃',
  cancel: '取消',
  dontSave: '不保存',
  draftFound: '发现未保存的草稿，是否恢复？',
};

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  if (cond) { pass++; console.log(`  ok   ${line}`); } else { failures.push(line); console.log(`  FAIL ${line}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing */ }
}
async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function until(page, fn, arg, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}
async function untilMain(app, fn, arg, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await app.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => {
  const item = Menu.getApplicationMenu().getMenuItemById(mid);
  if (!item) return false;
  item.click();
  return true;
}, id);
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const dialogTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const editorText = (page) => page.evaluate(() => window.__mdr.app.getText());
const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
async function clickDialogButton(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`dialog button 「${label}」 not found (dialogs: ${JSON.stringify(await dialogTexts(page).catch(() => []))})`);
}
/** Records the largest number of dialogs ever on screen at once (two = a stacked modal). */
const watchDialogs = (page) => page.evaluate(() => {
  window.__maxDialogs = document.querySelectorAll('.mdr-dialog').length;
  new MutationObserver(() => {
    window.__maxDialogs = Math.max(window.__maxDialogs, document.querySelectorAll('.mdr-dialog').length);
  }).observe(document.body, { childList: true, subtree: true });
});
const maxDialogs = (page) => page.evaluate(() => window.__maxDialogs);
async function typeInEditor(page, text) {
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type(text, { delay: 5 });
  await sleep(200);
}
/** The draft the worker stored for docId, read without creating the database when it does not exist. */
const storedDraft = (page, docId) => page.evaluate(async (id) => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return null;
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      try {
        const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + id);
        g.onsuccess = () => { res(g.result ? String(g.result.text) : null); db.close(); };
        g.onerror = () => { res(null); db.close(); };
      } catch { res(null); db.close(); }
    };
    r.onerror = () => res(null);
  });
}, docId);

async function hardClose(h) {
  if (!h) return;
  const pid = (() => { try { return h.app.process()?.pid; } catch { return undefined; } })();
  try { await h.app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* already gone */ }
  await Promise.race([h.app.close().catch(() => {}), sleep(5000)]);
  if (pid) {
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}
async function launch(profile) {
  const args = [ROOT];
  if (profile) args.push(`--user-data-dir=${profile}`);
  const app = await electron.launch({ args, env: { ...process.env, MDR_DEV_URL: BASE } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await until(page, () => !!window.__mdr, null, 30000);
  await sleep(600); // past the renderer's launch-settle window (400 ms)
  await watchDialogs(page);
  return { app, page };
}
async function newPage(app, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = app.windows();
    for (const p of ws) {
      if (p.isClosed()) continue;
      const ok = await p.evaluate(() => !!window.__mdr).catch(() => false);
      if (ok) return p;
    }
    await sleep(150);
  }
  throw new Error('no new window came up');
}

const scenarios = {};
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-fixF-'));
const A = path.join(tmp, 'fixf-a.md');
const A_TEXT = '# Alpha\n\nfirst document\n';
const B = path.join(tmp, 'fixf-b.md');
const B_TEXT = '# Beta\n\nsecond document\n';

scenarios.F1 = async () => {
  console.log('[F1] a document that arrives while 新建 asks 取消 / 丢弃 is not dropped');
  let h = await launch();
  try {
    await typeInEditor(h.page, 'typed text');
    await menuClick(h.app, 'file.new');
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await emitOpenFile(h.app, A);
    await sleep(700);
    check('F1a one question on screen while the document waits', (await maxDialogs(h.page)) === 1, `max ${await maxDialogs(h.page)}`);
    await clickDialogButton(h.page, T.discard);
    const got = await until(h.page, (t) => window.__mdr.app.getText() === t, A_TEXT, 6000);
    check('F1a 丢弃 → the double-clicked document is opened afterwards', !!got, `editor ${JSON.stringify((await editorText(h.page)).slice(0, 30))}`);
    check('F1a no second question for the clean untitled document', (await dialogTexts(h.page)).length === 0);
    check('F1a title names it', (await h.page.title()).includes('fixf-a.md'), await h.page.title());
    await hardClose(h);

    h = await launch();
    await typeInEditor(h.page, 'keep me');
    await menuClick(h.app, 'file.new');
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await emitOpenFile(h.app, A);
    await sleep(500);
    await clickDialogButton(h.page, T.cancel);
    const second = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1 && window.__mdr.app.getText() === 'keep me', null, 4000);
    check('F1b 取消 on 新建 keeps the text; the waiting document asks its own question', !!second, `dialogs ${JSON.stringify(await dialogTexts(h.page))}`);
    await clickDialogButton(h.page, T.discard).catch(() => {});
    const gotB = await until(h.page, (t) => window.__mdr.app.getText() === t, A_TEXT, 6000);
    check('F1b … and 丢弃 there opens it', !!gotB);
    check('F1b never two questions at once', (await maxDialogs(h.page)) === 1, `max ${await maxDialogs(h.page)}`);
  } finally {
    await hardClose(h);
  }
};

scenarios.F2 = async () => {
  console.log('[F2] close / quit while the discard question is up waits for its answer');
  let h = await launch();
  try {
    // a: document arrives (question up) → window close → 丢弃: one modal, the window closes.
    await typeInEditor(h.page, 'dirty');
    await emitOpenFile(h.app, A);
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await sleep(700);
    const texts = await dialogTexts(h.page);
    check('F2a the close request does not stack 不保存 / 取消 / 保存 on 取消 / 丢弃', texts.length === 1 && texts[0] === T.discardQ, JSON.stringify(texts));
    await clickDialogButton(h.page, T.discard);
    const closed = await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 6000);
    check('F2a 丢弃 answers the shell: the window closes without a second question', !!closed, `windows ${await windowCount(h.app)}`);
    await hardClose(h);

    // b: same, 取消 on the discard question → the close question follows alone → 取消 keeps everything.
    h = await launch();
    await typeInEditor(h.page, 'dirty');
    await emitOpenFile(h.app, A);
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await sleep(600);
    await clickDialogButton(h.page, T.cancel);
    const closeQ = await until(h.page, () => {
      const t = [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent);
      return t.length === 1 && t[0].includes('有未保存的更改') ? t[0] : null;
    }, null, 4000);
    check('F2b 取消 → the close question comes next, alone', !!closeQ, String(closeQ));
    await clickDialogButton(h.page, T.cancel).catch(() => {});
    await sleep(500);
    check('F2b 取消 there keeps the window and the text', (await windowCount(h.app)) === 1 && (await editorText(h.page)) === 'dirty');
    check('F2b never two questions at once', (await maxDialogs(h.page)) === 1, `max ${await maxDialogs(h.page)}`);
    // The window still closes normally afterwards (the shell was answered exactly once).
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
    await clickDialogButton(h.page, T.dontSave).catch(() => {});
    const closed2 = await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 6000);
    check('F2b a later close request is still answered (不保存 closes)', !!closed2);
    await hardClose(h);

    // c: dirty → open-file + app.quit() 30 ms later → one question → 丢弃 → the app quits.
    h = await launch();
    await typeInEditor(h.page, 'dirty');
    await emitOpenFile(h.app, A);
    await sleep(30);
    const exited = new Promise((r) => h.app.process().once('exit', () => r(true)));
    await h.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); });
    await sleep(800);
    const qTexts = await dialogTexts(h.page).catch(() => []);
    check('F2c open + quit: one question', qTexts.length === 1, JSON.stringify(qTexts));
    check('F2c never two questions at once', (await maxDialogs(h.page).catch(() => 0)) === 1);
    await clickDialogButton(h.page, T.discard).catch(() => {});
    const quit = await Promise.race([exited, sleep(6000).then(() => false)]);
    check('F2c 丢弃 → the quit goes through (the shell got its answer)', quit === true);
  } finally {
    await hardClose(h);
  }
};

scenarios.F3 = async () => {
  console.log('[F3] 不保存 / 丢弃 delete the discarded draft; other drafts survive');
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-fixF-prof-'));
  let h = await launch(profile);
  try {
    // a: 新建 → 丢弃 on a dirty untitled document with a stored draft.
    await typeInEditor(h.page, 'thrown away');
    const stored = await until(h.page, () => window.__mdr && true, null, 100).then(async () => {
      for (let i = 0; i < 30; i++) { const d = await storedDraft(h.page, 'untitled'); if (d) return d; await sleep(150); }
      return null;
    });
    check('F3 precondition: the worker stored the untitled draft', stored === 'thrown away', String(stored));
    await menuClick(h.app, 'file.new');
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await clickDialogButton(h.page, T.discard);
    await sleep(1500);
    const offers = (await toastTexts(h.page)).filter((t) => t.includes(T.draftFound));
    check('F3a 新建 → 丢弃: no 「发现未保存的草稿」 offer for the text just thrown away', offers.length === 0, JSON.stringify(await toastTexts(h.page)));
    check('F3a the untitled draft is gone from IndexedDB', (await storedDraft(h.page, 'untitled')) === null);

    // b: a draft that was NOT discarded survives (取消 on a question keeps it).
    await typeInEditor(h.page, 'keep this');
    let kept = null;
    for (let i = 0; i < 30 && !kept; i++) { kept = await storedDraft(h.page, 'untitled'); await sleep(150); }
    await emitOpenFile(h.app, A);
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await clickDialogButton(h.page, T.cancel);
    await sleep(400);
    check('F3b 取消 keeps the draft (crash recovery)', (await storedDraft(h.page, 'untitled')) === 'keep this');

    // c: 不保存 on the close question → the window closes; the next window offers nothing.
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
    await clickDialogButton(h.page, T.dontSave);
    await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 6000);
    await h.app.evaluate(({ app: a }) => { a.emit('activate', { preventDefault() {} }, false); });
    const p2 = await newPage(h.app);
    await sleep(1500);
    const offers2 = (await toastTexts(p2)).filter((t) => t.includes(T.draftFound));
    check('F3c 不保存 → the next window offers no draft for the discarded text', offers2.length === 0, JSON.stringify(await toastTexts(p2)));
    check('F3c the untitled draft is gone from IndexedDB', (await storedDraft(p2, 'untitled')) === null);
    await hardClose(h);
    h = null;

    // d: a crash-recovery draft (left by a window that was never asked) survives a relaunch.
    h = await launch(profile);
    await typeInEditor(h.page, 'crash text');
    for (let i = 0; i < 30; i++) { if (await storedDraft(h.page, 'untitled')) break; await sleep(150); }
    await hardClose(h); // app.exit(0): no question, nothing discarded
    h = await launch(profile);
    const offer = await until(h.page, (f) => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes(f)), T.draftFound, 4000);
    check('F3d a draft nobody discarded is still offered after a relaunch', !!offer);
  } finally {
    await hardClose(h);
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
};

scenarios.F4 = async () => {
  console.log('[F4] a failed open names the file, says what happened and stays; the document stays');
  const missing = path.join(tmp, 'gone.md');
  const folder = path.join(tmp, 'folder.md');
  const denied = path.join(tmp, 'locked.md');
  const fifo = path.join(tmp, 'pipe.md');
  const binary = path.join(tmp, 'binary.md');
  await fsp.mkdir(folder);
  await fsp.writeFile(denied, '# locked\n');
  await fsp.chmod(denied, 0o000);
  let haveFifo = true;
  try { execSync(`mkfifo ${JSON.stringify(fifo)}`); } catch { haveFifo = false; }
  const bin = Buffer.alloc(4096);
  // S4 (f): a file of C0 control bytes only is read as text by 0.1.0 / 0.1.1 (and so by 0.2.0); the full byte
  // range is refused by both decoders, so it keeps this a file the shell refuses.
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + 11) % 256;
  await fsp.writeFile(binary, bin);
  const h = await launch();
  try {
    await typeInEditor(h.page, 'my text');
    const cases = [
      [missing, '无法打开「gone.md」：找不到这个文件，它可能已被移动、重命名或删除'],
      [folder, '无法打开「folder.md」：这是一个文件夹，不是文件'],
      [denied, '无法打开「locked.md」：没有读取这个文件的权限'],
      ...(haveFifo ? [[fifo, '无法打开「pipe.md」：这不是普通文件（可能是管道、套接字或设备）']] : []),
      [binary, '无法打开「binary.md」：无法识别它的文本编码，它可能不是文本文件'],
    ];
    for (const [p, expected] of cases) {
      await emitOpenFile(h.app, p);
      await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
      await clickDialogButton(h.page, T.discard);
      const shown = await until(h.page, (e) => [...document.querySelectorAll('.mdr-toast__text')].some((t) => t.textContent === e), expected, 5000);
      check(`F4 ${path.basename(p)}: 「${expected}」`, !!shown, JSON.stringify(await toastTexts(h.page)));
      check(`F4 ${path.basename(p)}: the document stays`, (await editorText(h.page)) === 'my text');
    }
    await sleep(9000);
    const after = await toastTexts(h.page);
    // Stage 2b, G34: at most 3 failure toasts stay on screen; older ones fold into one counting line.
    const last = cases.slice(-3).map(([, e]) => e);
    check('F4 the messages are still there 9 s later (newest 3 + counting line, G34)',
      last.every((e) => after.includes(e)) && after.includes(`另有 ${cases.length - 3} 个文件无法打开`), JSON.stringify(after));
    check('F4 no 「重新授权」 wording on the desktop', !after.join('\n').includes('授权'));
    const title = await h.page.title();
    check('F4 the window still shows the user’s document (dirty untitled)', title.includes('未命名'), title);
  } finally {
    await hardClose(h);
    await fsp.chmod(denied, 0o644).catch(() => {});
  }
};

const watchdog = setTimeout(() => {
  console.log(`GLOBAL TIMEOUT after ${GLOBAL_TIMEOUT_MS / 1000} s`);
  if (OWN_SERVER) killPort(PORT);
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);

let vite = null;
try {
  await fsp.writeFile(A, A_TEXT);
  await fsp.writeFile(B, B_TEXT);
  if (OWN_SERVER) {
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }
  for (const [name, run] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try {
      await run();
    } catch (err) {
      check(`${name} ran to the end`, false, String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
    }
  }
} finally {
  clearTimeout(watchdog);
  if (vite) { try { process.kill(vite.pid, 'SIGKILL'); } catch { /* gone */ } killPort(PORT); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
