// bench/verify/v3-app-save.mjs — verify-app (0.2.0 stage 2c), JOB 1: save / save-as / failed save / export /
// document replacement while an in-preview session holds text typed 0 ms ago or an emptied block.
// Web build, File System Access path through OPFS handles (a throw-away browser context: nothing on disk).
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-save.mjs [case-filter]
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const only = process.argv[2] ?? '';
const t = (name, fn) => (only && !name.startsWith(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
const { page } = B;
const DOC = ['# 标题', '', '甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;

async function openOpfs(name, text) {
  await page.evaluate(() => document.querySelectorAll('.mdr-dialog__btn').forEach((b) => { if (b.textContent.trim() === '取消') b.click(); }));
  await B.loadDoc('', 'reset.md');   // clean document first: file.open must not meet a discard question
  await page.evaluate(async ([n, tx]) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(tx); await w.close();
    window.showOpenFilePicker = async () => [h];
  }, [name, text]);
  await page.evaluate(() => window.__mdr.app.registry.run('file.open'));
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    if (await page.evaluate((tx) => window.__mdr.app.getText() === tx, text)) break;
    await sleep(80);
  }
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
}
const readOpfs = (name) => page.evaluate(async (n) => {
  const root = await navigator.storage.getDirectory();
  const h = await root.getFileHandle(n);
  return (await h.getFile()).text();
}, name);
const title = () => page.evaluate(() => document.title);
const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
const clickDialog = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label);
  if (!b) throw new Error(`no dialog button ${label}`);
  b.click();
}, label);
async function startIn(doc, needle) {
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}
async function emptyEditing() {
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
}
async function waitFor(fn, arg, ms = 5000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await page.evaluate(fn, arg).catch(() => undefined); if (v) return v; await sleep(60); }
  return v;
}

