// bench/electron/v3-app-desk.mjs — verify-app (0.2.0 stage 2c): an in-preview editing session inside the
// desktop shell. Dev shell (electron/ of the tree or of a given app dir) on a given renderer URL, so the test
// hooks exist. Cases: real key presses ⌘B / ⌘Z / ⌘S in a session (double handling by renderer + menu
// accelerator?), menu 编辑→撤销/重做 and 格式→加粗 / 标题 in a session, menu save with text typed 0 ms ago and
// with an emptied block, window close with pending text (close question), an OS document (open-file) arriving
// during a session, 视图→预览可编辑 via the command, G39 variations (menu undo with the focus in the link field
// of a session, in CodeMirror's find field after typing, in the palette after typing, then 重做).
//   candidate: MDR_DEV_URL=http://localhost:5383/ node bench/electron/v3-app-desk.mjs [case-prefix]
//   baseline (G39 cases only): MDR_SHELL_DIR=release/baseline-0.1.1.noindex MDR_DEV_URL='http://localhost:5393/?perf=1' node bench/electron/v3-app-desk.mjs G39
// Launch only through ./_electron.mjs (isolated profile). Documents in MDR_V3_TMP (default: os tmpdir). Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(ROOT, process.env.MDR_SHELL_DIR || '.');
const TMP = fs.mkdtempSync(path.join(process.env.MDR_V3_TMP || os.tmpdir(), 'v3desk-'));
const only = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const res = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
let app = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ } process.exit(3); }, 110_000);
const menuClick = (id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);
const DOC = ['# 标题', '', '甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
const write = (name, text) => { const p = path.join(TMP, name); fs.writeFileSync(p, text, 'utf8'); return p; };

try {
  app = await electron.launch({ args: [DIR], env: { ...process.env, MDR_DEV_URL: process.env.MDR_DEV_URL || 'http://localhost:5383/' } });
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__sent = [];
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents; const o = wc.send.bind(wc);
      wc.send = (ch, ...a) => { globalThis.__sent.push([ch, ...a].map(String).join(' ')); return o(ch, ...a); };
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 300 && !(await page.evaluate(() => !!window.__mdr?.app).catch(() => false)); i++) await sleep(100);
  await sleep(1500);
  const src = () => page.evaluate(() => window.__mdr.app.getText());
  const sent = () => app.evaluate(() => globalThis.__sent.splice(0));
  const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
  const clickDialog = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, label);
  const editing = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  const openPath = async (p) => {
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
    for (let i = 0; i < 60; i++) { if ((await src().catch(() => '')) === fs.readFileSync(p, 'utf8')) break; await sleep(100); }
    await page.evaluate(() => window.__mdr.waitIdle()); await sleep(400);
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
  const caretEndOfEditing = () => page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? 1 : 2) });
    let last = null; for (let n = w.nextNode(); n; n = w.nextNode()) last = n;
    const r = document.createRange(); r.setStart(last, last.data.length); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  async function session(needle) {
    await page.evaluate(() => { document.querySelectorAll('.mdr-dialog__btn').forEach((b) => { if (b.textContent.trim() === '取消') b.click(); }); });
    for (let i = 0; i < 3; i++) {
      const p = await point(needle, 1);
      if (p) { await page.mouse.click(p.x, p.y); await sleep(200); }
      if (await editing()) { await caretEndOfEditing(); return; }
      await sleep(400);
    }
    throw new Error(`no session on ${needle}`);
  }
  const reset = async (name, text = DOC) => {
    await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => window.__mdr.loadText('', 'blank.md'));
    await sleep(200);
    const p = write(name, text);
    await openPath(p);
    await sent();
    return p;
  };
  const t = async (name, fn) => { if (only && !name.startsWith(only)) return; try { const d = await fn(); res(name, true, typeof d === 'string' ? d : ''); } catch (e) { res(name, false, String(e.message).split('\n').slice(0, 2).join(' | ')); } };

  await t('K1 real ⌘B on a selection in a session: bold once (renderer + menu accelerator must not both act)', async () => {
    await reset('k1.md');
    await session('乙段落文字');
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing'); const n = el.querySelector('p').firstChild;
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 2); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Meta+b'); await sleep(300);
    await page.keyboard.press('Escape'); await sleep(500);
    const s = await src();
    const cmds = (await sent()).filter((x) => x.includes('mdr:command'));
    const l = s.split('\n').find((x) => x.includes('段落文字')) && s.split('\n')[4];
    if (l !== '**乙段**落文字。') throw new Error(`line ${JSON.stringify(l)} commands ${JSON.stringify(cmds)}`);
    return `commands ${JSON.stringify(cmds)}`;
  });
  await t('K2 real ⌘Z in a session after typing XY: one undo step (XY gone), not two', async () => {
    await reset('k2.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); });
    await page.keyboard.type('E'); await sleep(700);
    await session('乙段落文字');
    await page.keyboard.type('XY'); await sleep(700);
    await page.keyboard.press('Meta+z'); await sleep(900);
    const s = await src();
    const cmds = (await sent()).filter((x) => x.includes('mdr:command'));
    await page.keyboard.press('Escape'); await sleep(300);
    const want = DOC.replace('甲段落文字。', '甲段落文字。E');
    if (s !== want) throw new Error(`source ${JSON.stringify(s)} commands ${JSON.stringify(cmds)}`);
    return `commands ${JSON.stringify(cmds)}`;
  });
  await t('K3 real ⌘S in a session 0 ms after typing: file on disk has the text, session stays', async () => {
    const p = await reset('k3.md');
    await session('乙段落文字');
    await page.keyboard.type('S1');
    await page.keyboard.press('Meta+s'); await sleep(1200);
    const disk = fs.readFileSync(p, 'utf8');
    const ed = await editing();
    if (disk !== DOC.replace('乙段落文字。', '乙段落文字。S1')) throw new Error(`disk ${JSON.stringify(disk)}`);
    if (!ed) throw new Error('session ended by ⌘S');
    const title = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { t: w.getTitle(), edited: w.isDocumentEdited() }; });
    if (title.edited) throw new Error(`still edited ${JSON.stringify(title)}`);
    return JSON.stringify(title);
  });
  await t('M1 menu 保存 with an emptied block (0 ms): file on disk lacks 乙; window not edited', async () => {
    const p = await reset('m1.md');
    await session('乙段落文字');
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace');
    await menuClick('file.save'); await sleep(1200);
    const disk = fs.readFileSync(p, 'utf8');
    if (disk !== '# 标题\n\n甲段落文字。\n\n丙段落文字。\n') throw new Error(`disk ${JSON.stringify(disk)}`);
    const edited = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited());
    if (edited) throw new Error('window still edited');
  });
  await t('M2 menu 撤销 then 重做 in a session after typing XY', async () => {
    await reset('m2.md');
    await session('乙段落文字');
    await page.keyboard.type('XY'); await sleep(700);
    await menuClick('edit.undo'); await sleep(900);
    const s1 = await src();
    await menuClick('edit.redo'); await sleep(900);
    const s2 = await src();
    const ed = await editing();
    await page.keyboard.type('Z'); await sleep(600);
    const s3 = await src();
    await page.keyboard.press('Escape'); await sleep(300);
    if (s1 !== DOC) throw new Error(`after undo ${JSON.stringify(s1)}`);
    if (s2 !== DOC.replace('乙段落文字。', '乙段落文字。XY')) throw new Error(`after redo ${JSON.stringify(s2)}`);
    if (!s3.includes('乙段落文字。XYZ')) throw new Error(`typing after redo ${JSON.stringify(s3)} session ${ed}`);
  });
  await t('M3 menu 加粗 with a selection in a session; menu 标题 2 in a session', async () => {
    await reset('m3.md');
    await session('乙段落文字');
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing'); const n = el.querySelector('p').firstChild;
      const r = document.createRange(); r.setStart(n, 3); r.setEnd(n, 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await menuClick('edit.bold'); await sleep(500);
    await page.keyboard.press('Escape'); await sleep(500);
    const s1 = (await src()).split('\n')[4];
    await session('丙段落文字');
    await page.keyboard.type('W');
    await menuClick('edit.heading2'); await sleep(700);
    const s2 = (await src()).split('\n')[6];
    if (s1 !== '乙段落**文字**。') throw new Error(`bold: ${JSON.stringify(s1)}`);
    if (s2 !== '## 丙段落文字。W') throw new Error(`heading: ${JSON.stringify(s2)}`);
  });
  await t('W1 close the window 0 ms after typing in a session (clean doc): close question; 取消 keeps the text', async () => {
    await reset('w1.md');
    await session('乙段落文字');
    await page.keyboard.type('Q');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(800);
    const q = await dialogs();
    const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (!alive) throw new Error('window closed without a question');
    if (!q.length) throw new Error('no question');
    await clickDialog('取消'); await sleep(400);
    const s = await src();
    if (!s.includes('乙段落文字。Q')) throw new Error(`text ${JSON.stringify(s)}`);
    return JSON.stringify(q);
  });
  await t('W2 close the window with only an emptied block pending (0 ms): close question', async () => {
    await reset('w2.md');
    await session('乙段落文字');
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(800);
    const q = await dialogs();
    const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (!alive) throw new Error('window closed without a question');
    if (!q.length) throw new Error('no question');
    await clickDialog('取消'); await sleep(300);
  });
  await t('O1 an OS document arrives during a session with text typed 0 ms ago: question; 取消 keeps text; the other file is untouched', async () => {
    await reset('o1.md');
    const other = write('o1-other.md', '# 另一个\n\n内容。\n');
    await session('乙段落文字');
    await page.keyboard.type('R');
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
    await sleep(900);
    const q = await dialogs();
    if (!q.length) throw new Error(`no question; source ${JSON.stringify(await src())}`);
    await clickDialog('取消'); await sleep(500);
    const s = await src();
    if (!s.includes('乙段落文字。R')) throw new Error(`text ${JSON.stringify(s)}`);
    if (fs.readFileSync(other, 'utf8') !== '# 另一个\n\n内容。\n') throw new Error('other file changed');
    // and 丢弃: the new document must be exact
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
    await sleep(800);
    await clickDialog('丢弃'); await sleep(900);
    const s2 = await src();
    if (s2 !== '# 另一个\n\n内容。\n') throw new Error(`new doc ${JSON.stringify(s2)}`);
  });
  await t('V1 预览可编辑 off (command) with text typed 0 ms ago: text written, session ended, preview no longer editable', async () => {
    await reset('v1.md');
    await session('乙段落文字');
    await page.keyboard.type('V');
    await menuClick('view.togglePreviewEdit').then(async (ok) => { if (!ok) await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit')); });
    await sleep(600);
    const s = await src();
    const ed = await editing();
    await page.evaluate(() => { if (localStorage.getItem('mdr.previewEdit') === '0') window.__mdr.app.registry.run('view.togglePreviewEdit'); });
    if (!s.includes('乙段落文字。V') || ed) throw new Error(`src ${JSON.stringify(s)} editing ${ed}`);
  });

  // G39 variations: menu 撤销 / 重做 with the focus in an app text field.
  await t('G39a menu 撤销 with the focus in the palette input after typing (then 重做)', async () => {
    await reset('g39a.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); });
    await page.keyboard.type('ABC'); await sleep(700);
    await page.keyboard.press('Meta+Shift+P'); await sleep(300);
    await page.keyboard.type('the'); await sleep(200);
    await menuClick('edit.undo'); await sleep(400);
    const r1 = await page.evaluate(() => ({ v: document.activeElement?.value, doc: window.__mdr.app.getText().split('\n')[2] }));
    await menuClick('edit.redo'); await sleep(400);
    const r2 = await page.evaluate(() => ({ v: document.activeElement?.value, doc: window.__mdr.app.getText().split('\n')[2] }));
    await page.keyboard.press('Escape'); await sleep(200);
    out('G39a', { r1, r2 });
    if (r1.doc !== '甲段落文字。ABC' || r2.doc !== '甲段落文字。ABC') throw new Error(`document stepped: ${JSON.stringify({ r1, r2 })}`);
    return JSON.stringify({ r1, r2 });
  });
  await t('G39b menu 撤销 with the focus in CodeMirror’s find field after typing', async () => {
    await reset('g39b.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); });
    await page.keyboard.type('ABC'); await sleep(700);
    await page.keyboard.press('Meta+f'); await sleep(400);
    await page.keyboard.type('段落'); await sleep(200);
    await menuClick('edit.undo'); await sleep(400);
    const r1 = await page.evaluate(() => ({ v: document.activeElement?.value, cls: document.activeElement?.className, doc: window.__mdr.app.getText().split('\n')[2] }));
    await page.keyboard.press('Escape'); await sleep(200);
    out('G39b', r1);
    if (r1.doc !== '甲段落文字。ABC') throw new Error(`document stepped: ${JSON.stringify(r1)}`);
    return JSON.stringify(r1);
  });
  await t('G39c menu 撤销 with the focus in the session’s link field (⌘K) after typing a URL', async () => {
    await reset('g39c.md');
    await session('乙段落文字');
    await page.keyboard.type('XY'); await sleep(700);
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing'); const n = el.querySelector('p').firstChild;
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 2); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Meta+k'); await sleep(400);
    const field = await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
    await page.keyboard.type('https://a.b'); await sleep(200);
    await menuClick('edit.undo'); await sleep(500);
    const r1 = await page.evaluate(() => ({ v: document.activeElement?.value, tag: document.activeElement?.tagName, doc: window.__mdr.app.getText().split('\n')[4] }));
    await page.keyboard.press('Escape'); await sleep(300);
    await page.keyboard.press('Escape'); await sleep(300);
    const s = await src();
    out('G39c', { field, r1, after: s.split('\n')[4] });
    if (r1.doc !== '乙段落文字。XY') throw new Error(`document stepped: ${JSON.stringify(r1)} field ${field}`);
    if (s.split('\n')[4] !== '乙段落文字。XY') throw new Error(`after Esc: ${JSON.stringify(s)}`);
    return JSON.stringify({ field, r1 });
  });
  await t('G39d menu 撤销 with the focus in the go-to-line field', async () => {
    await reset('g39d.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); });
    await page.keyboard.type('ABC'); await sleep(700);
    await page.keyboard.press('Meta+Alt+g'); await sleep(400);
    await page.keyboard.type('5'); await sleep(200);
    const f = await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
    await menuClick('edit.undo'); await sleep(400);
    const r1 = await page.evaluate(() => ({ v: document.activeElement?.value, doc: window.__mdr.app.getText().split('\n')[2] }));
    await page.keyboard.press('Escape'); await sleep(200);
    out('G39d', { f, r1 });
    if (r1.doc !== '甲段落文字。ABC') throw new Error(`document stepped: ${JSON.stringify(r1)} field ${f}`);
    return JSON.stringify({ f, r1 });
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
