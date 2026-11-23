// bench/electron/r5-rl-desk.mjs — review-lazy (0.2.0 stage 2f, rule L9 attack): the desktop shell and the editing chunk
// loaded on demand, beyond bench/electron/r5-pl-desk.mjs. The main process wraps the app:// handler's fs.promises.readFile
// (counts reads of dist/assets/inlineEdit-*.js and can delay them). Steps:
//   A. fresh profile, switch off; ⌘⇧E with the chunk read delayed 1500 ms; the window is CLOSED while it is on its way;
//      app 'activate' makes a new window: it starts with the switch off (nothing was stored), no page error.
//   B. in that window ⌘⇧E (no delay): pressed, stored '1', a session works.
//   C. the window reloaded (stored '1', the user's deferred start): the chunk is read again, pressed again, ONE hint
//      element, a session works and the typed text arrives once.
//   D. the window closed and re-created by 'activate' (a second window of the same run, stored '1'): the same.
//   E. ⌘⇧E off then on in that window: immediate (no new read).
//   MDR_APP_DIR=<scratch>/cand MDR_REL_TMP=<scratch dir> node bench/electron/r5-rl-desk.mjs
// <scratch>/cand = electron/ + a production build as dist/ + package.json (never named MDReader.app). Launch only through
// ./_electron.mjs (isolated profile in MDR_REL_TMP, removed at the end). No full screen. Global timeout 110 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electron } from './_electron.mjs';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_REL_TMP || os.tmpdir(), 'r5-rl-desk-')));
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

const DOC = ['# 按需加载复查', '', '甲段落文字，用来点击。', '', '乙段落文字，也用来点击。', '', '丙段落文字。', ''].join(NL);
const FILE = path.join(TMP, 'r5-rl.md');
fs.writeFileSync(FILE, DOC, 'utf8');
const chunkReads = async () => (await app.evaluate(() => globalThis.__r5rlReads.slice())).filter((p) => /inlineEdit-[^/]*\.js$/.test(p)).length;
const setDelay = (ms) => app.evaluate((_, v) => { globalThis.__r5rlDelay = v; }, ms);
const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const editingEls = (page) => page.evaluate(() => ({ ce: document.querySelectorAll('.mdr-preview [contenteditable]').length, editing: document.querySelectorAll('.mdr-preview .is-editing').length, hint: document.querySelectorAll('.mdr-preview__edit-hint').length }));
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const until = async (fn, ms = 3000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
async function clickText(page, needle) {
  const pt = await page.evaluate((t) => {
    const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
    if (!p) return null;
    const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  }, needle);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  await sleep(400);
  return true;
}
async function openDoc(page) {
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  return until(() => page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('甲段落'))), 8000);
}
async function session(page, label, needle, typed) {
  const clicked = await clickText(page, needle);
  check(`${label}: clicked ${needle}`, clicked);
  if (!clicked) console.log(`  ${label}: preview paragraphs:`, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].map((p) => p.textContent.slice(0, 20)))));
  check(`${label}: a session started`, (await editingEls(page)).editing === 1, JSON.stringify(await editingEls(page)));
  await page.keyboard.type(typed);
  await sleep(700);
  const src = await source(page);
  check(`${label}: typed text arrived once`, src.split(typed).length === 2, src.split(NL).find((l) => l.includes(typed)) ?? '');
  await page.keyboard.press('Escape');
  await sleep(300);
}
async function newWindow() {
  await app.evaluate(({ app: a }) => { a.emit('activate'); });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ws = app.windows();
    if (ws.length) { const w = ws[ws.length - 1]; try { await w.waitForSelector('.cm-content', { timeout: 5000 }); return w; } catch { /* */ } }
    await sleep(200);
  }
  return null;
}
async function closeWindow(page = null) {
  const before = app.windows().length;
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  if (page) {
    // a modified document: the close guard asks 保存 / 不保存 / 取消 in the renderer
    await sleep(600);
    try { for (const b of await page.$$('.mdr-dialog__btn')) if (((await b.textContent()) ?? '').includes('不保存')) { await b.click(); break; } } catch { /* window already gone */ }
  }
  await until(async () => app.windows().length < before && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0, 8000);
}

