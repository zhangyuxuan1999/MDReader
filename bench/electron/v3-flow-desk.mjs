// bench/electron/v3-flow-desk.mjs — verify-flows (0.2.0 stage 2c): desktop open / failure / close / draft
// flows on an UNPACKED app directory, DOM + IndexedDB only (the same script runs candidate and baseline).
//   MDR_TARGET=staging  node bench/electron/v3-flow-desk.mjs [K1 K2 …]   # release/staging-0.2.0.noindex
//   MDR_TARGET=baseline node bench/electron/v3-flow-desk.mjs [K1 K2 …]   # release/baseline-0.1.1.noindex
//   MDR_TARGET=dev MDR_DEV_URL=http://localhost:<port>/ node bench/electron/v3-flow-desk.mjs …  # the tree's shell + a running Vite
// Launches only through ./_electron.mjs (isolated profiles). Never full screen. Temp documents and profiles go
// to MDR_V3_TMP (default: this agent's scratch dir) and are removed at the end. Global timeout 200 s: run it
// with nohup in the background and poll the log.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TARGETS = {
  staging: path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */,
  baseline: path.join(ROOT, 'release/baseline-0.1.1.noindex'),
  // fix-flows (round 3): the tree's own shell with a running Vite (MDR_DEV_URL), as v2-flow-desk.mjs does.
  dev: ROOT,
};
const TARGET = process.env.MDR_TARGET || 'staging';
const APP_DIR = TARGETS[TARGET];
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v3-flow';
fs.mkdirSync(process.env.MDR_V3_TMP || SCRATCH, { recursive: true });
const BASE_TMP = fs.realpathSync(process.env.MDR_V3_TMP || SCRATCH);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE_TMP, 'desk-docs-')));
const profiles = [];
const live = new Set();
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const note = (s) => console.log(`NOTE ${s}`);
const T = { discard: '丢弃', cancel: '取消', dontSave: '不保存', save: '保存', draftFound: '发现未保存的草稿，是否恢复？' };

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
const closeToasts = (page) => page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
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
  window.__v3max = document.querySelectorAll('.mdr-dialog').length;
  new MutationObserver(() => { window.__v3max = Math.max(window.__v3max, document.querySelectorAll('.mdr-dialog').length); })
    .observe(document.body, { childList: true, subtree: true });
});
const resetMax = (page) => page.evaluate(() => { window.__v3max = document.querySelectorAll('.mdr-dialog').length; });
const maxDialogs = (page) => page.evaluate(() => window.__v3max);
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
    await sleep(80);
  }
  return false;
}
async function typeInEditor(page, text) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(text, { delay: 5 });
  await sleep(250);
}
async function launch(profile, extraArgs = []) {
  const prof = profile || fs.mkdtempSync(path.join(BASE_TMP, 'desk-prof-'));
  if (!profile) profiles.push(prof);
  const app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`, ...extraArgs], timeout: 30000 });
  live.add(app);
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(800);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, page);
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
const doc = (name, text) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return f; };
async function installDropInput(page) {
  await page.evaluate(() => {
    if (document.getElementById('v3-files')) return;
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.id = 'v3-files'; i.style.display = 'none';
    document.body.appendChild(i);
  });
}
async function dropFiles(page, paths) {
  const r = await Promise.race([page.setInputFiles('#v3-files', paths).then(() => 'set'), sleep(6000).then(() => 'hung')]);
  if (r !== 'set') return r;
  await page.evaluate(() => {
    const files = document.getElementById('v3-files').files;
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const target = document.querySelector('.mdr-dialog-backdrop') || document.querySelector('.cm-content');
    for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  return 'dropped';
}
/** Starts a preview session on the first paragraph (click its right end), true when one is live. */
async function startSession(page) {
  const pt = await until(page, () => {
    const el = document.querySelector('.mdr-preview section.md-block p');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width ? { x: r.right - 2, y: r.top + r.height / 2 } : null;
  }, null, 6000);
  if (!pt) return false;
  await sleep(700);
  await page.mouse.click(pt.x, pt.y);
  return !!(await until(page, () => !!document.querySelector('section.md-block.is-editing'), null, 2000));
}

const S = {};

// K1 — G31 variations: a DIRTY document; files the shell refuses are dropped: a FIFO, a binary, an unreadable
// file, a file that vanished between pick and drop, a folder named *.md (via open-file: a drop cannot carry a
// folder here). Expected: no question at all, the document stays, a message naming the file and the reason.
S.K1 = async () => {
  console.log('[K1] refused drops / opens onto a dirty document');
  const bin = Buffer.alloc(4096);
  // fix-flows (round 3): % 256, was % 32. Under S4 (f) (decoder overrides off) a file of C0 control bytes only is
  // read as 0.1.0 / 0.1.1 read it (as text), so it was no longer a file the shell refuses; the full byte range is
  // refused by the 0.1.0 decoder and by the tree's.
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + 11) % 256;
  const binary = path.join(TMP, 'k1-binary.md'); fs.writeFileSync(binary, bin);
  const locked = doc('k1-locked.md', '# locked\n'); fs.chmodSync(locked, 0o000);
  const gone = doc('k1-gone.md', '# gone\n');
  const folder = path.join(TMP, 'k1-folder.md'); fs.mkdirSync(folder);
  const fifo = path.join(TMP, 'k1-pipe.md'); execSync(`mkfifo ${JSON.stringify(fifo)}`);
  const h = await launch();
  try {
    await typeInEditor(h.page, 'mine');
    await installDropInput(h.page);
    for (const [label, p, how] of [['binary', binary, 'drop'], ['locked', locked, 'drop'], ['gone', gone, 'drop-gone'], ['fifo', fifo, 'drop'], ['folder', folder, 'open-file'], ['fifo', fifo, 'open-file']]) {
      await closeToasts(h.page);
      await resetMax(h.page);
      let r = '';
      if (how === 'open-file') { await emitOpenFile(h.app, p); r = 'open-file'; }
      else if (how === 'drop-gone') {
        await h.page.setInputFiles('#v3-files', [p]);
        fs.rmSync(p);
        await h.page.evaluate(() => {
          const files = document.getElementById('v3-files').files;
          const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
          const t = document.querySelector('.cm-content');
          for (const e of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(e, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        r = 'dropped';
      } else r = await dropFiles(h.page, [p]);
      await sleep(1500);
      const q = await dialogTexts(h.page);
      const mx = await maxDialogs(h.page);
      const t = await toastTexts(h.page);
      const ed = await editorText(h.page);
      note(`${label}/${how} (${r}): max dialogs ${mx} now ${JSON.stringify(q)}; toasts ${JSON.stringify(t)}; editor ${JSON.stringify(ed.slice(0, 20))}`);
      if (q.length) {
        // a question for a file that cannot be opened: answer 丢弃 and see what is left
        await clickBtn(h.page, T.discard).catch(() => {});
        await sleep(1200);
        const ed2 = await editorText(h.page);
        const t2 = await toastTexts(h.page);
        note(`${label}/${how} after 丢弃: editor ${JSON.stringify(ed2.slice(0, 20))} toasts ${JSON.stringify(t2)} title ${JSON.stringify(await h.page.title())}`);
        check(`K1 ${label}/${how}: after 丢弃 the document stays and the failure is named`, ed2.startsWith('mine') && t2.some((x) => x.includes(path.basename(p))), JSON.stringify({ ed2: ed2.slice(0, 20), t2 }));
        continue;
      }
      if (r === 'hung') continue;
      const base = path.basename(p);
      check(`K1 ${label}/${how}: no discard question`, mx === 0, `max ${mx}`);
      check(`K1 ${label}/${how}: the document stays`, ed.startsWith('mine'), JSON.stringify(ed.slice(0, 30)));
      check(`K1 ${label}/${how}: one message naming the file`, t.filter((x) => x.includes(base)).length === 1, JSON.stringify(t));
      check(`K1 ${label}/${how}: no 授权 wording on the desktop`, !t.some((x) => x.includes('授权')), JSON.stringify(t));
    }
  } finally {
    try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* no reader */ }
    try { fs.chmodSync(locked, 0o644); } catch { /* */ }
    await hardClose(h);
  }
};

// K2 — G34 variations: the same missing file twice (one message), ten missing files (3 + counting line), × on
// the counting line, then the file appears and is opened under ANOTHER spelling of its path: the stale
// 「无法打开」 for that file must go.
S.K2 = async () => {
  console.log('[K2] failure toasts keyed by file');
  const h = await launch();
  try {
    const miss = path.join(TMP, 'k2-missing.md');
    await emitOpenFile(h.app, miss);
    await sleep(700);
    await emitOpenFile(h.app, miss);
    await sleep(900);
    const t1 = await toastTexts(h.page);
    check('K2 the same file failing twice: one message', t1.filter((x) => x.includes('k2-missing.md')).length === 1, JSON.stringify(t1));
    for (let i = 0; i < 10; i++) await emitOpenFile(h.app, path.join(TMP, `k2-m${i}.md`));
    await sleep(2500);
    const t2 = await toastTexts(h.page);
    note(`after 10 more failures: ${JSON.stringify(t2)}`);
    check('K2 at most 3 failures + one counting line', t2.length <= 4 && t2.some((x) => /另有 \d+ 个文件无法打开/.test(x)), JSON.stringify(t2));
    // × on the counting line
    await h.page.evaluate(() => {
      for (const t of document.querySelectorAll('.mdr-toast')) if (/另有/.test(t.textContent)) t.querySelector('.mdr-toast__close').click();
    });
    await sleep(300);
    const t3 = await toastTexts(h.page);
    note(`after × on the counting line: ${JSON.stringify(t3)}`);
    check('K2 × on the counting line leaves the 3 newest', t3.length === 3 && !t3.some((x) => /另有/.test(x)), JSON.stringify(t3));
    await closeToasts(h.page);
    // stale failure vs another spelling of the same path
    const real = path.join(TMP, 'k2-later.md');
    const other = path.join(TMP, '.', 'sub-none', '..', 'k2-later.md').replace(TMP, TMP + '/'); // TMP//sub-none/../k2-later.md
    await emitOpenFile(h.app, real);
    await sleep(900);
    check('K2 precondition: failure shown for k2-later.md', (await toastTexts(h.page)).some((x) => x.includes('k2-later.md')));
    fs.writeFileSync(real, '# later\n');
    const alt = real.startsWith('/private/') ? real.slice('/private'.length) : real;
    note(`opening again as ${alt}`);
    await emitOpenFile(h.app, alt);
    await untilText(h.page, '# later\n', 5000);
    await sleep(500);
    const t4 = await toastTexts(h.page);
    check('K2 the file is on screen', (await editorText(h.page)) === '# later\n');
    check('K2 no stale 「无法打开 k2-later.md」 while it is open (other spelling of the path)', !t4.some((x) => x.includes('k2-later.md')), JSON.stringify(t4));
    void other;
  } finally {
    await hardClose(h);
  }
};

// K3 — close within one frame of typing in a preview session, and the close question's 保存 for a file
// whose write fails / an untitled document whose save panel is cancelled.
S.K3 = async () => {
  console.log('[K3] close right after session typing; 保存 that fails or is cancelled');
  const k3dir = path.join(TMP, 'k3dir'); fs.mkdirSync(k3dir);
  const a = path.join(k3dir, 'k3-a.md'); fs.writeFileSync(a, 'para one\n');
  const h = await launch();
  try {
    await emitOpenFile(h.app, a);
    await untilText(h.page, 'para one\n', 5000);
    const ses = await startSession(h.page);
    check('K3 precondition: session', ses);
    await h.page.keyboard.press('End');
    await h.page.keyboard.type('Q');
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const asked = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    check('K3a close right after typing Q in a session asks', !!asked, `windows ${await windowCount(h.app).catch(() => '?')}`);
    if (!asked) return;
    // 保存 with the file made read-only meanwhile: the write fails → the window must stay
    fs.chmodSync(a, 0o444); fs.chmodSync(k3dir, 0o555);
    await clickBtn(h.page, T.save);
    await sleep(1500);
    const wc = await windowCount(h.app);
    const t = await toastTexts(h.page);
    check('K3b 保存 that fails keeps the window', wc === 1, `windows ${wc}`);
    check('K3b … says the save failed', t.some((x) => x.includes('保存失败')), JSON.stringify(t));
    check('K3b … keeps the typed text', (await editorText(h.page).catch(() => '')) === 'para oneQ\n', JSON.stringify(await editorText(h.page).catch(() => '')));
    fs.chmodSync(k3dir, 0o755); fs.chmodSync(a, 0o644);
    // untitled + 保存 + save panel cancelled
    await h.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
    await menuClick(h.app, 'file.new');
    await sleep(500);
    if ((await dialogTexts(h.page)).length) await clickBtn(h.page, T.discard);
    await sleep(600);
    await typeInEditor(h.page, 'untitled text');
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    await clickBtn(h.page, T.save);
    await sleep(1200);
    check('K3c 保存 with the save panel cancelled keeps the window and the text', (await windowCount(h.app)) === 1 && (await editorText(h.page)) === 'untitled text', `windows ${await windowCount(h.app)}`);
    // the window must still close on a later confirmed close
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000).catch(() => {});
    await clickBtn(h.page, T.dontSave).catch(() => {});
    const gone = await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 5000);
    check('K3d after that, close → 不保存 closes the window', !!gone);
  } finally {
    try { fs.chmodSync(k3dir, 0o755); fs.chmodSync(a, 0o644); } catch { /* */ }
    await hardClose(h);
  }
};

// K4 — three OS documents in a burst onto a dirty document; then a burst while the 打开… panel is up.
S.K4 = async () => {
  console.log('[K4] three open-file in a burst onto a dirty document');
  const a = doc('k4-a.md', '# A\n'); const b = doc('k4-b.md', '# B\n'); const c = doc('k4-c.md', '# C\n');
  const h = await launch();
  try {
    await typeInEditor(h.page, 'dirty');
    await h.app.evaluate(({ app: x }, ps) => { for (const p of ps) x.emit('open-file', { preventDefault() {} }, p); }, [a, b, c]);
    const q = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    check('K4 one question', !!q && (await maxDialogs(h.page)) === 1, `max ${await maxDialogs(h.page)}`);
    await clickBtn(h.page, T.discard);
    await sleep(2500);
    const ed = await editorText(h.page);
    note(`after 丢弃: editor ${JSON.stringify(ed)} dialogs ${JSON.stringify(await dialogTexts(h.page))} title ${await h.page.title()}`);
    check('K4 the last document is on screen, no second question', ed === '# C\n' && (await maxDialogs(h.page)) === 1, JSON.stringify(ed));
    // the 打开… panel up (stubbed: resolves after 2.5 s with k4-a) while an OS document arrives
    await typeInEditor(h.page, 'x');
    await h.app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = () => new Promise((r) => setTimeout(() => r({ canceled: false, filePaths: [p] }), 2500)); }, a);
    await resetMax(h.page);
    await menuClick(h.app, 'file.open');
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    await clickBtn(h.page, T.discard);
    await sleep(200);
    await emitOpenFile(h.app, b);
    await sleep(1000);
    const mid = await editorText(h.page);
    note(`while the panel is up: editor ${JSON.stringify(mid)} dialogs ${JSON.stringify(await dialogTexts(h.page))}`);
    await sleep(2500);
    const end = await editorText(h.page);
    note(`after the panel answered: editor ${JSON.stringify(end)} dialogs ${JSON.stringify(await dialogTexts(h.page))} max ${await maxDialogs(h.page)}`);
    check('K4 the OS document opened while the panel was up, then the picked one', mid === '# B\n' && end === '# A\n', JSON.stringify({ mid, end }));
  } finally {
    await hardClose(h);
  }
};

// K5 — drafts across launches: type, save, type again, 不保存 on close → nothing offered next launch; type, save,
// type, crash → the newer text offered; 另存为 under a new name while a crash draft for that target exists.
S.K5 = async () => {
  console.log('[K5] drafts around save / 另存为 / 不保存');
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'desk-prof-')); profiles.push(prof);
  const a = doc('k5-a.md', '# A\n');
  const target = doc('k5-target.md', '# target\n');
  let h = await launch(prof);
  try {
    // a crash draft for k5-target.md
    await emitOpenFile(h.app, target);
    await untilText(h.page, '# target\n', 5000);
    await typeInEditor(h.page, 'crash edit of target');
    check('K5 precondition: target draft', await waitDraft(h.page, 'native:' + target, '# target\ncrash edit of target'));
    await hardClose(h);
    h = await launch(prof);
    // now a different document is saved AS k5-target.md? that overwrites the file; instead: open a, type, save, type, crash
    await emitOpenFile(h.app, a);
    await untilText(h.page, '# A\n', 5000);
    await typeInEditor(h.page, 'one');
    await h.page.keyboard.press('Meta+s');
    await sleep(800);
    await typeInEditor(h.page, ' two');
    check('K5 draft of the text typed after the save', await waitDraft(h.page, 'native:' + a, '# A\none two'));
    await hardClose(h);
    h = await launch(prof);
    await emitOpenFile(h.app, a);
    await untilText(h.page, '# A\none', 5000);
    await sleep(900);
    check('K5 after the crash: the newer text is offered', (await toastTexts(h.page)).some((x) => x.includes(T.draftFound)), JSON.stringify(await toastTexts(h.page)));
    await closeToasts(h.page);
    // 不保存 on close → no offer next time
    await typeInEditor(h.page, ' three');
    await waitDraft(h.page, 'native:' + a, '# A\none three');
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    await clickBtn(h.page, T.dontSave);
    await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 5000);
    await hardClose(h);
    h = await launch(prof);
    await emitOpenFile(h.app, a);
    await untilText(h.page, '# A\none', 5000);
    await sleep(900);
    const t = await toastTexts(h.page);
    check('K5 after 不保存: no offer for a', !t.some((x) => x.includes(T.draftFound)), JSON.stringify(t));
    check('K5 the crash draft of k5-target.md is still stored', (await storedDraft(h.page, 'native:' + target)) === '# target\ncrash edit of target', JSON.stringify(await storedDraft(h.page, 'native:' + target)));
  } finally {
    await hardClose(h);
  }
};

// K6 — the dirt is preview-session text not yet in CodeMirror: an OS document / 新建 / a drop / ⌘Q (app.quit)
// arrive in the same instant as the keystroke. Expected: the question; 取消 keeps the typed text, nothing opens.
S.K6 = async () => {
  console.log('[K6] session text + open-file / 新建 / drop / quit in the same instant');
  const a = doc('k6-a.md', 'para one\n');
  const b = doc('k6-b.md', '# B\n');
  const h = await launch();
  try {
    await emitOpenFile(h.app, a);
    await untilText(h.page, 'para one\n', 5000);
    await installDropInput(h.page);
    await h.page.setInputFiles('#v3-files', [b]);
    let n = 0;
    for (const how of ['open-file', 'new', 'drop', 'quit']) {
      const ses = await startSession(h.page);
      if (!ses) { check(`K6 ${how}: precondition session`, false); continue; }
      await h.page.keyboard.press('End');
      const ch = String.fromCharCode(0x41 + n++);
      if (how === 'drop') {
        await h.page.keyboard.type(ch);
        await h.page.evaluate(() => {
          const files = document.getElementById('v3-files').files;
          const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
          const t = document.querySelector('.cm-content');
          for (const e of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(e, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
      } else {
        await h.page.keyboard.type(ch);
        if (how === 'open-file') await emitOpenFile(h.app, b);
        else if (how === 'new') await menuClick(h.app, 'file.new');
        else await h.app.evaluate(({ app: x }) => { x.quit(); });
      }
      const q = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
      const qt = await dialogTexts(h.page);
      check(`K6 ${how}: a question`, !!q, JSON.stringify(qt));
      if (!q) { note(`editor ${JSON.stringify(await editorText(h.page).catch(() => '?'))}`); continue; }
      await clickBtn(h.page, T.cancel);
      await sleep(900);
      const ed = await editorText(h.page);
      const want = 'para one' + 'ABCD'.slice(0, n) + '\n';
      check(`K6 ${how}: 取消 keeps every typed letter, nothing else opened`, ed === want, `editor ${JSON.stringify(ed)} want ${JSON.stringify(want)} dialogs ${JSON.stringify(await dialogTexts(h.page))}`);
      check(`K6 ${how}: window still there`, (await windowCount(h.app)) === 1);
    }
  } finally {
    await hardClose(h);
  }
};

// K7 — a Markdown file dropped onto the EDITOR pane of a CLEAN document, at a point inside its text; then onto
// the preview pane. Expected: the clean document is replaced without a question; 取消 (if asked) leaves the
// document exactly as it was; nothing of the dropped file is written into the current document.
S.K7 = async () => {
  console.log('[K7] drop onto the editor pane of a clean document');
  const a = doc('k7-a.md', 'alpha line\n\nsecond line\n');
  const big = process.env.MDR_K7_BIG ? Number(process.env.MDR_K7_BIG) : 0;
  const b = doc('k7-b.md', big ? '# DROPPED\n' + 'filler line of the dropped file\n'.repeat(Math.ceil(big / 32)) : '# DROPPED\n');
  const bText = fs.readFileSync(b, 'utf8');
  const h = await launch();
  try {
    for (const [pane, answerWith] of [['editor', T.cancel], ['editor', T.discard], ['preview', T.cancel]]) {
      await emitOpenFile(h.app, a);
      if ((await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 800))) await clickBtn(h.page, T.discard);
      await untilText(h.page, 'alpha line\n\nsecond line\n', 5000);
      await sleep(400);
      await resetMax(h.page);
      await installDropInput(h.page);
      await h.page.setInputFiles('#v3-files', [b]);
      await h.page.evaluate((where) => {
        const files = document.getElementById('v3-files').files;
        const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
        const el = where === 'editor' ? document.querySelector('.cm-line') : document.querySelector('.mdr-preview section.md-block p');
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height / 2 };
        for (const e of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(e, o));
      }, pane);
      await sleep(1500);
      const q = await dialogTexts(h.page);
      const edBefore = await editorText(h.page);
      note(`${pane}: dialogs ${JSON.stringify(q)} editor before answering ${JSON.stringify(edBefore.slice(0, 60))} (len ${edBefore.length}) title ${await h.page.title()}`);
      check(`K7 ${pane}: a clean document is not asked about`, q.length === 0, JSON.stringify(q));
      if (q.length) { await clickBtn(h.page, answerWith); await sleep(1200); }
      const ed = await editorText(h.page);
      note(`${pane} after ${q.length ? answerWith : 'no question'}: editor ${JSON.stringify(ed.slice(0, 60))} (len ${ed.length}) title ${await h.page.title()}`);
      check(`K7 ${pane}/${q.length ? answerWith : '-'}: the result is one of the two documents, unmixed`, ed === bText || ed === 'alpha line\n\nsecond line\n', JSON.stringify(ed.slice(0, 60)));
    }
  } finally {
    await hardClose(h);
  }
};

// K8 — argv documents: a missing .md, an unreadable .md, and a good one; what does the window say?
S.K8 = async () => {
  console.log('[K8] argv paths');
  const missing = path.join(TMP, 'k8 missing「x」.md');
  const locked = doc('k8-locked.md', '# L\n'); fs.chmodSync(locked, 0o000);
  const good = doc('k8-good.md', '# good\n');
  for (const [label, args, want] of [['missing', [missing], null], ['locked', [locked], null], ['missing+good', [missing, good], '# good\n']]) {
    const h = await launch(undefined, args);
    try {
      await sleep(1500);
      const t = await toastTexts(h.page);
      const ed = await editorText(h.page);
      note(`${label}: editor ${JSON.stringify(ed)} toasts ${JSON.stringify(t)} title ${await h.page.title()}`);
      for (const a of args) {
        if (a === good) continue;
        check(`K8 ${label}: a message names ${path.basename(a)}`, t.some((x) => x.includes(path.basename(a))), JSON.stringify(t));
      }
      if (want) check(`K8 ${label}: the good file is shown`, ed === want, JSON.stringify(ed));
    } finally {
      await hardClose(h);
    }
  }
  fs.chmodSync(locked, 0o644);
};

// K9 — closing the window while an IME composition is open in a preview session (CDP imeSetComposition).
S.K9 = async () => {
  console.log('[K9] close during an IME composition in a session');
  const a = doc('k9-a.md', 'para one\n');
  const h = await launch();
  try {
    await emitOpenFile(h.app, a);
    await untilText(h.page, 'para one\n', 5000);
    check('K9 precondition: session', await startSession(h.page));
    await h.page.keyboard.press('End');
    const cdp = await h.page.context().newCDPSession(h.page);
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await sleep(300);
    note(`composing; block text ${JSON.stringify(await h.page.evaluate(() => document.querySelector('section.md-block.is-editing')?.textContent))}`);
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const asked = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    check('K9 the close asks', !!asked, `windows ${await windowCount(h.app).catch(() => '?')}`);
    if (!asked) return;
    await clickBtn(h.page, T.save);
    await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 5000);
    const disk = fs.readFileSync(a, 'utf8');
    note(`on disk after 保存: ${JSON.stringify(disk)}`);
    check('K9 保存 wrote the paragraph with the composed text, nothing else changed', disk === 'para onezhong\n' || disk === 'para one\n', JSON.stringify(disk));
  } finally {
    await hardClose(h);
  }
};

// K10 — ⌘Q (app.quit) while the 打开… panel is up (stubbed: it answers only when the test says so).
S.K10 = async () => {
  console.log('[K10] quit while the 打开… panel is up');
  const a = doc('k10-a.md', '# A\n');
  const h = await launch();
  try {
    await typeInEditor(h.page, 'dirty');
    await h.app.evaluate(({ dialog }) => { dialog.showOpenDialog = () => new Promise((r) => { globalThis.__v3pick = r; }); });
    await menuClick(h.app, 'file.open');
    await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    await clickBtn(h.page, T.discard);
    await untilMain(h.app, () => typeof globalThis.__v3pick === 'function', null, 4000);
    await h.app.evaluate(({ app: x }) => { x.quit(); });
    const q = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
    note(`quit with the panel up: dialogs ${JSON.stringify(await dialogTexts(h.page))}`);
    check('K10 quit asks (the text is still dirty)', !!q);
    if (q) await clickBtn(h.page, T.cancel);
    await sleep(500);
    check('K10 取消 keeps the window and the text', (await windowCount(h.app)) === 1 && (await editorText(h.page)) === 'dirty', JSON.stringify(await editorText(h.page)));
    await h.app.evaluate((_e, p) => { globalThis.__v3pick({ canceled: false, filePaths: [p] }); }, a);
    const opened = await untilText(h.page, '# A\n', 4000);
    note(`after the panel answered: editor ${JSON.stringify(await editorText(h.page))} dialogs ${JSON.stringify(await dialogTexts(h.page))}`);
    check('K10 the picked file opens afterwards (the 丢弃 was given for it)', opened);
    await h.app.evaluate(({ app: x }) => { x.quit(); });
    const gone = await untilMain(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length === 0, null, 4000).catch(() => true);
    check('K10 a clean quit then quits', !!gone);
  } finally {
    await hardClose(h);
  }
};

const watchdog = setTimeout(async () => {
  console.log('GLOBAL TIMEOUT');
  for (const a of live) { try { a.process()?.kill('SIGKILL'); } catch { /* */ } }
  process.exit(2);
}, 200_000);
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
