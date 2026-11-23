// bench/electron/v2-flow-desk.mjs — verify-flows (0.2.0 stage 2a): desktop open / discard / close flows and
// drafts on an UNPACKED app directory (no dev hooks: DOM + IndexedDB only, so candidate and baseline run
// the very same script).
//   MDR_TARGET=staging  node bench/electron/v2-flow-desk.mjs [D1 D2 ...]   # release/staging-0.2.0.noindex
//   MDR_TARGET=baseline node bench/electron/v2-flow-desk.mjs [D1 D2 ...]   # release/baseline-0.1.1.noindex
//   MDR_TARGET=dev MDR_DEV_URL=http://localhost:<port>/ node bench/electron/v2-flow-desk.mjs ...  # the tree's shell + a running Vite (fix-flows-1, stage 2b)
// Launches only through ./_electron.mjs (isolated profiles). Temp documents and profiles: MDR_V2_TMP
// (default os.tmpdir()), removed at the end. Global timeout 240 s (run it with nohup in the background).
import { electron } from './_electron.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TARGETS = {
  staging: path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */,
  baseline: path.join(ROOT, 'release/baseline-0.1.1.noindex'),
  dev: ROOT,
};
const TARGET = process.env.MDR_TARGET || 'staging';
const APP_DIR = TARGETS[TARGET];
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE_TMP = fs.realpathSync(process.env.MDR_V2_TMP || os.tmpdir());
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE_TMP, 'v2flow-docs-')));
const profiles = [];
const live = new Set();
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const note = (s) => console.log(`NOTE ${s}`);

const T = { discardQ: '当前文档尚未保存，是否放弃更改？', discard: '丢弃', cancel: '取消', dontSave: '不保存', save: '保存', draftFound: '发现未保存的草稿，是否恢复？' };

