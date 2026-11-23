// bench/electron/r5-pl-desk.mjs — proto-lazy (0.2.0 stage 2f, rule L9): the desktop shell and the editing chunk loaded on
// demand. Records every file the shell's app:// protocol handler reads (fs.promises.readFile wrapped in the main
// process), then: with 预览可编辑 OFF (a fresh profile stores nothing) a document opened through open-file, a click into
// the preview, typing in the editor, a task box ticked, the three modes: the chunk's file (dist/assets/inlineEdit-*.js)
// is never read and no editing element exists; then ⌘⇧E: the chunk is read once, the button pressed after it arrived,
// a click starts a session and typed text reaches the source.
//   MDR_APP_DIR=<scratch>/cand MDR_REL_TMP=<scratch dir> node bench/electron/r5-pl-desk.mjs
// <scratch>/cand = electron/ + a production build as dist/ + package.json. Launch only through ./_electron.mjs (isolated
// profile in MDR_REL_TMP, removed at the end). No full screen involved. Global timeout 110 s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electron } from './_electron.mjs';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_REL_TMP || os.tmpdir(), 'r5-pl-desk-')));
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

const DOC = ['# 按需加载检查', '', '甲段落文字，用来点击。', '', '- [ ] 任务一', '- [ ] 任务二', '', '乙段落文字。', ''].join(NL);
const FILE = path.join(TMP, 'r5-pl.md');
fs.writeFileSync(FILE, DOC, 'utf8');
const reads = () => app.evaluate(() => globalThis.__r5plReads.slice());
const chunkReads = async () => (await reads()).filter((p) => /inlineEdit-[^/]*\.js$/.test(p));
const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
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

try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  // wrap the protocol handler's file reads (electron/protocol.mjs: `import { promises as fs } from 'node:fs'`, fs.readFile)
  await app.evaluate(() => {
    const fsp = process.getBuiltinModule('node:fs').promises;
    globalThis.__r5plReads = [];
    const orig = fsp.readFile;
    fsp.readFile = function (p, ...rest) { try { globalThis.__r5plReads.push(String(p)); } catch { /* */ } return orig.call(this, p, ...rest); };
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(800);
  // the first window's scripts may have been read before the wrap: reload once so every read is seen
  await page.reload();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(800);
  const r0 = await reads();
  check('desk: the wrap sees the renderer being served (index.html and the main script read)', r0.some((p) => p.endsWith('index.html')) && r0.some((p) => /assets\/index-[^/]*\.js$/.test(p)), String(r0.length));
  check('desk: switch off at the first start (fresh profile)', (await pressed(page)) === 'false');
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  check('desk: the document is shown', await until(() => page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('甲段落'))), 8000));
  check('desk: clicked a paragraph (switch off)', await clickText(page, '甲段落'));
  check('desk: no session with the switch off', (await editingEls(page)).editing === 0);
  await page.click('.cm-content');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('丙');
  await sleep(400);
  await page.locator('.mdr-preview input[type="checkbox"]').first().click({ timeout: 5000 }).catch(() => {});
  await sleep(500);
  for (const m of ['view.mode.preview', 'view.mode.edit', 'view.mode.split']) { await page.click(`[data-cmd="${m}"]`); await sleep(300); }
  const off = await chunkReads();
  check('desk: switch off: the chunk file is never read', off.length === 0, off.join(','));
  const el0 = await editingEls(page);
  check('desk: switch off: no editing element', el0.ce === 0 && el0.editing === 0 && el0.hint === 0, JSON.stringify(el0));
  check('desk: the tick reached the source', (await source(page)).includes('- [x] 任务一'), (await source(page)).split(NL).find((l) => l.includes('任务一')) ?? '');
  // on
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+KeyE');
  check('desk: ⌘⇧E: pressed once the chunk arrived', await until(async () => (await pressed(page)) === 'true', 5000));
  const on = await chunkReads();
  check('desk: switch on: the chunk file read once', on.length === 1, on.join(','));
  check('desk: clicked a paragraph (switch on)', await clickText(page, '乙段落'));
  check('desk: a session started', (await editingEls(page)).editing === 1, JSON.stringify(await editingEls(page)));
  await page.keyboard.type('XY');
  await sleep(700);
  const src = await source(page);
  check('desk: typed text reached the source', src.includes('乙XY段落') || src.split('XY').length === 2, src.split(NL).find((l) => l.includes('乙')) ?? '');
  const errs = await page.evaluate(() => (window.__r5plErrs || []).length).catch(() => 0);
  void errs;
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