try {
  await B.boot('mode=split');

  await t('A1 type XY in a session then ⌘S in the same key sequence (0 ms): the file holds XY; title clean', async () => {
    await openOpfs('a1.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('XY');
    await page.keyboard.press('Meta+s');
    await waitFor(() => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')));
    await sleep(300);
    const f = await readOpfs('a1.md');
    const s = await B.source();
    assert(f === DOC.replace('乙段落文字。', '乙段落文字。XY'), `file ${JSON.stringify(f)}`);
    assert(s === f, `source ${JSON.stringify(s)} differs from file`);
    const tt = await title();
    assert(!tt.startsWith('●'), `title ${tt}`);
    const ed = await B.editing();
    assert(ed, 'session ended by ⌘S (should survive)');
    await page.keyboard.type('Z');
    await B.settle(300);
    const s2 = await B.source();
    assert(s2.includes('乙段落文字。XYZ'), `typing after save: ${JSON.stringify(s2)}`);
    assert((await title()).startsWith('●'), 'not dirty after typing post-save');
    await B.esc();
    return `file ok, title "${tt}"`;
  });

  await t('A2 empty a block then ⌘S at 0 ms: file has no 乙 and no extra blank line; title clean', async () => {
    await openOpfs('a2.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await page.keyboard.press('Meta+s');
    await waitFor(() => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')));
    await sleep(300);
    const f = await readOpfs('a2.md');
    const want = ['# 标题', '', '甲段落文字。', '', '丙段落文字。', ''].join('\n');
    assert(f === want, `file ${JSON.stringify(f)}`);
    assert(!(await title()).startsWith('●'), `title ${await title()}`);
    await B.esc();
    const s = await B.source();
    assert(s === want, `after Esc source ${JSON.stringify(s)}`);
    assert(!(await title()).startsWith('●'), `title after Esc ${await title()}`);
  });

  await t('A3 empty a block, type N into the emptied place, ⌘S at 0 ms: file has N where 乙 was', async () => {
    await openOpfs('a3.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await sleep(80);
    await page.keyboard.type('N');
    await page.keyboard.press('Meta+s');
    await waitFor(() => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')));
    await sleep(400);
    const f = await readOpfs('a3.md');
    const want = ['# 标题', '', '甲段落文字。', '', 'N', '', '丙段落文字。', ''].join('\n');
    const s = await B.source();
    assert(f === want, `file ${JSON.stringify(f)} source ${JSON.stringify(s)}`);
    assert(s === want, `source ${JSON.stringify(s)}`);
    await page.keyboard.type('M');
    await B.settle(300);
    const s2 = await B.source();
    assert(s2 === want.replace('\nN\n', '\nNM\n'), `typing after: ${JSON.stringify(s2)}`);
    await B.esc();
  });

  await t('A4 slow save (1.5 s): keep typing in the session during the save; after: file = text at ⌘S, doc dirty, typing kept', async () => {
    await openOpfs('a4.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('A');
    await page.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      if (!P.__orig) P.__orig = P.createWritable;
      P.createWritable = async function (...a) { await new Promise((r) => setTimeout(r, 1500)); return P.__orig.apply(this, a); };
    });
    await page.keyboard.press('Meta+s');
    await sleep(100);
    await page.keyboard.type('BC', { delay: 60 });
    await sleep(2200);
    await page.evaluate(() => { const P = FileSystemFileHandle.prototype; P.createWritable = P.__orig; });
    const f = await readOpfs('a4.md');
    const s = await B.source();
    const tt = await title();
    assert(f === DOC.replace('乙段落文字。', '乙段落文字。A'), `file ${JSON.stringify(f)}`);
    assert(s === DOC.replace('乙段落文字。', '乙段落文字。ABC'), `source ${JSON.stringify(s)}`);
    assert(tt.startsWith('●'), `title not dirty: ${tt}`);
    await page.keyboard.press('Meta+s');
    await waitFor((n) => document.querySelectorAll('.mdr-toast__text').length && !document.title.startsWith('●'), null, 4000);
    await sleep(300);
    const f2 = await readOpfs('a4.md');
    assert(f2 === s, `second save ${JSON.stringify(f2)}`);
    await B.esc();
    return `title during = ${tt}`;
  });

  await t('A5 failing save with pending text: error toast, document dirty, session text intact, typing continues', async () => {
    await openOpfs('a5.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await page.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      if (!P.__orig) P.__orig = P.createWritable;
      P.createWritable = async function () { throw new DOMException('disk full', 'InvalidModificationError'); };
    });
    await page.keyboard.type('Q');
    await page.keyboard.press('Meta+s');
    await sleep(700);
    const ts = await toasts();
    await page.keyboard.type('R');
    await B.settle(300);
    await page.evaluate(() => { const P = FileSystemFileHandle.prototype; P.createWritable = P.__orig; });
    const s = await B.source();
    const f = await readOpfs('a5.md');
    assert(s.includes('乙段落文字。QR'), `source ${JSON.stringify(s)}`);
    assert(f === DOC, `file changed ${JSON.stringify(f)}`);
    assert((await title()).startsWith('●'), `title ${await title()}`);
    assert(ts.some((x) => x.includes('保存失败')), `toasts ${JSON.stringify(ts)}`);
    await B.esc();
    return JSON.stringify(ts);
  });

  await t('A6 save-as (⇧⌘S) with pending text and an emptied block: the new file has both', async () => {
    const D = ['甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
    await openOpfs('a6.md', D);
    await startIn(D, '甲段落文字。');
    await page.keyboard.type('K');
    await B.settle(200);
    await B.esc();
    await startIn(D, '丙段落文字。');
    await emptyEditing();
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('a6-as.md', { create: true });
      window.showSaveFilePicker = async () => h;
    });
    await page.keyboard.press('Meta+Shift+s');
    await waitFor(() => !document.title.startsWith('●') && document.title.includes('a6-as'), null, 5000);
    await sleep(300);
    const f = await readOpfs('a6-as.md');
    const want = ['甲段落文字。K', '', '乙段落文字。', ''].join('\n');
    assert(f === want, `file ${JSON.stringify(f)} title ${await title()}`);
    await B.esc();
  });

  await t('A7 legacy download path: emptied block + ⌘S at 0 ms → downloaded text has no 乙', async () => {
    await B.loadDoc(DOC, 'a7.md');
    await page.evaluate(() => { window.__savedShow = window.showSaveFilePicker; });
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    // legacy: the loaded text document has no handle → file.save falls back? (record what happens)
    const dlP = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    await page.keyboard.press('Meta+s');
    const dl = await dlP;
    let text = null;
    if (dl) { const p = await dl.path(); text = (await import('node:fs')).readFileSync(p, 'utf8'); }
    const s = await B.source();
    await page.evaluate(() => { window.showSaveFilePicker = window.__savedShow; });
    await B.esc();
    const want = ['# 标题', '', '甲段落文字。', '', '丙段落文字。', ''].join('\n');
    if (text !== null) assert(text === want, `download ${JSON.stringify(text)}`);
    assert(s === want, `source ${JSON.stringify(s)}`);
    return text === null ? `no download (source ok); toasts ${JSON.stringify(await toasts())}` : 'download ok';
  });

  await t('B1 type X in a session, 新建 at 0 ms: question shown; 取消 keeps X; 丢弃 opens an empty doc without X', async () => {
    await B.loadDoc(DOC, 'b1.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('X');
    await page.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(300);
    const q = await dialogs();
    assert(q.some((x) => x.includes('尚未保存')), `no question: ${JSON.stringify(q)}`);
    await clickDialog('取消');
    await sleep(300);
    const s = await B.source();
    assert(s.includes('乙段落文字。X'), `X lost after 取消: ${JSON.stringify(s)}`);
    await page.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(300);
    await clickDialog('丢弃');
    await sleep(500);
    const s2 = await B.source();
    assert(s2 === '', `new doc ${JSON.stringify(s2)}`);
    await page.keyboard.type('W');
    await B.settle(300);
    const s3 = await B.source();
    assert(!s3.includes('X'), `X leaked into the new doc: ${JSON.stringify(s3)}`);
    return `after typing W: ${JSON.stringify(s3)}`;
  });

  await t('B2 empty a block (deletion pending) then ⌘O at 0 ms on a clean doc: the question is asked (the deletion counts); 丢弃 → new doc exact', async () => {
    await openOpfs('b2.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('b2-other.md', { create: true });
      const w = await h.createWritable(); await w.write('# 另一个\n\n内容。\n'); await w.close();
      window.showOpenFilePicker = async () => [h];
    });
    await page.keyboard.press('Meta+o');
    await sleep(400);
    const q = await dialogs();
    assert(q.some((x) => x.includes('尚未保存')), `no question: ${JSON.stringify(q)} src ${JSON.stringify(await B.source())}`);
    await clickDialog('丢弃');
    await waitFor(() => window.__mdr.app.getText().startsWith('# 另一个'));
    await sleep(400);
    await page.keyboard.type('');
    const s = await B.source();
    assert(s === '# 另一个\n\n内容。\n', `new doc ${JSON.stringify(s)}`);
    const f = await readOpfs('b2.md');
    assert(f === DOC, `old file touched ${JSON.stringify(f)}`);
  });

  await t('B3 typing into the emptied place, drop a .md file onto the live session: question; 丢弃 → dropped doc exact, nothing typed in it', async () => {
    await B.loadDoc(DOC, 'b3.md');
    await startIn(DOC, '乙段落文字。');
    await emptyEditing();
    await sleep(60);
    await page.keyboard.type('N');
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing') ?? document.querySelector('.mdr-preview');
      const dt = new DataTransfer();
      dt.items.add(new File(['# 拖入\n\n文字。\n'], 'dropped.md', { type: 'text/markdown' }));
      const r = el.getBoundingClientRect();
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 5 }));
    });
    await sleep(500);
    const q = await dialogs();
    assert(q.some((x) => x.includes('尚未保存')), `no question: ${JSON.stringify(q)} src ${JSON.stringify(await B.source())}`);
    const before = await B.source();
    assert(before.includes('\nN\n'), `N not in the old doc before the answer: ${JSON.stringify(before)}`);
    await clickDialog('丢弃');
    await waitFor(() => window.__mdr.app.getText().startsWith('# 拖入'));
    await sleep(300);
    await page.keyboard.type('Z');
    await B.settle(300);
    const s = await B.source();
    assert(s === '# 拖入\n\n文字。\n' || (!s.includes('N') && s.replace('Z', '') === '# 拖入\n\n文字。\n'), `dropped doc ${JSON.stringify(s)}`);
    return `after Z: ${JSON.stringify(s)} focus=${await page.evaluate(() => document.activeElement?.className)}`;
  });

  await t('B4 export HTML with an emptied block (ghost) and a live session: no ghost text, no contenteditable / ZWSP / capture', async () => {
    await B.loadDoc(DOC, 'b4.md');
    await startIn(DOC, '甲段落文字。');
    await page.keyboard.type('E');
    await B.settle(150);
    await B.esc();
    await startIn(DOC.replace('甲段落文字。', '甲段落文字。E'), '乙段落文字。');
    await emptyEditing();
    const dlP = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
    await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
    const dl = await dlP;
    assert(dl, 'no download');
    const html = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
    const body = html.slice(html.indexOf('<body'));
    const bad = [];
    if (/contenteditable/i.test(body)) bad.push('contenteditable');
    if (body.includes('乙段落')) bad.push('deleted 乙');
    if (!body.includes('甲段落文字。E')) bad.push('typed E missing');
    if (/[\u200b\ufeff\ue000-\ue003]/.test(body)) bad.push('invisible chars');
    if (/is-editing|md-ghost|mdr-cap|textarea/.test(body)) bad.push('session markup');
    assert(!bad.length, bad.join(', '));
    const s = await B.source();
    return `source ${JSON.stringify(s)}`;
  });

  await t('B5 dirty flag: session with typing then Backspace back to the saved text → title clean after Esc, no close question', async () => {
    await openOpfs('b5.md', DOC);
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('X');
    await B.settle(200);
    const mid = await title();
    await page.keyboard.press('Backspace');
    await B.settle(300);
    await B.esc();
    const s = await B.source();
    const tt = await title();
    assert(s === DOC, `source ${JSON.stringify(s)}`);
    assert(!tt.startsWith('●'), `title still dirty: ${tt} (mid ${mid})`);
    await page.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(300);
    const q = await dialogs();
    if (q.length) await clickDialog('取消');
    assert(!q.length, `false question: ${JSON.stringify(q)}`);
    return `mid ${mid}`;
  });

  await t('B6 Esc in a session without a change: title clean, source byte-identical', async () => {
    const D = ['# 标题 #', '', '* 星号项', '* 第二项', '', '甲  段落&nbsp;文字', ''].join('\n');
    await openOpfs('b6.md', D);
    await startIn(D, '星号项');
    await B.esc();
    await startIn(D, '甲');
    await page.keyboard.press('ArrowRight');
    await B.esc();
    const s = await B.source();
    assert(s === D, `source ${JSON.stringify(s)}`);
    assert(!(await title()).startsWith('●'), `title ${await title()}`);
  });
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  console.log('consoleErrors', JSON.stringify(B.consoleErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