try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  await app.evaluate(() => {
    const fsp = process.getBuiltinModule('node:fs').promises;
    globalThis.__r5rlReads = [];
    globalThis.__r5rlDelay = 0;
    const orig = fsp.readFile;
    fsp.readFile = async function (p, ...rest) {
      const s = String(p);
      try { globalThis.__r5rlReads.push(s); } catch { /* */ }
      if (/inlineEdit-[^/]*\.js$/.test(s) && globalThis.__r5rlDelay) await new Promise((r) => setTimeout(r, globalThis.__r5rlDelay));
      return orig.call(this, p, ...rest);
    };
  });
  let page = await app.firstWindow();
  const errors = [];
  const watch = (pg) => pg.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  watch(page);
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  check('A: switch off at the first start', (await pressed(page)) === 'false');
  check('A: document shown', await openDoc(page));
  // A. ⌘⇧E with a delayed chunk, window closed while it is on its way
  await setDelay(1500);
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+KeyE');
  await sleep(300);
  check('A: not pressed while the chunk is on its way', (await pressed(page)) === 'false');
  await closeWindow();
  check('A: window closed', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0);
  await sleep(1800);
  await setDelay(0);
  page = await newWindow();
  check('A: activate made a new window', !!page);
  if (!page) throw new Error('no window');
  watch(page);
  await sleep(800);
  check('A: the new window starts off (nothing stored by the withdrawn load)', (await pressed(page)) === 'false' && (await stored(page)) !== '1', `${await pressed(page)} ${await stored(page)}`);
  // B. on, session
  check('B: document shown', await openDoc(page));
  const r0 = await chunkReads();
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+KeyE');
  check('B: pressed once the chunk arrived', await until(async () => (await pressed(page)) === 'true', 5000));
  check('B: stored 1', (await stored(page)) === '1');
  check('B: the chunk read once more', (await chunkReads()) === r0 + 1, `${r0} -> ${await chunkReads()}`);
  await session(page, 'B', '乙段落', 'QB');
  // C. reload the window: stored 1, the deferred start
  const r1 = await chunkReads();
  await page.reload();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  check('C: document shown after the reload', await openDoc(page));
  check('C: pressed again after the reload', await until(async () => (await pressed(page)) === 'true', 7000), String(await pressed(page)));
  check('C: the chunk read again after the reload', (await chunkReads()) === r1 + 1, `${r1} -> ${await chunkReads()}`);
  check('C: one hint element (one instance)', (await editingEls(page)).hint === 1, JSON.stringify(await editingEls(page)));
  await session(page, 'C', '甲段落', 'QC');
  // D. a second window of the same run
  await closeWindow(page);
  await sleep(500);
  const r2 = await chunkReads();
  page = await newWindow();
  check('D: activate made a new window', !!page);
  if (!page) throw new Error('no window');
  watch(page);
  check('D: document shown', await openDoc(page));
  check('D: pressed (stored 1)', await until(async () => (await pressed(page)) === 'true', 7000), String(await pressed(page)));
  check('D: the chunk read for the new window', (await chunkReads()) === r2 + 1, `${r2} -> ${await chunkReads()}`);
  await session(page, 'D', '丙段落', 'QD');
  // E. off, on: immediate
  const r3 = await chunkReads();
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+KeyE');
  await sleep(200);
  check('E: off', (await pressed(page)) === 'false' && (await stored(page)) === '0');
  await page.keyboard.press('Meta+Shift+KeyE');
  await sleep(60);
  check('E: on again at once', (await pressed(page)) === 'true');
  check('E: no new read', (await chunkReads()) === r3, `${r3} -> ${await chunkReads()}`);
  check('no page error in any window', errors.length === 0, errors.join(' | '));
} catch (err) {
  fail++;
  console.log('FAIL  error:', String(err && err.message || err).split(NL)[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
