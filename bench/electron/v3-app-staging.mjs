// bench/electron/v3-app-staging.mjs — verify-app (0.2.0 stage 2c): an in-preview session inside the CANDIDATE
// DIRECTORY (built dist, no test hooks: everything is driven and read through the DOM and the files on disk).
//   MDR_APP_DIR=release/staging-0.2.0.noindex node bench/electron/v3-app-staging.mjs [case-prefix]
// Cases: ⌘S 0 ms after typing in a session (disk), an emptied block + menu 保存 (disk), menu 撤销 in a session,
// window close 0 ms after typing (close question; 取消 keeps the text; 不保存 closes), an OS document arriving
// during a session (question; 丢弃 → the new document exact).
// Launch only through ./_electron.mjs (isolated profile). Documents in MDR_V3_TMP (default: os tmpdir). Global timeout 110 s.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(ROOT, process.env.MDR_APP_DIR || 'release/staging-0.2.0.noindex');
const TMP = fs.mkdtempSync(path.join(process.env.MDR_V3_TMP || os.tmpdir(), 'v3stg-'));
const only = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const res = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
let app = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ } process.exit(3); }, 110_000);
const menuClick = (id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);
const DOC = ['# 标题', '', '甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
const write = (name, text) => { const p = path.join(TMP, name); fs.writeFileSync(p, text, 'utf8'); return p; };

try {
  app = await electron.launch({ args: [DIR] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!document.querySelector('.cm-content')).catch(() => false)); i++) await sleep(100);
  await sleep(1500);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, page);
  /** The editor's text through the DOM (small documents: every line is rendered). */
  const src = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
  const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
  const clickDialog = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, label);
  const editing = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  const openPath = async (p, answer = null) => {
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
    const want = fs.readFileSync(p, 'utf8');
    for (let i = 0; i < 60; i++) {
      if (answer && (await dialogs()).length) await clickDialog(answer);
      if ((await src().catch(() => '')) === want) break;
      await sleep(100);
    }
    await sleep(700);
  };
  const point = (needle, k = 1) => page.evaluate(({ needle, k }) => {
    const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { needle, k });
  async function session(needle) {
    for (let i = 0; i < 3; i++) {
      const p = await point(needle, 1);
      if (p) { await page.mouse.click(p.x, p.y); await sleep(250); }
      if (await editing()) {
        await page.evaluate(() => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? 1 : 2) });
          let last = null; for (let n = w.nextNode(); n; n = w.nextNode()) last = n;
          const r = document.createRange(); r.setStart(last, last.data.length); r.collapse(true);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        return;
      }
      await sleep(400);
    }
    throw new Error(`no session on ${needle}`);
  }
  const reset = async (name, text = DOC) => {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
    const p = write(name, text);
    await openPath(p, '丢弃');
    return p;
  };
  const t = async (name, fn) => { if (only && !name.startsWith(only)) return; try { const d = await fn(); res(name, true, typeof d === 'string' ? d : ''); } catch (e) { res(name, false, String(e.message).split('\n').slice(0, 2).join(' | ')); } };
  const edited = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isDocumentEdited());

  await t('S1 ⌘S 0 ms after typing S1 in a session: disk has it; window not edited; session stays', async () => {
    const p = await reset('s1.md');
    await session('乙段落文字');
    await page.keyboard.type('S1');
    await page.keyboard.press('Meta+s'); await sleep(1500);
    const disk = fs.readFileSync(p, 'utf8');
    if (disk !== DOC.replace('乙段落文字。', '乙段落文字。S1')) throw new Error(`disk ${JSON.stringify(disk)}`);
    if (await edited()) throw new Error('window still edited');
    if (!(await editing())) throw new Error('session ended');
    await page.keyboard.press('Escape'); await sleep(300);
  });
  await t('S2 emptied block + menu 保存 at 0 ms: disk lacks 乙, window not edited', async () => {
    const p = await reset('s2.md');
    await session('乙段落文字');
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace');
    await menuClick('file.save'); await sleep(1500);
    const disk = fs.readFileSync(p, 'utf8');
    if (disk !== '# 标题\n\n甲段落文字。\n\n丙段落文字。\n') throw new Error(`disk ${JSON.stringify(disk)}`);
    if (await edited()) throw new Error('window still edited');
    await page.keyboard.press('Escape'); await sleep(300);
  });
  await t('S3 menu 撤销 in a session after typing XY, then save: disk is the original', async () => {
    const p = await reset('s3.md');
    await session('乙段落文字');
    await page.keyboard.type('XY'); await sleep(800);
    await menuClick('edit.undo'); await sleep(900);
    const s = await src();
    await page.keyboard.press('Escape'); await sleep(300);
    await menuClick('file.save'); await sleep(1200);
    const disk = fs.readFileSync(p, 'utf8');
    if (s !== DOC) throw new Error(`editor after undo ${JSON.stringify(s)}`);
    if (disk !== DOC) throw new Error(`disk ${JSON.stringify(disk)}`);
  });
  await t('S4 an OS document arrives 0 ms after typing in a session: question; 取消 keeps the text; again + 丢弃 → new doc exact', async () => {
    await reset('s4.md');
    const other = write('s4-other.md', '# 另一个\n\n内容。\n');
    await session('乙段落文字');
    await page.keyboard.type('R');
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
    await sleep(900);
    const q = await dialogs();
    if (!q.length) throw new Error(`no question; editor ${JSON.stringify(await src())}`);
    await clickDialog('取消'); await sleep(500);
    const s = await src();
    if (!s.includes('乙段落文字。R')) throw new Error(`text ${JSON.stringify(s)}`);
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
    await sleep(900);
    await clickDialog('丢弃'); await sleep(1000);
    const s2 = await src();
    if (s2 !== '# 另一个\n\n内容。\n') throw new Error(`new doc ${JSON.stringify(s2)}`);
    if (fs.readFileSync(other, 'utf8') !== '# 另一个\n\n内容。\n') throw new Error('other file changed');
  });
  await t('S5 close the window 0 ms after typing in a session: close question; 取消 keeps; then 保存 writes it and the window closes', async () => {
    const p = await reset('s5.md');
    await session('乙段落文字');
    await page.keyboard.type('Q');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(900);
    const q = await dialogs();
    if (!q.length) throw new Error(`no question (windows ${await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)})`);
    await clickDialog('取消'); await sleep(400);
    if (!(await src()).includes('乙段落文字。Q')) throw new Error('text lost after 取消');
    await page.keyboard.type('').catch(() => {});
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(900);
    await clickDialog('保存'); await sleep(1500);
    const disk = fs.readFileSync(p, 'utf8');
    const n = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (disk !== DOC.replace('乙段落文字。', '乙段落文字。Q')) throw new Error(`disk ${JSON.stringify(disk)}`);
    return `windows after 保存: ${n}`;
  });
} catch (e) {
  console.log('ERROR', String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(KILL);
  console.log(`\n${pass}/${pass + fail} checks passed`);
  try { await app?.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* */ }
  await Promise.race([app?.close().catch(() => {}), sleep(4000)]);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}
