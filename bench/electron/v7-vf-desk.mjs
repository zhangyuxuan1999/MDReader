// bench/electron/v7-vf-desk.mjs — verify-refs (round 6): one desktop round trip on a candidate directory with
// 预览可编辑 turned on (⌘⇧E): a document whose source spells invisible characters as references and percent-escapes is
// delivered with open-file; two sessions (a Chinese paragraph indented with &emsp;&emsp;, a list item next to a bare URL
// with a percent-escaped RLO) each type one character; ⌘S; the file is read back from disk IN THE MAIN PROCESS and must be
// the original with exactly the two typed characters inserted. No full screen. Launch only through ./_electron.mjs.
//   MDR_APP_DIR=release/staging-0.2.0-r6.noindex MDR_REL_TMP=<scratch dir> node bench/electron/v7-vf-desk.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electron } from './_electron.mjs';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_REL_TMP || os.tmpdir(), 'v7-vf-desk-')));
const PROFILE = path.join(TMP, 'profile');
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const show = (s) => JSON.stringify([...s].map((c) => { const cp = c.codePointAt(0); return (cp >= 0x20 && cp <= 0x7e) || cp === 10 || (cp >= 0x4e00 && cp <= 0x9fff) ? c : '<' + cp.toString(16) + '>'; }).join(''));
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

const DOC = ['# 春日', '', '&emsp;&emsp;春天来了，万物复苏。我们去公园散步，看见了很多花。', '', '- 第一项&ensp;说明 Donau&shy;dampf', '- 链接 https://e.example/file%E2%80%AEtxt.exe 结尾', '', '| 名称 | 数量 |', '| --- | --- |', '| 苹果&emsp;红 | 3&thinsp;000 |', '', 'من می&zwnj;خواهم.', ''].join(NL);
const WANT = DOC.replace('很多花', '很多花Ж').replace('说明', '说明Я');
const FILE = path.join(TMP, 'v7-vf-desk.md');
fs.writeFileSync(FILE, DOC, 'utf8');

const pointOf = (page, needle) => page.evaluate((t) => {
  const root = document.querySelector('.mdr-preview');
  const tw = document.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
  return null;
}, needle);
const caretAfter = (page, needle) => page.evaluate((t) => {
  const el = document.querySelector('.mdr-preview .is-editing'); if (!el) return false;
  const tw = document.createTreeWalker(el, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + t.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
  return false;
}, needle);
async function until(f, ms) { const t = Date.now() + ms; while (Date.now() < t) { try { if (await f()) return true; } catch { /* */ } await sleep(150); } return false; }

try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(600);
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  check('the document is shown', await until(() => page.evaluate(() => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('万物复苏'))), 8000));
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+KeyE');
  check('switch on (⌘⇧E)', await until(async () => (await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'))) === 'true', 5000));
  await sleep(500);
  for (const [needle, at, ch] of [['万物复苏', '很多花', 'Ж'], ['第一项', '说明', 'Я']]) {
    const p = await pointOf(page, needle);
    await page.mouse.click(p.x, p.y);
    await sleep(600);
    const on = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    check(`a session starts in "${needle}"`, on);
    if (on) { check(`caret after "${at}"`, await caretAfter(page, at)); await page.keyboard.type(ch); await sleep(500); }
    await page.keyboard.press('Escape');
    await sleep(700);
  }
  await page.click('.cm-content');
  await page.keyboard.press('Meta+s');
  await sleep(1200);
  const disk = await app.evaluate(({}, f) => process.getBuiltinModule('node:fs').readFileSync(f, 'utf8'), FILE);
  check('the file on disk is the original plus the two typed characters, byte for byte', disk === WANT, disk === WANT ? '' : show(disk));
  const toast = await page.evaluate(() => document.body.innerText.includes('此块请在源码中编辑'));
  check('no refusal toast', !toast);
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