async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}
async function untilMain(app, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await app.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}
const editorText = (page) => page.evaluate(() => {
  const c = document.querySelector('.cm-content');
  const v = c && c.cmView && c.cmView.view;
  if (v) return v.state.doc.toString();
  return [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
});
const dialogTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);
async function clickBtn(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no dialog button ${label}; dialogs ${JSON.stringify(await dialogTexts(page).catch(() => []))}`);
}
const watchDialogs = (page) => page.evaluate(() => {
  window.__v2max = document.querySelectorAll('.mdr-dialog').length;
  new MutationObserver(() => { window.__v2max = Math.max(window.__v2max, document.querySelectorAll('.mdr-dialog').length); })
    .observe(document.body, { childList: true, subtree: true });
});
const maxDialogs = (page) => page.evaluate(() => window.__v2max);
const storedDraft = (page, id) => page.evaluate(async (docId) => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return null;
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      try {
        const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + docId);
        g.onsuccess = () => { res(g.result ? String(g.result.text) : null); db.close(); };
        g.onerror = () => { res(null); db.close(); };
      } catch { res(null); db.close(); }
    };
    r.onerror = () => res(null);
  });
}, id);
async function waitDraft(page, id, text, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await storedDraft(page, id)) === text) return true;
    await sleep(150);
  }
  return false;
}
async function untilText(page, want, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await editorText(page).catch(() => null)) === want) return true;
    await sleep(100);
  }
  return false;
}
async function typeInEditor(page, text) {
  await page.click('.cm-content');
  await page.keyboard.type(text, { delay: 5 });
  await sleep(250);
}

async function launch(profile) {
  const prof = profile || fs.mkdtempSync(path.join(BASE_TMP, 'v2flow-prof-'));
  if (!profile) profiles.push(prof);
  const app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  live.add(app);
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(700);
  await watchDialogs(page);
  return { app, page, prof };
}
async function hardClose(h) {
  if (!h) return;
  live.delete(h.app);
  const pid = (() => { try { return h.app.process()?.pid; } catch { return undefined; } })();
  try { await h.app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* gone */ }
  await Promise.race([h.app.close().catch(() => {}), sleep(4000)]);
  if (pid) {
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}
async function newPage(app, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const p of app.windows()) {
      if (p.isClosed()) continue;
      const ok = await p.evaluate(() => !!document.querySelector('.cm-content')).catch(() => false);
      if (ok) { await sleep(700); await watchDialogs(p).catch(() => {}); return p; }
    }
    await sleep(150);
  }
  throw new Error('no window came up');
}
const doc = (name, text) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return f; };

const S = {};

// D1 — crash-recovery offer (untitled) left unanswered; the window is minimised: is the draft kept?
S.D1 = async () => {
  console.log('[D1] unanswered crash offer survives minimise / close of the clean window');
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'v2flow-prof-'));
  profiles.push(prof);
  let h = await launch(prof);
  try {
    await typeInEditor(h.page, 'crash text');
    check('D1 precondition: draft stored', await waitDraft(h.page, 'untitled', 'crash text'));
    await hardClose(h); // app.exit(0): a crash as far as the drafts are concerned
    h = await launch(prof);
    const offer = await until(h.page, (f) => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes(f)), T.draftFound, 4000);
    check('D1 offer after relaunch', !!offer, JSON.stringify(await toastTexts(h.page)));
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(1500);
    note(`visibilityState while minimised: ${await h.page.evaluate(() => document.visibilityState)}`);
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await sleep(500);
    const d = await storedDraft(h.page, 'untitled');
    check('D1a the crash draft is still stored after minimise + restore', d === 'crash text', JSON.stringify(d));
    // Close the (clean) window, reopen through the Dock: still offered?
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 6000);
    await h.app.evaluate(({ app: a }) => { a.emit('activate', { preventDefault() {} }, false); });
    const p2 = await newPage(h.app);
    const offer2 = await until(p2, (f) => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes(f)), T.draftFound, 4000);
    check('D1b after closing and reopening the window the offer is still there', !!offer2, `toasts ${JSON.stringify(await toastTexts(p2))} idb ${JSON.stringify(await storedDraft(p2, 'untitled'))}`);
  } finally {
    await hardClose(h);
  }
};

// D6 — the same unanswered crash offer while the app is hidden (⌘H = win.hide()) and occluded.
S.D6 = async () => {
  console.log('[D6] unanswered crash offer survives ⌘H (hide) / app.hide()');
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'v2flow-prof-'));
  profiles.push(prof);
  let h = await launch(prof);
  try {
    await typeInEditor(h.page, 'crash text');
    check('D6 precondition: draft stored', await waitDraft(h.page, 'untitled', 'crash text'));
    await hardClose(h);
    h = await launch(prof);
    const offer = await until(h.page, (f) => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes(f)), T.draftFound, 4000);
    check('D6 offer after relaunch', !!offer);
    await h.page.evaluate(() => { window.__v2vis = []; document.addEventListener('visibilitychange', () => window.__v2vis.push(document.visibilityState)); });
    await h.app.evaluate(({ app: a, BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide(); if (a.hide) a.hide(); });
    await sleep(2000);
    note(`visibility events while hidden: ${JSON.stringify(await h.page.evaluate(() => [document.visibilityState, window.__v2vis]))}`);
    await h.app.evaluate(({ app: a, BrowserWindow }) => { if (a.show) a.show(); BrowserWindow.getAllWindows()[0].show(); });
    await sleep(800);
    const d = await storedDraft(h.page, 'untitled');
    check('D6 the crash draft is still stored after hide + show', d === 'crash text', JSON.stringify(d));
  } finally {
    await hardClose(h);
  }
};

// D7 — a file DROPPED onto the window while the close question is up (the shell cannot hold it back: it
// never sees a drop). 不保存 → is the dropped document shown anywhere? 取消 → is it shown?
async function installDropInput(page) {
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.id = 'v2-files'; i.style.display = 'none';
    document.body.appendChild(i);
  });
}
async function dropFiles(page, paths) {
  await page.setInputFiles('#v2-files', paths);
  return page.evaluate(() => {
    const files = document.getElementById('v2-files').files;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const target = document.querySelector('.mdr-dialog-backdrop') || document.querySelector('.cm-content');
    for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    return files.length;
  });
}
S.D7 = async () => {
  console.log('[D7] drop during the close question');
  const B = doc('d7-b.md', '# B7\n\nbeta\n');
  for (const ans of [T.dontSave, T.cancel]) {
    const h = await launch();
    try {
      await installDropInput(h.page);
      await typeInEditor(h.page, 'dirty seven');
      await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
      await dropFiles(h.page, [B]);
      await sleep(800);
      check(`D7 ${ans}: one question after the drop`, (await maxDialogs(h.page)) === 1, JSON.stringify(await dialogTexts(h.page)));
      await clickBtn(h.page, ans);
      await sleep(1500);
      const wins = await windowCount(h.app);
      if (ans === T.dontSave) {
        note(`不保存: windows after ${wins}`);
        let shown = false;
        if (wins === 0) {
          const p2 = await newPage(h.app, 4000).catch(() => null);
          shown = !!p2 && (await editorText(p2)) === '# B7\n\nbeta\n';
          note(`a window came back by itself: ${!!p2}`);
        } else {
          note(`dialogs ${JSON.stringify(await dialogTexts(h.page).catch(() => []))} editor ${JSON.stringify(await editorText(h.page).catch(() => null))}`);
        }
        check('D7 不保存: the dropped document is shown somewhere', shown, `windows ${wins}`);
      } else {
        const texts = await dialogTexts(h.page);
        note(`取消: windows ${wins}, dialogs ${JSON.stringify(texts)}`);
        if (texts.length === 1) { await clickBtn(h.page, T.discard); await sleep(800); }
        check('D7 取消: the dropped document is shown after its own question', (await editorText(h.page)) === '# B7\n\nbeta\n', JSON.stringify(await editorText(h.page)));
        check('D7 取消: never two questions', (await maxDialogs(h.page)) === 1, String(await maxDialogs(h.page)));
      }
    } catch (e) {
      check(`D7 ${ans} ran`, false, String(e).split('\n')[0]);
    } finally {
      await hardClose(h);
    }
  }
};

// D8 — a 10 MB document in the middle: dirty → open BIG → 丢弃 → while it loads, open SMALL and press close;
// then a recent entry whose file is gone.
S.D8 = async () => {
  console.log('[D8] slow load in the middle; recent entry for a vanished file');
  const line = 'Lorem ipsum dolor sit amet, 中文段落用于测试较大的文件加载。\n\n';
  const big = doc('d8-big.md', '# Big\n\n' + line.repeat(Math.ceil(10_000_000 / Buffer.byteLength(line))));
  const small = doc('d8-small.md', '# Small\n\nsmall text\n');
  const h = await launch();
  try {
    await typeInEditor(h.page, 'dirty eight');
    await emitOpenFile(h.app, big);
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
    await clickBtn(h.page, T.discard);
    await emitOpenFile(h.app, small);
    await sleep(50);
    await emitOpenFile(h.app, small);
    const ok = await untilText(h.page, '# Small\n\nsmall text\n', 20000);
    check('D8 the last requested (small) document ends up shown', ok, JSON.stringify((await editorText(h.page)).slice(0, 30)));
    check('D8 one question only', (await maxDialogs(h.page)) === 1, String(await maxDialogs(h.page)));
    note(`title ${await h.page.title()}`);
    // recent entry for a vanished file (toolbar recent list)
    fs.renameSync(big, big + '.moved');
    await h.page.click('.mdr-toolbar__file');
    await h.page.waitForSelector('.mdr-recent__item', { timeout: 3000 });
    await sleep(300);
    const items = await h.page.$$eval('.mdr-recent__item', (els) => els.map((e) => e.textContent));
    note(`recent items ${JSON.stringify(items)}`);
    const idx = items.indexOf('d8-big.md');
    if (idx >= 0) {
      await (await h.page.$$('.mdr-recent__item'))[idx].click();
      await sleep(1500);
      note(`after clicking the vanished recent entry: toasts ${JSON.stringify(await toastTexts(h.page))}, editor ${JSON.stringify((await editorText(h.page)).slice(0, 20))}`);
      await h.page.click('.mdr-toolbar__file');
      await sleep(500);
      note(`recent items now ${JSON.stringify(await h.page.$$eval('.mdr-recent__item, .mdr-recent__empty', (els) => els.map((e) => e.textContent)))}`);
    }
  } finally {
    await hardClose(h);
  }
};

// D9 — a FIFO named *.md dropped onto the window (the shell refuses FIFOs; the renderer falls back to File.text()).
// Is the document guard stuck afterwards (新建 / open-file still work)?
S.D9 = async () => {
  console.log('[D9] FIFO dropped onto the window');
  const fifo = path.join(TMP, 'd9-pipe.md');
  execSync(`mkfifo ${JSON.stringify(fifo)}`);
  const after = doc('d9-after.md', '# After\n\nstill works\n');
  const h = await launch();
  try {
    await installDropInput(h.page);
    const r = await Promise.race([h.page.setInputFiles('#v2-files', [fifo]).then(() => 'set'), sleep(8000).then(() => 'setInputFiles hung')]);
    note(`setInputFiles: ${r}`);
    if (r !== 'set') return;
    await h.page.evaluate(() => {
      const files = document.getElementById('v2-files').files;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const target = document.querySelector('.cm-content');
      for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await sleep(2500);
    note(`after the FIFO drop: editor ${JSON.stringify((await editorText(h.page)).slice(0, 30))}, title ${JSON.stringify(await h.page.title())}, toasts ${JSON.stringify(await toastTexts(h.page))}`);
    await emitOpenFile(h.app, after);
    const ok = await untilText(h.page, '# After\n\nstill works\n', 6000);
    if (!ok && (await dialogTexts(h.page)).length) { await clickBtn(h.page, T.discard); }
    const ok2 = ok || (await untilText(h.page, '# After\n\nstill works\n', 4000));
    check('D9 after the FIFO drop a document from the OS still opens (guard not stuck)', ok2, JSON.stringify((await editorText(h.page)).slice(0, 30)));
  } finally {
    // unblock any reader of the FIFO, then clean up
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* no reader */ }
    await hardClose(h);
  }
};

// D2 — a document arrives while the close question is up; every answer.
S.D2 = async () => {
  console.log('[D2] open-file during the close question');
  const A = doc('d2-a.md', '# A\n\nalpha\n');
  for (const answer of [T.dontSave, T.cancel, 'save-cancelled']) {
    const h = await launch();
    try {
      await typeInEditor(h.page, 'dirty text');
      if (answer === 'save-cancelled') {
        await h.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); dialog.showSaveDialogSync = () => undefined; });
      }
      await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
      await emitOpenFile(h.app, A);
      await sleep(700);
      check(`D2 ${answer}: one question while the document waits`, (await maxDialogs(h.page)) === 1, JSON.stringify(await dialogTexts(h.page)));
      await clickBtn(h.page, answer === 'save-cancelled' ? T.save : answer);
      if (answer === T.dontSave) {
        await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 5000);
        const p2 = await newPage(h.app).catch(() => null);
        const t = p2 ? await editorText(p2) : null;
        check('D2 不保存: the held document is shown in the next window', t === '# A\n\nalpha\n', JSON.stringify(t));
        if (p2) {
          const d = await storedDraft(p2, 'untitled');
          check('D2 不保存: the discarded untitled draft is gone', d === null, JSON.stringify(d));
        }
      } else {
        await sleep(1200);
        const texts = await dialogTexts(h.page);
        note(`${answer}: windows ${await windowCount(h.app)}, dialogs ${JSON.stringify(texts)}, editor ${JSON.stringify(await editorText(h.page))}`);
        check(`D2 ${answer}: window stays`, (await windowCount(h.app)) === 1);
        check(`D2 ${answer}: the held document asks its own discard question`, texts.length === 1 && texts[0] === T.discardQ, JSON.stringify(texts));
        if (texts.length === 1) {
          await clickBtn(h.page, T.discard);
          const ok = await untilText(h.page, '# A\n\nalpha\n', 4000);
          check(`D2 ${answer}: 丢弃 → the held document is shown`, !!ok, JSON.stringify(await editorText(h.page)));
        }
        check(`D2 ${answer}: never two questions`, (await maxDialogs(h.page)) === 1, String(await maxDialogs(h.page)));
      }
    } catch (e) {
      check(`D2 ${answer} ran`, false, String(e).split('\n')[0]);
    } finally {
      await hardClose(h);
    }
  }
};

// D3 — 丢弃 on the discard question, then the window is closed / the renderer dies immediately:
// does the thrown-away untitled draft come back?
S.D3 = async () => {
  console.log('[D3] 丢弃 then immediate close / renderer crash: is the discarded draft gone?');
  const A = doc('d3-a.md', '# A3\n\nalpha\n');
  for (const how of ['close', 'crash']) {
    const prof = fs.mkdtempSync(path.join(BASE_TMP, 'v2flow-prof-'));
    profiles.push(prof);
    let h = await launch(prof);
    try {
      await typeInEditor(h.page, 'thrown away ' + how);
      check(`D3 ${how} precondition: draft stored`, await waitDraft(h.page, 'untitled', 'thrown away ' + how));
      await emitOpenFile(h.app, A);
      await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 4000);
      await h.page.evaluate((how2) => {
        const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
        b.click();
        window.__v2how = how2;
      }, how);
      const gap = Number(process.env.V2_GAP_MS || 0);
      if (gap) await sleep(gap);
      if (how === 'close') await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      else await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
      await sleep(2500);
      let p2;
      if (how === 'close') {
        await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 5000);
        await h.app.evaluate(({ app: a }) => { a.emit('activate', { preventDefault() {} }, false); });
        p2 = await newPage(h.app);
      } else {
        await sleep(2000);
        await hardClose(h);
        h = await launch(prof);
        p2 = h.page;
      }
      await sleep(800);
      const d = await storedDraft(p2, 'untitled');
      check(`D3 ${how}: the discarded untitled draft is not in IndexedDB`, d === null, JSON.stringify(d));
      const offers = (await toastTexts(p2)).filter((t) => t.includes(T.draftFound));
      note(`${how}: next page editor ${JSON.stringify((await editorText(p2)).slice(0, 20))}, offers ${offers.length}`);
    } catch (e) {
      check(`D3 ${how} ran`, false, String(e).split('\n')[0]);
    } finally {
      await hardClose(h);
    }
  }
};

// D4 — ten failed opens: how many toasts, how much of the window do they cover, do they go away, and does a
// later successful open of one of those names clear its stale error?
S.D4 = async () => {
  console.log('[D4] ten failed opens + a later successful one');
  const h = await launch();
  try {
    const names = [];
    for (let i = 0; i < 10; i++) names.push(path.join(TMP, `missing-${i}.md`));
    for (const p of names) { await emitOpenFile(h.app, p); await sleep(150); }
    await sleep(1500);
    const t1 = await toastTexts(h.page);
    note(`toasts after 10 failures: ${t1.length}: ${JSON.stringify(t1.slice(0, 2))}`);
    const box = await h.page.evaluate(() => {
      const hs = document.querySelector('.mdr-toasts');
      const r = hs ? hs.getBoundingClientRect() : null;
      return { vh: innerHeight, vw: innerWidth, top: r && Math.round(r.top), h: r && Math.round(r.height), w: r && Math.round(r.width) };
    });
    note(`toast stack box ${JSON.stringify(box)}`);
    await sleep(9000);
    const t2 = await toastTexts(h.page);
    note(`toasts 9 s later: ${t2.length}`);
    // The same name now exists: open it.
    fs.writeFileSync(names[0], '# now here\n');
    await emitOpenFile(h.app, names[0]);
    await untilText(h.page, '# now here\n', 4000);
    await sleep(500);
    const t3 = await toastTexts(h.page);
    const stale = t3.filter((t) => t.includes('missing-0.md'));
    note(`after a successful open of missing-0.md: stale errors naming it: ${JSON.stringify(stale)}`);
    // keyboard: Escape does it dismiss the newest error toast?
    await h.page.keyboard.press('Escape');
    await sleep(300);
    note(`after Escape: ${(await toastTexts(h.page)).length} toasts`);
    // Tab reachability of the × buttons
    const closeBtns = await h.page.evaluate(() => [...document.querySelectorAll('.mdr-toast__close')].filter((b) => b.tabIndex >= 0).length);
    note(`focusable × buttons: ${closeBtns}`);
  } finally {
    await hardClose(h);
  }
};

// D5 — drop onto the window: a binary / undecodable .md, a chmod-000 .md, several files.
S.D5 = async () => {
  console.log('[D5] drop failures on the desktop');
  const bin = Buffer.alloc(4096);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + 11) % 32;
  const binary = path.join(TMP, 'd5-binary.md');
  fs.writeFileSync(binary, bin);
  const locked = doc('d5-locked.md', '# locked\n');
  fs.chmodSync(locked, 0o000);
  const one = doc('d5-one.md', '# one\n');
  const two = doc('d5-two.md', '# two\n');
  const h = await launch();
  try {
    await h.page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'file'; i.multiple = true; i.id = 'v2-files'; i.style.display = 'none';
      document.body.appendChild(i);
    });
    const drop = async (paths) => {
      await h.page.setInputFiles('#v2-files', paths);
      return h.page.evaluate(() => {
        const files = document.getElementById('v2-files').files;
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const root = document.querySelector('.mdr-app') || document.body.firstElementChild;
        const target = document.querySelector('.cm-content') || root;
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return files.length;
      });
    };
    for (const [label, p] of [['binary', binary], ['locked', locked]]) {
      await h.page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
      await drop([p]);
      await sleep(1500);
      const t = await editorText(h.page);
      note(`${label}: editor ${JSON.stringify(t.slice(0, 40))} (len ${t.length}), toasts ${JSON.stringify(await toastTexts(h.page))}, title ${JSON.stringify(await h.page.title())}`);
      // also: what does open-file say for the same path?
      await h.page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
      await emitOpenFile(h.app, p);
      await sleep(1200);
      if ((await dialogTexts(h.page)).length) { await clickBtn(h.page, T.discard); await sleep(1000); }
      note(`${label} via open-file: toasts ${JSON.stringify(await toastTexts(h.page))}`);
    }
    await h.page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
    await drop([one, two]);
    await sleep(1500);
    if ((await dialogTexts(h.page)).length) { await clickBtn(h.page, T.discard); await sleep(1000); }
    note(`two files dropped: editor ${JSON.stringify(await editorText(h.page))}, toasts ${JSON.stringify(await toastTexts(h.page))}`);
  } finally {
    await hardClose(h);
    try { fs.chmodSync(locked, 0o644); } catch { /* */ }
  }
};

const watchdog = setTimeout(async () => {
  console.log('GLOBAL TIMEOUT');
  for (const a of live) { try { a.process()?.kill('SIGKILL'); } catch { /* */ } }
  process.exit(2);
}, 240_000);
try {
  console.log(`target ${TARGET}: ${APP_DIR}`);
  for (const [n, fn] of Object.entries(S)) {
    if (ONLY.length && !ONLY.includes(n)) continue;
    try { await fn(); } catch (e) { check(`${n} ran`, false, String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); }
  }
} finally {
  clearTimeout(watchdog);
  for (const a of live) { try { await hardClose({ app: a }); } catch { /* */ } }
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  try { execSync(`chmod -R u+rw ${JSON.stringify(TMP)}`); } catch { /* */ }
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
process.exit(fails.length ? 1 : 0);
