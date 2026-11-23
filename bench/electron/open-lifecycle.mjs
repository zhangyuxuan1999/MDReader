// bench/electron/open-lifecycle.mjs — e2e for the document-open lifecycle of the desktop shell
// (CONTRACT §10 / §10a addendum): cold start, open-file with and without a window, activate,
// second-instance, the dirty guard, renderer crashes, encodings, open-file during the dirty-close
// dialog (checks 19–22, fix round 2), the S1 shell leftovers of 0.1.1 (checks 23–27: T5, N12, V1, T2,
// ext-none; 0.2.0 fix round). Guards the 2026-11 bug "close the window, double-click a .md,
// get an empty 未命名.md".
//
//   MDR_EXE=/Applications/MDReader.app/Contents/MacOS/MDReader node bench/electron/open-lifecycle.mjs
//   MDR_APP_DIR=/path/to/unpacked-app node bench/electron/open-lifecycle.mjs   (project's electron)
//
// Every launch gets a fresh --user-data-dir (deleted at the end). Documents are delivered through the
// main process (app.emit('open-file' …)), never through LaunchServices / `open`.
// Prints PASS / FAIL per check; exits 1 on any FAIL, 2 on the global timeout.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE || '';
const APP_DIR = process.env.MDR_APP_DIR || '';
if (!EXE && !APP_DIR) {
  console.error('set MDR_EXE (packaged executable) or MDR_APP_DIR (unpacked app directory)');
  process.exit(64);
}
const GLOBAL_TIMEOUT_MS = Number(process.env.MDR_TIMEOUT_MS || 420000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-open-lifecycle-')));
const profiles = [];
const results = [];
const errors = []; // console errors + page errors, from every window of every launch
let current = null; // { app, pid }

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// MDR_SKIP=16,17,18 skips those checks entirely (none of their steps run). Only the encoding checks
// (16)–(18) can be skipped: they test the tree's fileIO.mjs, which hotfix 0.1.1 does not ship.
const SKIPPABLE = new Set([16, 17, 18]);
const SKIP = new Set(String(process.env.MDR_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
for (const n of SKIP) {
  if (!SKIPPABLE.has(n)) { console.error(`MDR_SKIP: check ${n} cannot be skipped (only 16, 17, 18)`); process.exit(64); }
}
const skippedChecks = [];
/** True (and prints SKIP) when check `n` is in MDR_SKIP. */
function skipped(n, name) {
  if (!SKIP.has(n)) return false;
  skippedChecks.push(name);
  console.log(`SKIP ${name}`);
  return true;
}

/** A small, clearly non-empty Markdown file; marker + h1 identify it on screen. */
function makeDoc(tag) {
  const name = `lifecycle-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  const marker = `marker-${tag}-正文`;
  fs.writeFileSync(file, `# ${h1}\n\n${marker}\n\n- 一\n- 二\n`, 'utf8');
  return { file, name, h1, marker };
}

function watchPage(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${String(e && e.message).slice(0, 200)}`));
}

async function launch(label, extraArgs = []) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-lifecycle-'));
  profiles.push(prof);
  const args = [...(APP_DIR ? [APP_DIR] : []), ...extraArgs, `--user-data-dir=${prof}`];
  const app = await electron.launch(EXE ? { executablePath: EXE, args, timeout: 30000 } : { args, timeout: 30000 });
  current = { app, pid: app.process()?.pid };
  // Keep the macOS recent-documents list (keyed by bundle id, not by profile) untouched.
  await app.evaluate(({ app: a }) => { a.addRecentDocument = () => {}; });
  let n = 0;
  app.on('window', (p) => watchPage(p, `${label}#${++n}`));
  // Log every path the shell hands to a renderer (main process): "delivered exactly once" checks.
  await app.evaluate(({ app: a }) => {
    globalThis.__mdrSent = [];
    a.on('browser-window-created', (_e, w) => {
      const wc = w.webContents;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => {
        if (ch === 'mdr:open-file') globalThis.__mdrSent.push({ win: w.id, path: rest[0] });
        return orig(ch, ...rest);
      };
    });
  });
  return app;
}

async function hardQuit() {
  if (!current) return;
  const { app, pid } = current;
  current = null;
  try { await app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* already gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  if (pid) {
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}

const emitOpen = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
const windows = (app) => app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.id));
const sent = (app) => app.evaluate(() => globalThis.__mdrSent.slice());

async function waitWindows(app, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let ids = [];
  while (Date.now() < deadline) {
    ids = await windows(app).catch(() => ids);
    if (ids.length === n) return ids;
    await sleep(100);
  }
  return ids;
}

const snap = (page) => page.evaluate(() => ({
  title: document.title,
  editorLen: (document.querySelector('.cm-content')?.textContent ?? '').length,
  untitled: document.title.includes('未命名'),
  h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
}));
const describe = (s) => (s ? `title=${JSON.stringify(s.title)} editorLen=${s.editorLen} h1=${JSON.stringify(s.h1)}` : 'no snapshot');

/** True once the page shows the document: window title, editor text and preview h1. */
async function shows(page, doc, timeoutMs = 12000) {
  try {
    await page.waitForFunction(({ name, h1, marker }) =>
      document.title.includes(name)
      && (document.querySelector('.cm-content')?.textContent ?? '').includes(marker)
      && document.querySelector('.mdr-preview__body h1')?.textContent?.trim() === h1,
    { name: doc.name, h1: doc.h1, marker: doc.marker }, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** What the one window shows, read from the main process (survives renderer crashes / reloads,
 *  where a Playwright page object may go stale). */
const mainSnap = (app) => app.evaluate(async ({ BrowserWindow }) => {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const w = wins[0];
  if (!w) return { windows: 0 };
  if (w.webContents.isCrashed() || w.webContents.isLoading()) return { windows: wins.length, crashed: w.webContents.isCrashed(), loading: true };
  try {
    // raced against a timeout: executeJavaScript on a window that is going away can never settle
    const r = await Promise.race([new Promise((_res, rej) => setTimeout(() => rej(new Error('executeJavaScript timeout')), 2000)),
      w.webContents.executeJavaScript(`({
      title: document.title,
      editor: document.querySelector('.cm-content')?.textContent ?? '',
      h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
      toasts: [...document.querySelectorAll('.mdr-toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 3),
      buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()),
      draftOffer: document.body.innerText.includes('发现未保存的草稿'),
    })`)]);
    return { windows: wins.length, crashed: false, ...r };
  } catch (e) {
    return { windows: wins.length, error: String(e && e.message), url: w.webContents.getURL(), visible: w.isVisible() };
  }
});
const describeMain = (s) => (s ? `windows=${s.windows} title=${JSON.stringify(s.title ?? null)} editorLen=${s.editor?.length ?? '-'} h1=${JSON.stringify(s.h1 ?? null)}${s.crashed ? ' crashed' : ''}` : 'no snapshot');

/** Polls the main-process view until the one window shows `doc` (title, editor text, h1). */
async function mainShows(app, doc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < deadline) {
    s = await mainSnap(app).catch(() => s);
    if (s && s.windows === 1 && s.title?.includes(doc.name) && s.editor?.includes(doc.marker) && s.h1 === doc.h1) return { ok: true, s };
    await sleep(200);
  }
  return { ok: false, s };
}

/** Polls until the one window shows `name` in its title and `text` (newlines dropped) in the editor. */
async function mainShowsText(app, name, text, timeoutMs = 10000) {
  const want = text.replace(/\n/g, '');
  const deadline = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < deadline) {
    s = await mainSnap(app).catch(() => s);
    if (s && s.windows === 1 && s.title?.includes(name) && s.editor === want) return { ok: true, s };
    await sleep(200);
  }
  return { ok: false, s };
}

async function ready(page) {
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForFunction(() => document.title.length > 0, null, { timeout: 10000 }).catch(() => {});
}

async function closeAllWindows(app) {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  return (await waitWindows(app, 0)).length === 0;
}

/** Close the window, then run `trigger`; returns the new window's page (or null). */
async function afterClose(app, trigger) {
  const closed = await closeAllWindows(app);
  if (!closed) return { closed, page: null };
  await sleep(300);
  const winP = app.waitForEvent('window', { timeout: 15000 }).catch(() => null);
  await trigger();
  const page = await winP;
  if (page) await ready(page).catch(() => {});
  return { closed, page };
}

const timer = setTimeout(async () => {
  console.log(`FAIL global timeout after ${GLOBAL_TIMEOUT_MS} ms`);
  await Promise.race([hardQuit(), sleep(8000)]);
  cleanupFiles();
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);

function cleanupFiles() {
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

try {
  console.log(`target: ${EXE ? `MDR_EXE=${EXE}` : `MDR_APP_DIR=${APP_DIR}`}`);

  // (1) cold start with a file argument
  const d1 = makeDoc('cold');
  let app = await launch('cold', [d1.file]);
  let page = await app.firstWindow();
  await ready(page);
  const ok1 = await shows(page, d1);
  check('(1) cold start with a file argument shows the file', ok1 && (await windows(app)).length === 1,
    ok1 ? '' : describe(await snap(page).catch(() => null)));

  // (2) open-file with the window open
  const d2 = makeDoc('open-window');
  await emitOpen(app, d2.file);
  const ok2 = await shows(page, d2);
  check('(2) open-file with the window open shows the file', ok2 && (await windows(app)).length === 1,
    ok2 ? '' : describe(await snap(page).catch(() => null)));

  // (3) close the window, then open-file
  const d3 = makeDoc('closed-1');
  let r = await afterClose(app, () => emitOpen(app, d3.file));
  let ok3 = false;
  let detail3 = '';
  if (!r.closed) detail3 = 'window did not close';
  else if (!r.page) detail3 = 'no new window';
  else {
    const shown = await shows(r.page, d3);
    await sleep(800);
    const ids = await windows(app);
    const s = await snap(r.page).catch(() => null);
    const n = (await sent(app)).filter((x) => x.path === d3.file).length;
    ok3 = shown && ids.length === 1 && s && !s.untitled && n === 1;
    detail3 = `${describe(s)} windows=${ids.length} delivered=${n}`;
  }
  check('(3) close window + open-file: one new window showing the file, not 未命名', ok3, detail3);

  // (4) (3) three times in a row
  let ok4 = true;
  const d4 = [];
  for (let i = 1; i <= 3; i++) {
    const d = makeDoc(`repeat-${i}`);
    d4.push(d);
    r = await afterClose(app, () => emitOpen(app, d.file));
    const shown = r.page ? await shows(r.page, d) : false;
    const ids = await windows(app);
    const s = r.page ? await snap(r.page).catch(() => null) : null;
    const good = r.closed && !!r.page && shown && ids.length === 1 && s && !s.untitled;
    if (!good) { ok4 = false; console.log(`      round ${i}: ${describe(s)} windows=${ids.length}`); }
    if (r.page) page = r.page;
  }
  check('(4) close + open-file, three rounds in a row', ok4);

  // (5) close the window, two open-file events back to back
  const d5a = makeDoc('burst-a');
  const d5b = makeDoc('burst-b');
  r = await afterClose(app, async () => { await emitOpen(app, d5a.file); await emitOpen(app, d5b.file); });
  let ok5 = false;
  let detail5 = '';
  if (r.page) {
    const shown = await shows(r.page, d5b);
    await sleep(1200);
    const ids = await windows(app);
    const s = await snap(r.page).catch(() => null);
    const log = await sent(app);
    const winId = ids[0];
    const toWin = log.filter((x) => x.win === winId).map((x) => x.path);
    const inOrder = toWin.length === 2 && toWin[0] === d5a.file && toWin[1] === d5b.file;
    ok5 = shown && ids.length === 1 && inOrder && s && s.title.includes(d5b.name);
    detail5 = `${describe(s)} windows=${ids.length} delivered=[${toWin.map((p) => path.basename(p)).join(', ')}]`;
  } else detail5 = r.closed ? 'no new window' : 'window did not close';
  check('(5) close + two open-file back to back: one window, both delivered in order, last shown', ok5, detail5);
  if (r.page) page = r.page;

  // (6) close the window, activate (Dock click): empty untitled window; then open-file into it
  const d6 = makeDoc('after-activate');
  r = await afterClose(app, () => app.evaluate(({ app: a }) => { a.emit('activate'); }));
  let ok6a = false;
  let ok6b = false;
  let detail6 = '';
  if (r.page) {
    await sleep(800);
    const ids0 = await windows(app);
    const s0 = await snap(r.page).catch(() => null);
    ok6a = ids0.length === 1 && s0 && s0.untitled;
    await emitOpen(app, d6.file);
    const shown = await shows(r.page, d6);
    const ids1 = await windows(app);
    ok6b = shown && ids1.length === 1 && ids1[0] === ids0[0];
    detail6 = `before: ${describe(s0)} windows=${ids0.length}; after: windows=${ids1.length} sameWindow=${ids1[0] === ids0[0]}`;
    page = r.page;
  } else detail6 = r.closed ? 'no new window' : 'window did not close';
  check('(6) close + activate: one empty 未命名 window, then open-file shows the file in it', ok6a && ok6b, detail6);

  // (7) close the window, second-instance with the file in argv
  const d7 = makeDoc('second-instance');
  r = await afterClose(app, () => app.evaluate(({ app: a }, { file, cwd }) => {
    a.emit('second-instance', {}, [process.execPath, file], cwd);
  }, { file: d7.file, cwd: TMP }));
  let ok7 = false;
  let detail7 = '';
  if (r.page) {
    const shown = await shows(r.page, d7);
    await sleep(500);
    const ids = await windows(app);
    ok7 = shown && ids.length === 1;
    detail7 = `${describe(await snap(r.page).catch(() => null))} windows=${ids.length}`;
    page = r.page;
  } else detail7 = r.closed ? 'no new window' : 'window did not close';
  check('(7) close + second-instance [exe, file]: a window showing the file', ok7, detail7);

  // (8) dirty document + open-file: the discard guard appears; 取消 keeps the text
  const d8 = makeDoc('guard-target');
  const typed = 'DIRTY编辑内容';
  if ((await windows(app)).length === 0) {
    // an earlier check left no window (only happens when it failed): get one via activate
    const winP = app.waitForEvent('window', { timeout: 15000 });
    await app.evaluate(({ app: a }) => { a.emit('activate'); });
    page = await winP;
    await ready(page);
  } else {
    page = app.windows().filter((p) => !p.isClosed()).at(-1) || page;
  }
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(typed, { delay: 5 });
  await sleep(400);
  const dirtyTitle = await page.evaluate(() => document.title);
  await emitOpen(app, d8.file);
  let dialogOk = false;
  try {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.mdr-dialog__btn')].map((x) => x.textContent.trim());
      return b.includes('取消') && b.length >= 2;
    }, null, { timeout: 8000 });
    dialogOk = true;
  } catch { /* no dialog */ }
  let kept = false;
  if (dialogOk) {
    await page.evaluate(() => {
      [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '取消')?.click();
    });
    await sleep(800);
    kept = await page.evaluate((t) => (document.querySelector('.cm-content')?.textContent ?? '').includes(t)
      && !document.querySelector('.mdr-dialog'), typed);
  }
  const titleAfter = await page.evaluate(() => document.title);
  check('(8) dirty document + open-file: discard guard appears, 取消 keeps the text',
    dialogOk && kept && !titleAfter.includes(d8.name) && (await windows(app)).length === 1,
    `dialog=${dialogOk} kept=${kept} dirtyTitleMarked=${dirtyTitle !== titleAfter ? 'changed' : 'same'}`);

  // (9) extra: open-file in the same tick as the window's close (window going away, not yet 'closed')
  await page.evaluate(() => {
    [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '取消')?.click();
  }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mdr:command', 'file.new');
  });
  await sleep(500);
  await page.evaluate(() => {
    [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃')?.click();
  }).catch(() => {});
  await page.waitForFunction(() => !document.title.startsWith('●') && !document.querySelector('.mdr-dialog'), null, { timeout: 8000 }).catch(() => {});
  const d9 = makeDoc('same-tick');
  const winP9 = app.waitForEvent('window', { timeout: 15000 }).catch(() => null);
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
    a.emit('open-file', { preventDefault() {} }, fp);
  }, d9.file);
  const p9 = await winP9;
  let ok9 = false;
  let detail9 = 'no new window';
  if (p9) {
    await ready(p9).catch(() => {});
    const shown = await shows(p9, d9);
    await sleep(600);
    const ids = await windows(app);
    ok9 = shown && ids.length === 1;
    detail9 = `${describe(await snap(p9).catch(() => null))} windows=${ids.length}`;
  }
  check('(9) open-file in the same tick as close: one window showing the file', ok9, detail9);

  // Main-process view from here on: crashes and reloads can leave Playwright page objects stale.
  // Message boxes are recorded instead of shown (the crash-loop error, the invalid-UTF-8 warning).
  await app.evaluate(({ dialog }) => {
    globalThis.__mdrBoxes = [];
    dialog.showMessageBox = async (...a) => {
      const o = a.find((x) => x && typeof x === 'object' && 'message' in x) || {};
      globalThis.__mdrBoxes.push({ type: o.type, message: o.message });
      return { response: 0, checkboxChecked: false };
    };
  });
  const boxes = () => app.evaluate(() => globalThis.__mdrBoxes.slice());
  const crash = () => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (w) w.webContents.forcefullyCrashRenderer();
    return !!w;
  });

  // (10) F3: renderer crash, then open-file — the window recovers and shows the file
  const d10 = makeDoc('after-crash');
  await crash();
  await sleep(800);
  await emitOpen(app, d10.file);
  let m = await mainShows(app, d10);
  check('(10) renderer crash + open-file: the window reloads and shows the file', m.ok, describeMain(m.s));

  // (11) renderer reload, open-file 30 ms into it — not lost in the gap
  const d11 = makeDoc('during-reload');
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    BrowserWindow.getAllWindows()[0].webContents.reload();
    setTimeout(() => a.emit('open-file', { preventDefault() {} }, fp), 30);
  }, d11.file);
  m = await mainShows(app, d11);
  check('(11) open-file 30 ms into a renderer reload: shown after the reload', m.ok, describeMain(m.s));

  // (12) renderer crash, close the dead window, then open-file (crash → close → double-click)
  const d12 = makeDoc('crash-close');
  await crash();
  await sleep(300);
  const closed12 = await closeAllWindows(app);
  await sleep(300);
  await emitOpen(app, d12.file);
  m = await mainShows(app, d12);
  check('(12) renderer crash + close + open-file: one new window showing the file', closed12 && m.ok,
    `closed=${closed12} ${describeMain(m.s)}`);

  // (13) a renderer that keeps crashing is given up (error box, window gone); the next open is fresh
  let gone = false;
  for (let i = 0; i < 4 && !gone; i++) {
    await crash();
    await sleep(1500);
    gone = (await windows(app)).length === 0;
  }
  const boxes13 = await boxes();
  const d13 = makeDoc('after-crash-loop');
  await sleep(300);
  await emitOpen(app, d13.file);
  m = await mainShows(app, d13);
  check('(13) repeated renderer crashes: window given up with an error box, next open-file shows the file',
    gone && boxes13.some((b) => b.type === 'error') && m.ok, `gone=${gone} boxes=${boxes13.length} ${describeMain(m.s)}`);

  // (14) F5: no window, 文件 → 打开… — a window comes up and the picked file is shown in it;
  // with no window ⌘O / ⌘N are registered accelerators, with a window they are not (no double fire)
  const d14 = makeDoc('menu-open');
  const closed14 = await closeAllWindows(app);
  await app.evaluate(({ dialog }, fp) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] });
  }, d14.file);
  await sleep(400);
  const accel = () => app.evaluate(({ Menu }) => {
    const m0 = Menu.getApplicationMenu();
    return ['file.open', 'file.new', 'file.save'].map((id) => m0?.getMenuItemById(id)?.registerAccelerator ?? null);
  });
  const accelNoWin = await accel();
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('file.open').click(); });
  m = await mainShows(app, d14);
  await sleep(400);
  const accelWin = await accel();
  check('(14) no window + 文件 → 打开…: a window shows the picked file; ⌘O registered only while windowless',
    closed14 && m.ok && accelNoWin[0] === true && accelNoWin[1] === true && accelNoWin[2] === false
      && accelWin[0] === false && accelWin[2] === false, // file.new is always registered (menu.mjs RENDERER_UNBOUND)
    `${describeMain(m.s)} accel(noWindow)=${JSON.stringify(accelNoWin)} accel(window)=${JSON.stringify(accelWin)}`);

  // (15) F5: no window, 文件 → 新建 — one empty untitled window
  const closed15 = await closeAllWindows(app);
  await sleep(400);
  const winP15 = app.waitForEvent('window', { timeout: 15000 }).catch(() => null);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('file.new').click(); });
  page = await winP15;
  if (page) await ready(page).catch(() => {});
  await sleep(600);
  const s15 = await mainSnap(app);
  check('(15) no window + 文件 → 新建: one empty 未命名 window', closed15 && !!page && s15.windows === 1
    && s15.title?.includes('未命名') && s15.editor === '', describeMain(s15));

  // (16) encodings: Big5 / Shift_JIS / EUC-KR / BOM-less UTF-16LE / UTF-8 cut off in its last character
  if (!skipped(16, '(16) Big5 / Shift_JIS / EUC-KR / UTF-16LE (no BOM) / truncated UTF-8 are shown as their real text')) {
  const ZH = '# 标题\n\n这是一个中文文档，包含一些内容。第二句话在这里。\n\n- 列表项一\n- 列表项二\n';
  const HANT = '# 標題\n\n這是一個繁體中文文件，包含一些內容。第二句話在這裡。\n\n- 清單項目一\n- 清單項目二\n';
  const JA = '# 見出し\n\nこれは日本語の文書です。内容があります。二番目の文です。\n\n- 項目一\n- 項目二\n';
  const KO = '# 제목\n\n이것은 한국어 문서입니다. 내용이 있습니다. 두 번째 문장입니다.\n\n- 항목 하나\n- 항목 둘\n';
  const iconv = (t, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(t, 'utf8') });
  const encCases = [
    ['enc-big5.md', iconv(HANT, 'BIG5'), HANT],
    ['enc-sjis.md', iconv(JA, 'SHIFT_JIS'), JA],
    ['enc-euckr.md', iconv(KO, 'EUC-KR'), KO],
    ['enc-utf16le-nobom.md', Buffer.from(ZH, 'utf16le'), ZH],
    ['enc-utf8-truncated.md', Buffer.concat([Buffer.from(ZH, 'utf8'), Buffer.from([0xe4, 0xb8])]), `${ZH}\uFFFD`],
  ];
  // S4 (f) (lead, stage 2c): 0.2.0 ships with the decoder overrides OFF, so each file must be shown exactly as the
  // frozen 0.1.0 decoder (= 0.1.1) reads it (`text` above is the true text, kept for the report), a file 0.1.0
  // refuses must not open, and no invalid-UTF-8 warning box appears (K11 lapses).
  const O = await import('../../test/fixtures/fileIO-0.1.0.mjs');
  const encBad = [];
  for (const [name, bytes] of encCases) {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, bytes);
    let expect = null;
    try { expect = O.decodeBuffer(bytes).text; } catch { expect = null; }
    await emitOpen(app, f);
    if (expect === null) {
      await sleep(1500);
      const s = await mainSnap(app).catch(() => null);
      if (!s || s.title?.includes(name)) encBad.push(`${name} (0.1.0 refuses it) opened: ${describeMain(s)}`);
    } else {
      const r16 = await mainShowsText(app, name, expect);
      if (!r16.ok) encBad.push(`${name}: ${describeMain(r16.s)}`);
    }
  }
  const warned = (await boxes()).some((b) => b.type === 'warning' && String(b.message).includes('enc-utf8-truncated.md'));
  check('(16) Big5 / Shift_JIS / EUC-KR / UTF-16LE (no BOM) / truncated UTF-8 are shown as their real text',
    encBad.length === 0 && !warned, `${encBad.join(' | ') || 'all 5 shown as 0.1.0 reads them'}; invalid-UTF-8 warning=${warned}`);
  }

  // (17) edit + ⌘S on a Big5 file writes Big5 (used to write GBK bytes: silent corruption)
  if (!skipped(17, '(17) Big5 file: edit + ⌘S writes Big5 with the new text')) {
  const iconv = (t, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(t, 'utf8') });
  const HANT = '# 標題\n\n這是一個繁體中文文件，包含一些內容。第二句話在這裡。\n\n- 清單項目一\n- 清單項目二\n';
  // S4 (f): the Big5 bytes are read as 0.1.0 reads them (GBK), and edit + ⌘S must write exactly what 0.1.0's
  // encoder writes for that text plus the typed characters (0.1.1's result), byte for byte.
  const O = await import('../../test/fixtures/fileIO-0.1.0.mjs');
  const f17 = path.join(TMP, 'enc-big5-save.md');
  const b17 = iconv(HANT, 'BIG5');
  fs.writeFileSync(f17, b17);
  const d17 = O.decodeBuffer(b17);
  const want17 = O.encodeText(d17.text + '新增', { encoding: d17.encoding, bom: d17.bom, eol: O.eolOf(d17.text) });
  await emitOpen(app, f17);
  const r17 = await mainShowsText(app, 'enc-big5-save.md', d17.text);
  let saved17 = null;
  if (r17.ok && page) {
    await page.click('.cm-content');
    await page.keyboard.press('Meta+End');
    await page.keyboard.type('新增', { delay: 10 });
    await sleep(300);
    await page.keyboard.press('Meta+s');
    for (let i = 0; i < 30 && saved17 === null; i++) {
      await sleep(200);
      const now = fs.readFileSync(f17);
      if (!now.equals(b17)) { await sleep(200); saved17 = fs.readFileSync(f17); }
    }
  }
  check('(17) Big5 file: edit + ⌘S writes Big5 with the new text', !!saved17 && saved17.equals(want17),
    r17.ok ? `saved=${saved17 ? saved17.length : null} bytes, equals 0.1.0's encoding (${d17.encoding}) of text+新增: ${!!saved17 && saved17.equals(want17)}` : describeMain(r17.s));
  }

  // (18) a FIFO named .md is refused at once and does not block the next document
  if (!skipped(18, '(18) open-file of a FIFO, then a normal file: the normal file is shown')) {
  const fifo = path.join(TMP, 'fifo.md');
  const mk = spawnSync('/usr/bin/mkfifo', [fifo]);
  const d18 = makeDoc('after-fifo');
  await emitOpen(app, fifo);
  await sleep(300);
  await emitOpen(app, d18.file);
  m = await mainShows(app, d18, 8000);
  check('(18) open-file of a FIFO, then a normal file: the normal file is shown', mk.status === 0 && m.ok,
    `mkfifo=${mk.status} ${describeMain(m.s)}`);
  }

  // ---- fix round 2 (2026-11-20) -------------------------------------------------------------------
  const execMain = (js) => app.evaluate(({ BrowserWindow }, code) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    return w ? w.webContents.executeJavaScript(code) : null;
  }, js);
  const clickBtn = (label) => execMain(`(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')]
    .find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  async function waitMain(pred, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let s = null;
    while (Date.now() < deadline) {
      s = await mainSnap(app).catch(() => s);
      if (s && pred(s)) return { ok: true, s };
      await sleep(150);
    }
    return { ok: false, s };
  }
  const livePage = () => app.windows().filter((x) => !x.isClosed()).at(-1) || page;
  async function makeDirty(text) {
    const pg = livePage();
    await pg.click('.cm-content');
    await pg.keyboard.press('Meta+End');
    await pg.keyboard.type(text, { delay: 5 });
    await pg.waitForFunction(() => document.title.startsWith('●'), null, { timeout: 4000 }).catch(() => {});
    await sleep(300);
  }
  const sentTo = async (file) => (await sent(app)).filter((x) => x.path === file).length;

  // (19) strictly valid UTF-8 with control characters opens (0.1.0 did; the first hotfix draft refused
  // > 2 % control characters as binary and showed an empty 未命名.md)
  const ESC = '\u001b';
  const ctlCases = [
    ['ansi-log', '```\n' + Array.from({ length: 30 }, (_, i) => `${ESC}[32m✓${ESC}[0m test ${i} ${ESC}[2m(${i} ms)${ESC}[0m`).join('\n') + '\n```\n'],
    ['formfeed', Array.from({ length: 12 }, (_, i) => `## S${i}\n\f`).join('\n')],
    ['nul', 'before\u0000after\n\nmore\u0000\u0000text\n'],
  ];
  const ctlBad = [];
  for (const [tag, body] of ctlCases) {
    const d = makeDoc(`ctl-${tag}`);
    fs.writeFileSync(d.file, `# ${d.h1}\n\n${d.marker}\n\n${body}`, 'utf8');
    await emitOpen(app, d.file);
    const r19 = await mainShows(app, d, 10000);
    if (!r19.ok) ctlBad.push(`${d.name}: ${describeMain(r19.s)} toasts=${JSON.stringify(r19.s?.toasts ?? [])}`);
  }
  check('(19) valid UTF-8 with ANSI colour codes / form feeds / NULs opens and shows its text',
    ctlBad.length === 0, ctlBad.join(' | ') || 'all 3 shown');

  // (20) dirty document, close requested (保存 / 不保存 / 取消 up), open-file, 取消: the held file goes to
  // the same window afterwards (its own discard guard; 丢弃 → shown), never stacked on the close dialog
  const d20 = makeDoc('close-dialog-cancel');
  const winBefore20 = await windows(app);
  await makeDirty('DIRTY-20');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dlg20 = await waitMain((s) => (s.buttons || []).includes('不保存'));
  await emitOpen(app, d20.file);
  await sleep(800);
  const mid20 = await mainSnap(app);
  const held20 = (await sentTo(d20.file)) === 0 && (mid20.buttons || []).filter((b) => b === '取消').length === 1;
  const cancel20 = await clickBtn('取消');
  const guard20 = await waitMain((s) => (s.buttons || []).includes('丢弃'));
  if (guard20.ok) await clickBtn('丢弃');
  m = await mainShows(app, d20);
  const winAfter20 = await windows(app);
  check('(20) dirty-close dialog + open-file + 取消: file held during the dialog, then shown in the same window',
    dlg20.ok && held20 && cancel20 && guard20.ok && m.ok && winAfter20.length === 1 && winAfter20[0] === winBefore20[0],
    `closeDialog=${JSON.stringify(dlg20.s?.buttons ?? [])} mid=${JSON.stringify(mid20.buttons ?? [])} held=${held20} openGuard=${guard20.ok} ${describeMain(m.s)} sameWindow=${winAfter20[0] === winBefore20[0]}`);

  // (21) same, but 不保存: the window closes and ONE new window shows the double-clicked file
  // (used to: the window closed and the file was never shown)
  const d21 = makeDoc('close-dialog-discard');
  await makeDirty('DIRTY-21');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dlg21 = await waitMain((s) => (s.buttons || []).includes('不保存'));
  await emitOpen(app, d21.file);
  await sleep(800);
  const held21 = (await sentTo(d21.file)) === 0;
  const winP21 = app.waitForEvent('window', { timeout: 15000 }).catch(() => null);
  const discard21 = await clickBtn('不保存');
  const p21 = await winP21;
  if (p21) { page = p21; await ready(p21).catch(() => {}); }
  m = await mainShows(app, d21);
  await sleep(500);
  const n21 = await windows(app);
  check('(21) dirty-close dialog + open-file + 不保存: window closes, one new window shows the file',
    dlg21.ok && held21 && discard21 && !!p21 && m.ok && n21.length === 1 && (await sentTo(d21.file)) === 1,
    `held=${held21} newWindow=${!!p21} ${describeMain(m.s)} windows=${n21.length}`);

  // (22) renderer crash with an edited document: the reloaded window reopens THAT document (and its
  // draft logic offers the unsaved text), not an empty 未命名.md
  const d22 = makeDoc('crash-restore');
  await emitOpen(app, d22.file);
  const shown22 = await mainShows(app, d22);
  await makeDirty('DIRTY-22');
  await sleep(2500); // let the renderer persist its IndexedDB draft before the crash
  await crash();
  await sleep(500);
  m = await mainShows(app, d22, 15000);
  const offer22 = await waitMain((s) => !!s.draftOffer, 5000);
  const s22 = offer22.s;
  check('(22) renderer crash on an edited file: the reloaded window shows that file again (draft offered)',
    shown22.ok && m.ok, `${describeMain(m.s)} draftOffer=${!!s22?.draftOffer} buttons=${JSON.stringify(s22?.buttons ?? [])}`);

  // ---- 0.2.0 fix round, decision S1 (2026-11-20): one check per item, in a fresh launch ------------
  await hardQuit();
  app = await launch('s1');
  page = await app.firstWindow();
  await ready(page);
  await sleep(500);
  const winState = () => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    return w ? { minimized: w.isMinimized(), visible: w.isVisible() } : null;
  });

  // (23) T5: no window, open-file A, B, A within 60 ms: the last request (A) ends up shown
  const d23a = makeDoc('t5-a');
  const d23b = makeDoc('t5-b');
  const closed23 = await closeAllWindows(app);
  await sleep(300);
  await app.evaluate(({ app: a }, [fa, fb]) => {
    a.emit('open-file', { preventDefault() {} }, fa);
    setTimeout(() => a.emit('open-file', { preventDefault() {} }, fb), 30);
    setTimeout(() => a.emit('open-file', { preventDefault() {} }, fa), 60);
  }, [d23a.file, d23b.file]);
  await sleep(500);
  m = await mainShows(app, d23a);
  await sleep(600);
  const m23 = await mainSnap(app);
  const log23 = (await sent(app)).map((x) => path.basename(x.path));
  check('(23) S1/T5 no window + open-file A, B, A within 60 ms: one window, A (the last request) shown',
    closed23 && m.ok && m23.windows === 1 && m23.title?.includes(d23a.name) && log23.at(-1) === d23a.name,
    `${describeMain(m23)} delivered=[${log23.join(', ')}]`);

  // (24) N12: dirty-close question up, window minimised; open-file restores it (document held), so
  // does activate; 取消 then lets the held document through
  const d24 = makeDoc('n12-held');
  await makeDirty('DIRTY-24');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dlg24 = await waitMain((s) => (s.buttons || []).includes('不保存'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await sleep(900);
  const min24a = (await winState())?.minimized;
  await emitOpen(app, d24.file);
  await sleep(900);
  const afterOpen24 = await winState();
  const held24 = (await sentTo(d24.file)) === 0;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await sleep(900);
  const min24b = (await winState())?.minimized;
  await app.evaluate(({ app: a }) => { a.emit('activate', {}, false); });
  await sleep(900);
  const afterActivate24 = await winState();
  await clickBtn('取消');
  const guard24 = await waitMain((s) => (s.buttons || []).includes('丢弃'));
  if (guard24.ok) await clickBtn('丢弃');
  m = await mainShows(app, d24);
  check('(24) S1/N12 dirty-close question + minimised window: open-file and activate restore it; 取消 then shows the held file',
    dlg24.ok && min24a === true && afterOpen24?.minimized === false && afterOpen24?.visible === true && held24
      && min24b === true && afterActivate24?.minimized === false && m.ok,
    `minimised=${min24a} afterOpenFile=${JSON.stringify(afterOpen24)} held=${held24} reMinimised=${min24b} afterActivate=${JSON.stringify(afterActivate24)} ${describeMain(m.s)}`);

  // (25) V1: an app-origin navigation that is aborted leaves the old, subscribed page in place:
  // open-file and menu commands still reach it. Since S3 (0.2.0 stage 2b) a navigation the PAGE starts
  // (location.href = …) is cancelled by will-navigate, so the abort itself is started from the main
  // process (loadURL + stop()); the page-initiated one stays in the check as the cancelled case.
  const d25 = makeDoc('v1-after-abort');
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__mdrCmds = [];
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const orig = wc.send.bind(wc);
    wc.send = (ch, ...rest) => { if (ch === 'mdr:command') globalThis.__mdrCmds.push(rest[0]); return orig(ch, ...rest); };
  });
  await execMain(`(() => { location.href = 'app://mdreader/index.html?x=1'; window.stop(); return true; })()`).catch(() => null);
  await sleep(800);
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.loadURL('app://mdreader/index.html?x=1').catch(() => {});
    wc.stop();
  });
  await sleep(1500);
  await emitOpen(app, d25.file);
  m = await mainShows(app, d25, 6000);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.toggleTheme').click(); });
  await sleep(500);
  const cmds25 = await app.evaluate(() => globalThis.__mdrCmds.slice());
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.toggleTheme').click(); }); // theme back
  check('(25) S1/V1 cancelled (page) + aborted (main-process loadURL + stop) app-origin navigation: open-file is shown and a menu command is delivered',
    m.ok && cmds25.includes('view.toggleTheme'), `${describeMain(m.s)} commands=${JSON.stringify(cmds25)}`);

  // (26) T2: 打开… chosen in the same tick as the window's close (between 'close' and 'closed'): the
  // window that reopens runs it once
  const d26 = makeDoc('t2-picked');
  await app.evaluate(({ dialog }, fp) => {
    globalThis.__mdrOpenDialogCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.__mdrOpenDialogCalls++; return { canceled: false, filePaths: [fp] }; };
  }, d26.file);
  await app.evaluate(({ BrowserWindow, Menu }) => {
    BrowserWindow.getAllWindows()[0].close();
    Menu.getApplicationMenu().getMenuItemById('file.open').click();
  });
  m = await mainShows(app, d26, 12000);
  await sleep(500);
  const calls26 = await app.evaluate(() => globalThis.__mdrOpenDialogCalls);
  check('(26) S1/T2 close + 打开… in the same tick: one new window runs 打开… once and shows the picked file',
    m.ok && calls26 === 1, `${describeMain(m.s)} openDialogCalls=${calls26}`);

  // (27) ext-none: a cold-start argv file without a Markdown extension is opened; a directory argument
  // is ignored; second-instance with an extensionless file too
  const noExt = (tag) => {
    const name = `README-${tag}`;
    const file = path.join(TMP, name);
    const h1 = `标题 ${tag}`;
    const marker = `marker-${tag}-正文`;
    fs.writeFileSync(file, `# ${h1}\n\n${marker}\n`, 'utf8');
    return { file, name, h1, marker };
  };
  const d27 = noExt('noext-cold');
  const d27b = noExt('noext-second');
  await hardQuit();
  app = await launch('noext', [TMP, d27.file]);
  page = await app.firstWindow();
  await ready(page);
  const cold27 = await mainShows(app, d27);
  await sleep(800);
  const toasts27 = (await mainSnap(app)).toasts ?? [];
  await app.evaluate(({ app: a }, { file, cwd }) => { a.emit('second-instance', {}, [process.execPath, file], cwd); },
    { file: d27b.file, cwd: TMP });
  const second27 = await mainShows(app, d27b);
  check('(27) S1/ext-none cold start [dir, README-x] shows README-x (dir ignored); second-instance README-y too',
    cold27.ok && second27.ok && !toasts27.some((t) => /文件夹|失败/.test(t)),
    `cold: ${describeMain(cold27.s)} toasts=${JSON.stringify(toasts27)}; second: ${describeMain(second27.s)}`);
} catch (err) {
  check('script ran to the end', false, String(err && err.stack || err).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(timer);
  await hardQuit();
  cleanupFiles();
}

console.log(`\nconsole/page errors: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
console.log(`summary: passed=${results.length - failed} failed=${failed} skipped=${skippedChecks.length}`);
process.exit(failed ? 1 : 0);
