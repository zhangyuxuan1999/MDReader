// bench/electron/v4-flow-desk.mjs — verify-flows (round-3 re-verification): U17 file drops on the DESKTOP with
// TRUSTED drags (CDP Input.dispatchDragEvent with real file paths, as a Finder drag delivers them), plus an OS
// document arriving together with a drop. The same script runs candidate, baseline and the dev shell:
//   MDR_TARGET=staging  node bench/electron/v4-flow-desk.mjs [E1 E2 …]   # release/staging-0.2.0.noindex
//   MDR_TARGET=baseline node bench/electron/v4-flow-desk.mjs [E1 …]      # release/baseline-0.1.1.noindex
//   MDR_TARGET=dev MDR_DEV_URL=http://localhost:5434/ node bench/electron/v4-flow-desk.mjs [E1 …]
// Launches only through ./_electron.mjs (isolated profile). Never full screen. Temp documents and profiles go
// to MDR_V4_TMP (default: this agent's scratch dir) and are removed at the end. Global timeout 110 s.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TARGETS = { staging: path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */, baseline: path.join(ROOT, 'release/baseline-0.1.1.noindex'), dev: ROOT };
const TARGET = process.env.MDR_TARGET || 'staging';
const APP_DIR = TARGETS[TARGET];
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRATCH = '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v4-flow';
fs.mkdirSync(process.env.MDR_V4_TMP || SCRATCH, { recursive: true });
const BASE_TMP = fs.realpathSync(process.env.MDR_V4_TMP || SCRATCH);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(BASE_TMP, 'desk-docs-')));
const profiles = [];
const live = new Set();
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const note = (s) => console.log(`NOTE ${s}`);

async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await page.evaluate(fn, arg).catch(() => undefined); if (last) return last; await sleep(80); }
  return last;
}
const editorText = (page) => page.evaluate(() => {
  const c = document.querySelector('.cm-content');
  const v = c && c.cmView && c.cmView.view;
  return v ? v.state.doc.toString() : [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
});
const dialogTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
const closeToasts = (page) => page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const clickBtn = (page, l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const watchDialogs = (page) => page.evaluate(() => {
  window.__v4max = document.querySelectorAll('.mdr-dialog').length;
  new MutationObserver(() => { window.__v4max = Math.max(window.__v4max, document.querySelectorAll('.mdr-dialog').length); }).observe(document.body, { childList: true, subtree: true });
});
const resetMax = (page) => page.evaluate(() => { window.__v4max = document.querySelectorAll('.mdr-dialog').length; });
const maxDialogs = (page) => page.evaluate(() => window.__v4max);
const doc = (name, text) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return f; };
async function untilText(page, want, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await editorText(page).catch(() => null)) === want) return true; await sleep(80); }
  return false;
}
async function launch(given) {
  const prof = given || fs.mkdtempSync(path.join(BASE_TMP, 'desk-prof-'));
  if (!given) profiles.push(prof);
  const app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  live.add(app);
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(1200);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, page);
  await watchDialogs(page);
  return { app, page };
}
async function hardClose(h) {
  if (!h) return;
  live.delete(h.app);
  const pid = (() => { try { return h.app.process()?.pid; } catch { return undefined; } })();
  try { await h.app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* gone */ }
  await Promise.race([h.app.close().catch(() => {}), sleep(4000)]);
  if (pid) for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { return; } if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
}
async function openDoc(h, p, text) {
  await emitOpenFile(h.app, p);
  if (await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 800)) await clickBtn(h.page, '丢弃');
  const ok = await untilText(h.page, text, 5000);
  await sleep(500);
  await closeToasts(h.page);
  await resetMax(h.page);
  return ok;
}
const pointOf = (page, sel, fx = 0.5, fy = 0.5) => page.evaluate(([s, x, y]) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * x, y: r.top + r.height * y };
}, [sel, fx, fy]);
async function trustedDrop(page, pt, files, items = []) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data: { items, files, dragOperationsMask: 1 | 2 | 16 } });
  } finally { await cdp.detach().catch(() => {}); }
}
async function typeEnd(page, s) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(s, { delay: 5 });
  await sleep(300);
}

