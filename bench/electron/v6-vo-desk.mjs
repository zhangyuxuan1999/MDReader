// bench/electron/v6-vo-desk.mjs — verify-off (0.2.0 stage 2f, round 5, rules L6 / L9 / L4 on the desktop): beyond
// r5-pl-desk / r5-rl-desk / r4-rel-desk. The main process wraps fs.promises.readFile (the app:// handler's reads) to count
// reads of dist/assets/inlineEdit-*.js and, when asked, to FAIL them with ENOENT (the app replaced on disk while it runs:
// the old chunk name is gone).
//   MDR_APP_DIR=<dir> MDR_VO_TMP=<scratch dir> [MDR_VO_BASE=1] node bench/electron/v6-vo-desk.mjs
//   A. fresh profile, switch off: a document through open-file, a click and a double click in the preview, typing in the
//      editor, a box ticked, the three modes, a reload of the window, the box ticked again: the chunk is never read; the
//      source after the gestures is printed (MDR_VO_BASE=1 runs only A, for the 0.1.1 shell, to compare).
//   B. the TOOLBAR button: the chunk read once, pressed, stored '1', a session types once.
//   C. ⌘⇧E off, toolbar on: no new read.
//   D. restart with '1' stored and the chunk read failing: the editor works, ONE failure toast with the final wording,
//      stored still '1'; the toolbar pressed: fails again, stored '0'.
//   E. restart (reads work again): off, no toast, the chunk not read; ⌘⇧E: read, on, a session types once.
// Launch only through ./_electron.mjs with an explicit profile under MDR_VO_TMP (removed at the end). No full screen.
// Global timeout 110 s. Writes nothing into the tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electron } from './_electron.mjs';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const BASE_ONLY = !!process.env.MDR_VO_BASE;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_VO_TMP || os.tmpdir(), 'v6-vo-desk-')));
const PROFILE = path.join(TMP, 'profile');
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
let app = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { x.exit(0); }), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([a.close().catch(() => {}), sleep(4000)]);
  if (pid) for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { return; } if (i === 10) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const DOC = ['# 桌面复验', '', '- [ ] 甲任务', '- [ ] 乙任务', '', '甲段落文字，用来点击。', '', '乙段落文字，也用来点击。', ''].join(NL);
