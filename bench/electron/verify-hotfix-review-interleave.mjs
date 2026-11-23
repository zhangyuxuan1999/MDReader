// bench/electron/verify-hotfix-review-interleave.mjs — adversarial review probes (verify:review#1,
// 2026-11-20) for interleavings NOT covered by open-lifecycle.mjs:
//   R1 webContents.reload() and open-file in the same tick
//   R2 dirty document, close requested (renderer's 保存/不保存/取消 dialog up), then open-file, then 不保存
//   R3 open-file creates a window, that window is closed before its renderer subscribed, then activate
//   R4 close + activate + open-file + activate in one tick: exactly one window showing the file
//   R5 renderer crash while the close dialog is up, then open-file
//   R6 open-file emitted from inside the window's 'close' listener during app.quit() (clean doc)
// Every main-process uncaughtException / unhandledRejection is recorded and reported.
//   MDR_EXE=/path/to/MDReader.app/Contents/MacOS/MDReader node bench/electron/verify-hotfix-review-interleave.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE;
const ONLY = process.env.MDR_ONLY_R2 === '1'; // run only R2 (+R6 quit)
if (!EXE) { console.error('set MDR_EXE'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-review-')));
const profiles = [];
const errors = [];
const results = [];
let current = null;

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
function makeDoc(tag) {
  const name = `review-${tag}.md`;
  const file = path.join(TMP, name);
  const h1 = `标题 ${tag}`;
  const marker = `marker-${tag}-正文`;
  fs.writeFileSync(file, `# ${h1}\n\n${marker}\n`, 'utf8');
  return { file, name, h1, marker };
}

async function launch(label) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-review-'));
  profiles.push(prof);
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`], timeout: 30000 });
  current = { app, pid: app.process()?.pid };
  let n = 0;
  app.on('window', (p) => {
    const l = `${label}#${++n}`;
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${l}] console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => errors.push(`[${l}] pageerror: ${String(e && e.message).slice(0, 160)}`));
  });
  await app.evaluate(({ app: a, dialog }) => {
    a.addRecentDocument = () => {}; // rule 6: never touch the user's macOS recent-documents list
    globalThis.__mainErr = [];
    process.on('uncaughtException', (e) => globalThis.__mainErr.push(`uncaught: ${e && e.message} @ ${String(e && e.stack).split('\n').slice(1, 6).map((x) => x.trim()).join(' < ')}`));
    process.on('unhandledRejection', (e) => globalThis.__mainErr.push(`rejection: ${e && e.message}`));
    globalThis.__sent = [];
    globalThis.__boxes = [];
    dialog.showMessageBox = async (...x) => {
      const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {};
      globalThis.__boxes.push(o.message);
      return { response: 0, checkboxChecked: false };
    };
    a.on('browser-window-created', (_e, w) => {
      const wc = w.webContents;
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...rest) => {
        if (ch === 'mdr:open-file') globalThis.__sent.push({ win: w.id, path: rest[0] });
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
  try { await app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  if (pid) {
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}

const windows = (app) => withTimeout(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length), 4000, -1);
const withTimeout = (pr, ms, v) => Promise.race([pr, sleep(ms).then(() => v)]);
const mainSnap = (app) => withTimeout(mainSnapRaw(app), 4000, { windows: -1, error: 'mainSnap timeout' });
const mainSnapRaw = (app) => app.evaluate(async ({ BrowserWindow }) => {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const w = wins[0];
  if (!w) return { windows: 0 };
  if (w.webContents.isCrashed() || w.webContents.isLoading()) return { windows: wins.length, loading: true };
  try {
    const r = await Promise.race([new Promise((res) => setTimeout(() => res((() => { try { return { error: 'executeJavaScript timeout', state: w.isDestroyed() ? 'destroyed' : { title: w.getTitle(), url: w.webContents.getURL(), loading: w.webContents.isLoading(), visible: w.isVisible() } }; } catch (e) { return { error: 'executeJavaScript timeout', state: String(e && e.message) }; } })()), 2500)), w.webContents.executeJavaScript(`({
      title: document.title,
      editor: document.querySelector('.cm-content')?.textContent ?? '',
      h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
      buttons: [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()),
    })`)]);
    return { windows: wins.length, ...r };
  } catch (e) { return { windows: wins.length, error: String(e && e.message) }; }
});
const desc = (s) => (s ? `${s.error ? `ERR=${s.error} ${JSON.stringify(s.state || '')} ` : ''}windows=${s.windows} title=${JSON.stringify(s.title ?? null)} editorLen=${s.editor?.length ?? '-'} h1=${JSON.stringify(s.h1 ?? null)} dialog=${JSON.stringify(s.buttons ?? [])}` : 'none');
async function waitShows(app, doc, ms = 12000) {
  const end = Date.now() + ms;
  let s = null;
  while (Date.now() < end) {
    s = await mainSnap(app).catch(() => s);
    if (s && s.windows === 1 && s.title?.includes(doc.name) && s.editor?.includes(doc.marker) && s.h1 === doc.h1) return { ok: true, s };
    await sleep(200);
  }
  return { ok: false, s };
}
async function waitFor(app, pred, ms = 10000) {
  const end = Date.now() + ms;
  let s = null;
  while (Date.now() < end) {
    s = await mainSnap(app).catch(() => s);
    if (s && pred(s)) return { ok: true, s };
    await sleep(150);
  }
  return { ok: false, s };
}
const exec = (app, js) => app.evaluate(({ BrowserWindow }, code) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  return w ? w.webContents.executeJavaScript(code) : null;
}, js);
const clickBtn = (app, label) => exec(app, `(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
const emitOpen = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
async function makeDirty(app, text) {
  const page = app.windows().filter((p) => !p.isClosed()).at(-1);
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(text, { delay: 5 });
  await sleep(500);
}
async function freshWindowReady(app) {
  const r = await waitFor(app, (s) => s.windows === 1 && typeof s.title === 'string' && s.title.length > 0 && s.editor !== undefined, 20000);
  return r.ok;
}

const timer = setTimeout(async () => {
  console.log('FAIL global timeout');
  await Promise.race([hardQuit(), sleep(8000)]);
  cleanup();
  process.exit(2);
}, 240000);
function cleanup() {
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

try {
  let m = null;
  let app = await launch('a');
  await app.firstWindow();
  await freshWindowReady(app);

  if (!ONLY) {
  // R1 reload + open-file in the same tick
  const d1 = makeDoc('reload-same-tick');
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    BrowserWindow.getAllWindows()[0].webContents.reload();
    a.emit('open-file', { preventDefault() {} }, fp);
  }, d1.file);
  m = await waitShows(app, d1);
  check('R1 webContents.reload() + open-file in the same tick: file shown after reload', m.ok, desc(m.s));

  console.log('step R4');
  // R4 close + activate + open-file + activate in one tick
  const d4 = makeDoc('close-activate-tick');
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
    a.emit('activate');
    a.emit('open-file', { preventDefault() {} }, fp);
    a.emit('activate');
  }, d4.file);
  m = await waitShows(app, d4);
  await sleep(500);
  const w4 = await windows(app);
  check('R4 close + activate + open-file + activate in one tick: one window showing the file', m.ok && w4 === 1, `${desc(m.s)} windowsAfter=${w4}`);

  console.log('step R3');
  // R3 open-file creates a window, it is closed before its renderer subscribed, then activate
  const d3 = makeDoc('closed-while-loading');
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  await waitFor(app, (s) => s.windows === 0, 8000);
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    a.emit('open-file', { preventDefault() {} }, fp);
    for (const w of BrowserWindow.getAllWindows()) w.close(); // closed while loading
  }, d3.file);
  await sleep(1500);
  const afterLoadClose = await windows(app);
  const sentBefore = (await app.evaluate(() => globalThis.__sent.slice())).filter((x) => x.path === d3.file).length;
  await app.evaluate(({ app: a }) => { a.emit('activate'); });
  m = await waitShows(app, d3);
  check('R3 window closed while loading with a pending file: no window left; next activate shows that file',
    afterLoadClose === 0 && sentBefore === 0 && m.ok,
    `windowsAfterClose=${afterLoadClose} sentBeforeActivate=${sentBefore} afterActivate: ${desc(m.s)}`);

  }
  console.log('step R2');
  // R2 dirty + close requested + open-file + 不保存
  const d2 = makeDoc('during-close-dialog');
  await makeDirty(app, 'DIRTY-R2');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const dlg = await waitFor(app, (s) => (s.buttons || []).length >= 2, 8000);
  const closeButtons = dlg.s?.buttons || [];
  await emitOpen(app, d2.file);
  await sleep(1500);
  const mid = await mainSnap(app);
  const discardLabel = closeButtons.find((b) => b === '不保存' || b === '丢弃') || closeButtons[1];
  const clicked = await clickBtn(app, discardLabel);
  await sleep(2500);
  let s2 = await mainSnap(app);
  // a second guard dialog (from the open) may still be up — record it, do not answer it blindly
  const r2win = s2.windows;
  const r2shown = s2.windows === 1 && s2.title?.includes(d2.name) && s2.editor?.includes(d2.marker);
  const sent2 = (await app.evaluate(() => globalThis.__sent.slice())).filter((x) => x.path === d2.file).length;
  check('R2 dirty + close dialog + open-file + discard: the double-clicked file ends up shown',
    r2shown,
    `closeDialog=${JSON.stringify(closeButtons)} midDialog=${JSON.stringify(mid.buttons || [])} clicked=${JSON.stringify(discardLabel)}:${clicked} end: ${desc(s2)} sentCount=${sent2}`);
  if (r2win === 0) {
    // reopen for the next probe
    await app.evaluate(({ app: a }) => { a.emit('activate'); });
    await freshWindowReady(app);
  } else if ((s2.buttons || []).length) {
    await clickBtn(app, (s2.buttons || []).find((b) => b === '不保存' || b === '丢弃') || s2.buttons[0]);
    await sleep(800);
  }

  if (!ONLY) {
  // R5 crash while the close dialog is up, then open-file
  const d5 = makeDoc('crash-during-close-dialog');
  s2 = await mainSnap(app);
  if (s2.windows === 0) { await app.evaluate(({ app: a }) => { a.emit('activate'); }); await freshWindowReady(app); }
  await makeDirty(app, 'DIRTY-R5');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await waitFor(app, (s) => (s.buttons || []).length >= 2, 8000);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
  await sleep(800);
  await emitOpen(app, d5.file);
  m = await waitShows(app, d5, 15000);
  check('R5 renderer crash while the close dialog is up, then open-file: file shown', m.ok, desc(m.s));

  }
  const meBefore = await app.evaluate(() => globalThis.__mainErr.slice()).catch(() => ['(unreadable)']);
  console.log(`main-process errors before R6: ${JSON.stringify(meBefore)}`);
  // R6 open-file from inside 'close' during app.quit() with a clean document
  const d6 = makeDoc('during-quit');
  { const sx = await mainSnap(app); if ((sx.buttons || []).length) { await clickBtn(app, sx.buttons.find((b) => b === '不保存' || b === '丢弃') || sx.buttons[0]); await sleep(800); } }
  // make the document clean: open a fresh file over it
  const pid = current.pid;
  await app.evaluate(({ app: a, BrowserWindow }, fp) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.prependListener('close', () => { a.emit('open-file', { preventDefault() {} }, fp); });
    setTimeout(() => a.quit(), 50);
  }, d6.file).catch(() => {});
  let exited = false;
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { exited = true; break; }
    await sleep(150);
  }
  check('R6 open-file during app.quit() (clean doc): app still quits (path dropped by design)', exited, `exited=${exited}`);
  if (!exited) {
    const left = await mainSnap(app).catch(() => null);
    console.log(`R6 app did not exit: ${desc(left)}`);
  } else {
    current = null;
  }
  if (current) {
    const me = await app.evaluate(() => globalThis.__mainErr.slice()).catch(() => ['(unreadable)']);
    console.log(`main-process errors: ${JSON.stringify(me)}`);
  }
} catch (err) {
  check('script ran to the end', false, String(err && err.stack || err).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(timer);
  // main errors of a still-running app
  if (current) {
    const me = await current.app.evaluate(() => globalThis.__mainErr.slice()).catch(() => null);
    if (me) console.log(`main-process errors: ${JSON.stringify(me)}`);
  }
  await Promise.race([hardQuit(), sleep(10000)]);
  cleanup();
  console.log(`console/page errors: ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}