const S = {};
const A_TEXT = 'alpha line\n\nsecond line\n';
// E1 — trusted drop on an editor line / the gutter / the preview of a CLEAN document.
S.E1 = async () => {
  const a = doc('e1-a.md', A_TEXT);
  const b = doc('e1-b.md', '# E1 DROPPED\n');
  const h = await launch();
  try {
    for (const [where, sel, fx] of [['line', '.cm-line', 0.15], ['gutter', '.cm-gutters', 0.5], ['preview', '.mdr-preview section.md-block p', 0.5], ['uri+file preview', '.mdr-preview section.md-block p', 0.5]]) {
      if (!(await openDoc(h, a, A_TEXT))) { check(`E1 ${where}: precondition`, false); continue; }
      const pt = await pointOf(h.page, sel, fx, 0.3);
      await trustedDrop(h.page, pt, [b], where.startsWith('uri') ? [{ mimeType: 'text/uri-list', data: 'file://' + b }, { mimeType: 'text/plain', data: b }] : []);
      await sleep(1500);
      const ed = await editorText(h.page);
      const q = await dialogTexts(h.page);
      note(`E1 ${where}: editor ${JSON.stringify(ed)} dialogs ${JSON.stringify(q)} title ${await h.page.title()} toasts ${JSON.stringify(await toastTexts(h.page))}`);
      check(`E1 ${where}: the dropped file opens, no question, nothing mixed`, ed === '# E1 DROPPED\n' && q.length === 0, JSON.stringify(ed));
      if (q.length) await clickBtn(h.page, '取消');
    }
  } finally { await hardClose(h); }
};
// E2 — dirty document, drop on the gutter, 取消: the document is byte-for-byte what the user typed; ⌘S then
// writes exactly that (nothing of the dropped file).
S.E2 = async () => {
  const a = doc('e2-a.md', A_TEXT);
  const b = doc('e2-b.md', '# E2 DROPPED\n');
  const h = await launch();
  try {
    if (!(await openDoc(h, a, A_TEXT))) return check('E2 precondition', false);
    await typeEnd(h.page, 'typed');
    for (const sel of ['.cm-gutters', '.cm-line', '.mdr-statusbar', '.mdr-toolbar']) {
      const pt = await pointOf(h.page, sel, 0.5, 0.4);
      await trustedDrop(h.page, pt, [b]);
      await sleep(1300);
      const q = await dialogTexts(h.page);
      const during = await editorText(h.page);
      if (q.length) await clickBtn(h.page, '取消');
      await sleep(500);
      const ed = await editorText(h.page);
      check(`E2 ${sel}: asked once, 取消 keeps the typed text exactly`, q.length === 1 && during === A_TEXT + 'typed' && ed === A_TEXT + 'typed', `q ${JSON.stringify(q)} during ${JSON.stringify(during)} after ${JSON.stringify(ed)}`);
    }
    check('E2 never two questions at once', (await maxDialogs(h.page)) <= 1);
    await h.page.keyboard.press('Meta+s');
    await sleep(1200);
    check('E2 ⌘S writes only the typed text', fs.readFileSync(a, 'utf8') === A_TEXT + 'typed', JSON.stringify(fs.readFileSync(a, 'utf8')));
  } finally { await hardClose(h); }
};
// E3 — dirty document, a dropped .md the shell refuses (no read permission; a FIFO): a toast that names it,
// no question, the document unchanged.
S.E3 = async () => {
  const a = doc('e3-a.md', A_TEXT);
  const locked = doc('e3-locked.md', '# L\n');
  fs.chmodSync(locked, 0o000);
  const fifo = path.join(TMP, 'e3-pipe.md');
  execSync(`mkfifo ${JSON.stringify(fifo)}`);
  const h = await launch();
  try {
    if (!(await openDoc(h, a, A_TEXT))) return check('E3 precondition', false);
    await typeEnd(h.page, 'X');
    for (const [label, f] of [['locked', locked], ['fifo', fifo]]) {
      await closeToasts(h.page);
      const pt = await pointOf(h.page, '.cm-line', 0.2, 0.5);
      await trustedDrop(h.page, pt, [f]);
      await sleep(1800);
      const q = await dialogTexts(h.page);
      const t = await toastTexts(h.page);
      const ed = await editorText(h.page);
      note(`E3 ${label}: dialogs ${JSON.stringify(q)} toasts ${JSON.stringify(t)} editor ${JSON.stringify(ed)}`);
      if (q.length) await clickBtn(h.page, '取消');
      check(`E3 ${label}: no question, a toast naming the file, the document unchanged`, q.length === 0 && t.some((x) => x.includes(path.basename(f))) && ed === A_TEXT + 'X', JSON.stringify({ q, t }));
    }
  } finally { await hardClose(h); try { fs.chmodSync(locked, 0o644); } catch { /* */ } }
};
// E4 — dirty document; a drop and an OS document (open-file) in the same instant. One question at a time;
// each request answered once; the final document is one of the two, unmixed; the first document's disk bytes
// unchanged.
S.E4 = async () => {
  const a = doc('e4-a.md', A_TEXT);
  const b = doc('e4-b.md', '# E4 DROPPED\n');
  const c = doc('e4-c.md', '# E4 OS DOC\n');
  const h = await launch();
  try {
    for (const order of ['drop-first', 'os-first']) {
      if (!(await openDoc(h, a, A_TEXT))) { check(`E4 ${order}: precondition`, false); continue; }
      await typeEnd(h.page, 'Y');
      await h.page.evaluate(() => { window.__titles = []; clearInterval(window.__tl); window.__tl = setInterval(() => { const t = document.title; if (window.__titles[window.__titles.length - 1] !== t) window.__titles.push(t); }, 20); window.__sawOs = false; new MutationObserver(() => { if ((document.querySelector('.cm-content')?.textContent || '').includes('E4 OS DOC')) window.__sawOs = true; }).observe(document.querySelector('.cm-content'), { childList: true, subtree: true, characterData: true }); });
      const pt = await pointOf(h.page, '.cm-line', 0.2, 0.5);
      if (order === 'drop-first') await Promise.all([trustedDrop(h.page, pt, [b]), emitOpenFile(h.app, c)]);
      else await Promise.all([emitOpenFile(h.app, c), trustedDrop(h.page, pt, [b])]);
      let answered = 0;
      for (let i = 0; i < 4; i++) {
        await sleep(900);
        const q = await dialogTexts(h.page);
        if (!q.length) break;
        answered++;
        await clickBtn(h.page, '丢弃');
      }
      await sleep(900);
      const ed = await editorText(h.page);
      const title = await h.page.title();
      note(`E4 ${order}: answered ${answered}, editor ${JSON.stringify(ed)} title ${title} max dialogs ${await maxDialogs(h.page)} titles seen ${JSON.stringify(await h.page.evaluate(() => window.__titles))} OS doc ever in the editor ${await h.page.evaluate(() => window.__sawOs)}`);
      check(`E4 ${order}: one question, one answer, the last request's document shown`, answered === 1 && (ed === '# E4 DROPPED\n' || ed === '# E4 OS DOC\n') && (await maxDialogs(h.page)) <= 1, JSON.stringify({ answered, ed }));
      check(`E4 ${order}: the first document on disk unchanged`, fs.readFileSync(a, 'utf8') === A_TEXT);
    }
  } finally { await hardClose(h); }
};
// E5 — the only change is typing in a preview session; a file dropped on that session; 丢弃: the dropped file
// opens and none of the session's text goes into it; 取消 keeps the typed text.
S.E5 = async () => {
  const a = doc('e5-a.md', 'para one\n\npara two\n');
  const b = doc('e5-b.md', '# E5 DROPPED\n');
  const h = await launch();
  try {
    for (const ans of ['取消', '丢弃']) {
      if (!(await openDoc(h, a, 'para one\n\npara two\n'))) { check(`E5 ${ans}: precondition`, false); continue; }
      const pt = await until(h.page, () => { const el = document.querySelectorAll('.mdr-preview section.md-block p')[1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.right - 3, y: r.top + r.height / 2 }; }, null, 4000);
      await sleep(700);
      await h.page.mouse.click(pt.x, pt.y);
      await sleep(500);
      const live = await h.page.evaluate(() => !!document.querySelector('.mdr-preview [contenteditable="true"]'));
      await h.page.keyboard.press('End');
      await h.page.keyboard.type('S');
      await trustedDrop(h.page, pt, [b]);
      await sleep(1500);
      const q = await dialogTexts(h.page);
      if (q.length) await clickBtn(h.page, ans);
      await sleep(1200);
      const ed = await editorText(h.page);
      note(`E5 ${ans}: live ${live} dialogs ${JSON.stringify(q)} editor ${JSON.stringify(ed)}`);
      const want = ans === '取消' ? 'para one\n\npara twoS\n' : '# E5 DROPPED\n';
      check(`E5 ${ans}: asked once; the result is exactly ${JSON.stringify(want)}`, q.length === 1 && ed === want, JSON.stringify(ed));
      if (ans === '取消') { await h.page.keyboard.press('Escape'); await sleep(300); }
    }
    check('E5 the first document on disk unchanged', fs.readFileSync(a, 'utf8') === 'para one\n\npara two\n');
  } finally { await hardClose(h); }
};