const FILE = path.join(TMP, 'v6-vo.md');
fs.writeFileSync(FILE, DOC, 'utf8');
const FAILED = '预览编辑功能加载失败，请刷新页面或重启应用后重试';
const BTN = '[data-cmd="view.togglePreviewEdit"]';
const reads = async () => (await app.evaluate(() => globalThis.__voReads.slice())).filter((p) => /inlineEdit-[^/]*\.js$/.test(p)).length;
const st = (page) => page.evaluate((b) => ({
  pressed: document.querySelector(b)?.getAttribute('aria-pressed') ?? null,
  busy: document.querySelector(b)?.getAttribute('aria-busy') ?? null,
  stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } })(),
  editing: document.querySelectorAll('.mdr-preview .is-editing').length,
  ce: document.querySelectorAll('.mdr-preview [contenteditable]').length,
  hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
  src: [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
  toasts: [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent),
}), BTN);
const until = async (fn, ms = 3000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
async function clickText(page, needle, n = 1) {
  const pt = await page.evaluate((t) => {
    const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
    if (!p) return null;
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(w, 2); r.setEnd(w, 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  }, needle);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y, { clickCount: n });
  await sleep(400);
  return true;
}
async function launch() {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  await app.evaluate(() => {
    const fsp = process.getBuiltinModule('node:fs').promises;
    globalThis.__voReads = []; globalThis.__voFail = false;
    const orig = fsp.readFile;
    fsp.readFile = async function (p, ...rest) {
      const s = String(p);
      try { globalThis.__voReads.push(s); } catch { /* */ }
      if (/inlineEdit-[^/]*\.js$/.test(s) && globalThis.__voFail) { const e = new Error('ENOENT: no such file (test)'); e.code = 'ENOENT'; throw e; }
      return orig.call(this, p, ...rest);
    };
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  return page;
}
async function openDoc(page) {
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  return until(() => page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('甲段落'))), 8000);
}
async function session(page, label, needle, typed) {
  await clickText(page, needle);
  const e = await st(page);
  check(`${label}: a session started`, e.editing === 1, JSON.stringify({ e: e.editing }));
  await page.keyboard.type(typed); await sleep(700);
  const s = await st(page);
  check(`${label}: typed text arrived once`, s.src.split(typed).length === 2, s.src.split(NL).find((l) => l.includes(typed)) ?? '');
  await page.keyboard.press('Escape'); await sleep(300);
}
const errors = [];
try {
  let page = await launch();
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await sleep(600);
  // A
  check('A: document shown', await openDoc(page));
  await clickText(page, '甲段落'); await clickText(page, '乙段落', 2);
  // the reload while the document is unmodified (a modified one would ask through beforeunload)
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reloadIgnoringCache(); });
  await sleep(1500);
  page = app.windows()[app.windows().length - 1];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await page.waitForSelector('.cm-content', { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  check('A: document shown after the reload', await openDoc(page));
  await clickText(page, '甲段落');
  await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('桌面输入');
  await sleep(300);
  await page.click('.mdr-preview input[type=checkbox] >> nth=0'); await sleep(500);
  for (const m of ['view.mode.edit', 'view.mode.preview', 'view.mode.split']) { await page.click(`[data-cmd="${m}"]`); await sleep(300); }
  await page.click('.mdr-preview input[type=checkbox] >> nth=1'); await sleep(500);
  let s = await st(page);
  console.log('A source after gestures: ' + JSON.stringify(s.src));
  check('A: switch-off gestures: ticks and typing in the source, no session', s.src.includes('- [x] 甲任务') && s.src.includes('- [x] 乙任务') && s.src.includes('桌面输入') && s.editing === 0 && s.ce === 0, JSON.stringify({ e: s.editing, ce: s.ce }));
  if (!BASE_ONLY) {
    check('A: the chunk was never read (switch off, after a reload too)', (await reads()) === 0, `reads=${await reads()}`);
    check('A: off, nothing stored, no hint', s.pressed === 'false' && s.stored === null && s.hint === 0, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint }));
    // B
    if (!(await page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('甲段落'))))) await openDoc(page);
    await sleep(500);
    await page.click(BTN);
    const on = await until(async () => (await st(page)).pressed === 'true', 5000);
    s = await st(page);
    check('B: toolbar: read once, pressed, stored 1, one hint', on && (await reads()) === 1 && s.stored === '1' && s.hint === 1, JSON.stringify({ reads: await reads(), st: s.stored, h: s.hint }));
    await session(page, 'B', '乙段落', 'BQ');
    // C
    await page.click('.mdr-preview h1'); await page.keyboard.press('Meta+Shift+E'); await sleep(500);
    s = await st(page);
    check('C: ⌘⇧E off: stored 0', s.pressed === 'false' && s.stored === '0', JSON.stringify({ p: s.pressed, st: s.stored }));
    await page.click(BTN); await sleep(400);
    s = await st(page);
    check('C: toolbar on again: immediate, no new read', s.pressed === 'true' && (await reads()) === 1, JSON.stringify({ p: s.pressed, reads: await reads() }));
    await quit();
    // D
    app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
    await app.evaluate(() => {
      const fsp = process.getBuiltinModule('node:fs').promises;
      globalThis.__voReads = []; globalThis.__voFail = true;
      const orig = fsp.readFile;
      fsp.readFile = async function (p, ...rest) {
        const x = String(p); try { globalThis.__voReads.push(x); } catch { /* */ }
        if (/inlineEdit-[^/]*\.js$/.test(x) && globalThis.__voFail) { const e = new Error('ENOENT: no such file (test)'); e.code = 'ENOENT'; throw e; }
        return orig.call(this, p, ...rest);
      };
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    await page.waitForSelector('.cm-content', { timeout: 20000 });
    await sleep(5500);
    s = await st(page);
    check('D: failing chunk at start: one failure toast with the final wording, stored still 1, not pressed, not busy', s.toasts.filter((t) => t === FAILED).length === 1 && s.stored === '1' && s.pressed === 'false' && s.busy === null, JSON.stringify({ toasts: s.toasts, st: s.stored, p: s.pressed, b: s.busy, reads: await reads() }));
    await page.click('.cm-content'); await page.keyboard.type('仍可输入'); await sleep(300);
    check('D: the editor works', (await st(page)).src.includes('仍可输入'));
    const r0 = await reads();
    await page.click(BTN); await sleep(1500);
    s = await st(page);
    check('D: a toolbar press fails again: stored 0, not pressed', s.stored === '0' && s.pressed === 'false' && s.busy === null, JSON.stringify({ st: s.stored, p: s.pressed, newReads: (await reads()) - r0, toasts: s.toasts }));
    await quit();
    // E
    page = await launch();
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    await sleep(5500);
    s = await st(page);
    check('E: next start: off, no failure toast, chunk not read', s.pressed === 'false' && !s.toasts.includes(FAILED) && (await reads()) === 0, JSON.stringify({ p: s.pressed, toasts: s.toasts, reads: await reads() }));
    await openDoc(page); await sleep(400);
    await page.click('.mdr-preview h1'); await page.keyboard.press('Meta+Shift+E');
    const on2 = await until(async () => (await st(page)).pressed === 'true', 5000);
    check('E: ⌘⇧E: read once, on', on2 && (await reads()) === 1, `reads=${await reads()}`);
    await session(page, 'E', '甲段落', 'EQ');
  }
  check('no page error', errors.length === 0, JSON.stringify(errors));
} catch (e) {
  check('ran', false, String(e.message).split(NL)[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`RESULT ${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