const storedRec = (page, id) => page.evaluate(async (docId) => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return null;
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => { const db = r.result; try { const g = db.transaction('keyval', 'readonly').objectStore('keyval').getAll(); g.onsuccess = () => { res(g.result.filter((x) => x && x.text !== undefined).map((x) => ({ docId: x.docId, text: x.text }))); db.close(); }; } catch { res(null); db.close(); } };
    r.onerror = () => res(null);
  });
}, id);
async function kill(h) {
  live.delete(h.app);
  try { h.app.process().kill('SIGKILL'); } catch { /* */ }
  await sleep(1500);
}
const offerShown = (page, ms = 5000) => until(page, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')), null, ms);
// E6 — H5 on the desktop through a REAL kill: crash text stored; relaunch, offer; type and take it back; kill;
// relaunch: the crash text must still be offered. E7 — the same with the untitled scratch buffer (the offer
// comes after the launch-settle wait).
S.E6 = async () => {
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'desk-prof-')); profiles.push(prof);
  const d = doc('e6.md', 'orig\n');
  let h = await launch(prof);
  await openDoc(h, d, 'orig\n');
  await typeEnd(h.page, ' crash');
  await sleep(2200);
  note(`E6 L1 stored ${JSON.stringify(await storedRec(h.page))}`);
  await kill(h);
  h = await launch(prof);
  try {
    await emitOpenFile(h.app, d);
    const off = await offerShown(h.page);
    check('E6 L2: the crash text is offered', !!off, JSON.stringify(await toastTexts(h.page)));
    await typeEnd(h.page, 'x');
    await h.page.keyboard.press('Backspace');
    await sleep(2200);
    const rec = await storedRec(h.page);
    note(`E6 L2 after x+Backspace: editor ${JSON.stringify(await editorText(h.page))} stored ${JSON.stringify(rec)}`);
    check('E6 L2: the stored draft is still the crash text', !!rec && rec.some((r) => r.text === 'orig\n crash'), JSON.stringify(rec));
  } finally { await kill(h); }
  h = await launch(prof);
  try {
    await emitOpenFile(h.app, d);
    const off = await offerShown(h.page);
    check('E6 L3: the next launch still offers the crash text', !!off, JSON.stringify(await toastTexts(h.page)));
  } finally { await hardClose(h); }
};
S.E7 = async () => {
  const prof = fs.mkdtempSync(path.join(BASE_TMP, 'desk-prof-')); profiles.push(prof);
  let h = await launch(prof);
  await typeEnd(h.page, 'untitled crash');
  await sleep(2200);
  note(`E7 L1 stored ${JSON.stringify(await storedRec(h.page))}`);
  await kill(h);
  h = await launch(prof);
  try {
    const off = await offerShown(h.page, 6000);
    check('E7 L2: the untitled crash text is offered', !!off, JSON.stringify(await toastTexts(h.page)));
    await typeEnd(h.page, 'x');
    await h.page.keyboard.press('Backspace');
    await sleep(2200);
    const rec = await storedRec(h.page);
    note(`E7 L2 after x+Backspace: editor ${JSON.stringify(await editorText(h.page))} stored ${JSON.stringify(rec)}`);
    check('E7 L2: the stored draft is still the crash text', !!rec && rec.some((r) => r.text === 'untitled crash'), JSON.stringify(rec));
  } finally { await kill(h); }
  h = await launch(prof);
  try {
    const off = await offerShown(h.page, 6000);
    check('E7 L3: the next launch still offers the crash text', !!off, JSON.stringify(await toastTexts(h.page)));
  } finally { await hardClose(h); }
};

const watchdog = setTimeout(() => {
  console.log('GLOBAL TIMEOUT');
  for (const a of live) { try { a.process()?.kill('SIGKILL'); } catch { /* */ } }
  process.exit(2);
}, 110_000);
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
