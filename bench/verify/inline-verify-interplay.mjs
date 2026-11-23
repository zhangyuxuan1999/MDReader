// bench/verify/inline-verify-interplay.mjs — verifier: in-preview editing vs the rest of the app (CONTRACT §11):
// ⌘S (web legacy download), mode switches, open/new file, theme, TOC, global shortcuts, editor-only shortcuts,
// Alt+click, checkboxes, links, toggle OFF, drafts; plus 3 screenshots.
// Run: node bench/verify/inline-verify-interplay.mjs   (own vite :5263, killed at exit)
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, stopServer, openBrowser, readRoot, check, note, step, assert, eq, finish, sleep, ROOT } from './inline-verify-lib.mjs';

const SHOTS = resolve(ROOT, 'bench/verify/out/inline-verify-shots');
mkdirSync(SHOTS, { recursive: true });
const DOC = [
  '# 标题一', '', '第一段落，含[外部链接](https://example.org/)和[锚点](#标题二)。', '', '- [ ] 任务一', '- [x] 任务二', '',
  '## 标题二', '', '第二段落文字。', '', '### 标题三', '', '第三段落文字。', '',
].join('\n') + '\n';
const L = (needle) => DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;

await startServer();
const B = await openBrowser();
const { page } = B;
const startSession = async (needle = '第二段落文字。') => {
  await B.clickLine(L(needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
};
const modeOf = () => page.evaluate(() => document.querySelector('.mdr-app')?.dataset.mode);

try {
  await B.boot('mode=split');

  // ------------------------------------------------------------ ⌘S web legacy download
  // ------------------------------------------------------------ mode switches
  await step('⌘/ (cycle mode) during a session → text committed, session ended, no duplicate write', async () => {
    await B.loadDoc(DOC);
    await startSession();
    await page.keyboard.type('切换');
    await page.keyboard.press('ControlOrMeta+/');
    await sleep(300);
    const m = await modeOf();
    const e = await B.editing();
    const s = await B.source();
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(200);
    assert(s.includes('第二段落文字。切换\n'), `source: ${s.split('\n')[9]}`);
    eq(e, null, 'session after mode switch');
    return `mode → ${m}`;
  });
  await step('mode → preview during a session keeps the typed text; typing again in preview mode works', async () => {
    await B.loadDoc(DOC);
    await startSession();
    await page.keyboard.type('一');
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(300);
    await B.clickLine(L('第二段落文字。'), 'first', '第二');
    await B.caretAt('第二段落文字。一');
    await page.keyboard.type('二');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(200);
    assert(s.includes('第二段落文字。一二'), s.split('\n')[9]);
  });

  // ------------------------------------------------------------ theme toggle
  await step('⌘⇧L (theme) during a session → theme flips, session and caret survive, typing continues', async () => {
    await B.loadDoc(DOC);
    await startSession();
    const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press('ControlOrMeta+Shift+l');
    await sleep(200);
    const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
    const e = await B.editing();
    const caret = await B.caretInEditing();
    await page.keyboard.type('主题');
    await B.settle(250);
    const s = await B.source();
    await B.esc();
    await page.keyboard.press('ControlOrMeta+Shift+l');
    assert(t0 !== t1, `theme ${t0} → ${t1}`);
    assert(e && caret, `session ${!!e} caret ${caret}`);
    assert(s.includes('第二段落文字。主题'), s.split('\n')[9]);
    return `${t0} → ${t1}`;
  });

  // ------------------------------------------------------------ ⌘⇧P palette, ⌘⇧O TOC
  await step('⌘⇧P during a session → palette opens, typed text already committed; Esc closes palette', async () => {
    await B.loadDoc(DOC);
    await startSession();
    await page.keyboard.type('面板');
    await page.keyboard.press('ControlOrMeta+Shift+p');
    await sleep(250);
    const pal = await page.evaluate(() => !!document.querySelector('.mdr-palette, [class*="palette"] input'));
    const s = await B.source();
    const e = await B.editing();
    await page.keyboard.press('Escape');
    await sleep(200);
    assert(pal, 'palette not open');
    assert(s.includes('第二段落文字。面板'), s.split('\n')[9]);
    return `session after palette: ${e ? 'alive' : 'ended'}`;
  });
  await step('⌘⇧O during a session → TOC toggles, session survives', async () => {
    await B.loadDoc(DOC);
    await startSession();
    const v0 = await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.toc);
    await page.keyboard.press('ControlOrMeta+Shift+o');
    await sleep(250);
    const v1 = await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.toc);
    const e = await B.editing();
    await page.keyboard.type('目');
    await B.settle(200);
    const s = await B.source();
    await B.esc();
    await page.keyboard.press('ControlOrMeta+Shift+o');
    assert(v0 !== v1, `toc ${v0} → ${v1}`);
    assert(e && s.includes('第二段落文字。目'), `session ${!!e}; ${s.split('\n')[9]}`);
    return `toc ${v0} → ${v1}`;
  });
  await step('TOC click during a session → session ends with text committed, preview navigates to the heading', async () => {
    await B.loadDoc(DOC);
    const shown = await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.toc);
    if (shown !== 'open') { await page.keyboard.press('ControlOrMeta+Shift+o'); await sleep(250); }
    await startSession();
    await page.keyboard.type('目录');
    const item = page.locator('.mdr-toc a, .mdr-toc [data-line], .mdr-toc li').filter({ hasText: '标题三' }).first();
    await item.click();
    await sleep(400);
    const s = await B.source();
    const e = await B.editing();
    assert(s.includes('第二段落文字。目录'), s.split('\n')[9]);
    eq(e, null, 'session after TOC click');
  });

  // ------------------------------------------------------------ editor-only shortcuts
  for (const [key, label] of [['ControlOrMeta+f', '查找'], ['ControlOrMeta+2', '标题 2'], ['ControlOrMeta+Shift+x', '切换任务']]) {
    await step(`editor-only shortcut ${label} (${key}) during a session — report (text must be committed)`, async () => {
      await B.loadDoc(DOC);
      await startSession();
      await page.keyboard.type('键');
      await page.keyboard.press(key);
      await sleep(300);
      const s = await B.source();
      const e = await B.editing();
      const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest('.mdr-editor'));
      const m = await modeOf();
      await page.keyboard.press('Escape');
      await sleep(100);
      assert(s.includes('第二段落文字。键'), `text lost: ${s.split('\n')[9]}`);
      const changed = s.split('\n')[9];
      return `session ${e ? 'kept' : 'ended'}, focus in editor ${focusInEditor}, mode ${m}, line «${changed}»`;
    });
  }

  // ------------------------------------------------------------ Alt+click, checkboxes, links
  await step('Alt+click on a preview paragraph (no session) still jumps the editor caret to that line', async () => {
    await B.loadDoc(DOC);
    const pt = await B.textPoint(L('第三段落'), 'first');
    await page.keyboard.down('Alt'); await page.mouse.click(pt.x, pt.y); await page.keyboard.up('Alt');
    await sleep(300);
    const r = await page.evaluate(() => { const v = window.__mdr.app.editor.view; return { line: v.state.doc.lineAt(v.state.selection.main.head).number, focus: v.hasFocus }; });
    eq(r.line, L('第三段落'), 'editor line');
    eq(await B.editing(), null, 'Alt+click started a session');
  });
  await step('Alt+click during a session → session ends (committed) and the editor jumps', async () => {
    await B.loadDoc(DOC);
    await startSession();
    await page.keyboard.type('跳');
    const pt = await B.textPoint(L('第三段落'), 'first');
    await page.keyboard.down('Alt'); await page.mouse.click(pt.x, pt.y); await page.keyboard.up('Alt');
    await sleep(300);
    const r = await page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
    const s = await B.source();
    assert(s.includes('第二段落文字。跳'), 'text lost');
    eq(r, L('第三段落'), 'editor line');
  });
  await step('checkbox outside a session toggles the source; inside a session toggles too', async () => {
    await B.loadDoc(DOC);
    const box = async (i) => page.evaluate((i) => { const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(5).id); const r = el.querySelectorAll('input[type=checkbox]')[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    let p = await box(0);
    await page.mouse.click(p.x, p.y);
    await B.settle(300);
    const s1 = (await B.source()).split('\n')[4];
    const e1 = await B.editing();
    await B.clickLine(5, 'first', '任务一');
    assert(await B.editing(), 'no session in list');
    p = await box(1);
    await page.mouse.click(p.x, p.y);
    await B.settle(300);
    const s2 = (await B.source()).split('\n').slice(4, 6);
    await B.esc();
    eq(s1, '- [x] 任务一', 'outside session');
    eq(e1, null, 'checkbox click started a session');
    eq(s2.join('|'), '- [x] 任务一|- [ ] 任务二', 'inside session');
  });
  await step('links: outside a session a click navigates (anchor scrolls); inside a session a click places the caret', async () => {
    await B.loadDoc(DOC);
    const pv0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    const a = await page.evaluate(() => { const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(3).id); const r = el.querySelector('a[href="#标题二"], a[href^="#"]').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
    await page.mouse.click(a.x, a.y);
    await sleep(400);
    const e1 = await B.editing();
    const edLine = await page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
    // inside a session
    await B.clickLine(3, 'first', '第一段落');
    const ext = await page.evaluate(() => { const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(3).id); const r = el.querySelector(`a[href^="https"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const popup = page.context().waitForEvent('page', { timeout: 800 }).catch(() => null);
    await page.mouse.click(ext.x, ext.y);
    const pg = await popup;
    await sleep(150);
    const inLink = await page.evaluate(() => !!getSelection().anchorNode?.parentElement?.closest('a'));
    const e2 = await B.editing();
    await B.esc();
    if (pg) await pg.close();
    eq(e1, null, 'anchor click outside a session started one');
    assert(edLine === L('## 标题二'), `anchor did not navigate the editor (line ${edLine})`);
    assert(e2 && inLink && !pg, `inside session: session ${!!e2} caretInLink ${inLink} popup ${!!pg}`);
  });

  // ------------------------------------------------------------ toggle OFF restores old behaviour
  await step('toggle OFF (⌘⇧E) during a session → session ends committed; clicks select text, no contenteditable, no hint', async () => {
    await B.loadDoc(DOC);
    await startSession();
    await page.keyboard.type('关');
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await sleep(300);
    const s = await B.source();
    const on = await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable());
    const pt = await B.textPoint(L('第三段落'), 'first');
    await page.mouse.dblclick(pt.x, pt.y);
    await sleep(200);
    const r = await page.evaluate(() => ({ ce: document.querySelectorAll('.mdr-preview [contenteditable="true"]').length, hint: (() => { const h = document.querySelector('.mdr-preview__edit-hint'); return !!h && !h.hidden; })(), sel: getSelection().toString() }));
    await page.keyboard.type('X');
    await sleep(200);
    const s2 = await B.source();
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await sleep(200);
    assert(s.includes('第二段落文字。关'), 'text lost on toggle off');
    eq(on, false, 'editable');
    eq(r.ce, 0, 'contenteditable count');
    eq(r.hint, false, 'hint visible');
    eq(s2, s, 'typing with toggle off changed the source');
    return `dblclick selected «${r.sel}»`;
  });

  // ------------------------------------------------------------ drafts
  await step('drafts autosave the preview-edited text (IndexedDB record contains it)', async () => {
    await B.loadDoc(DOC, 'draft.md');
    await startSession();
    await page.keyboard.type('草稿内容');
    await B.settle(300);
    await B.esc();
    await sleep(2500);
    const rec = await page.evaluate(() => new Promise((res) => {
      const rq = indexedDB.open('keyval-store');
      rq.onerror = () => res({ err: 'open' });
      rq.onsuccess = () => {
        const db = rq.result;
        try {
          const tx = db.transaction('keyval', 'readonly'); const st = tx.objectStore('keyval');
          const all = st.getAll(); const keys = st.getAllKeys();
          tx.oncomplete = () => res({ keys: keys.result.map(String), texts: all.result.filter((v) => v && typeof v.text === 'string').map((v) => v.text) });
        } catch (e) { res({ err: String(e) }); }
      };
    }));
    const status = await page.evaluate(() => [...document.querySelectorAll('.mdr-statusbar__item')].map((e) => e.textContent).join(' | '));
    assert(rec.texts && rec.texts.some((t) => t.includes('第二段落文字。草稿内容')), `draft records: ${JSON.stringify(rec).slice(0, 200)}`);
    return `status: ${status}`;
  });

  // ------------------------------------------------------------ screenshots
  await step('screenshots: session + hint (light, dark) and split view after Enter', async () => {
    await B.loadDoc(readRoot('test-data/small.md').split('\n').slice(0, 60).join('\n'), 'small.md');
    const P = 7;
    await B.clickLine(P, 'first', 'quick');
    await B.caretAt('quick');
    await page.keyboard.type(' 正在预览里直接编辑');
    await B.settle(200);
    await page.screenshot({ path: resolve(SHOTS, '1-session-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.keyboard.press('ControlOrMeta+Shift+l');
    await sleep(300);
    const th = await page.evaluate(() => document.documentElement.dataset.theme);
    if (th !== 'dark') { await page.keyboard.press('ControlOrMeta+Shift+l'); await sleep(300); }
    await page.screenshot({ path: resolve(SHOTS, '2-session-dark.png') });
    await page.keyboard.press('ControlOrMeta+Shift+l');
    await sleep(200);
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'light') { await page.keyboard.press('ControlOrMeta+Shift+l'); await sleep(200); }
    await B.caretAt('jumps');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新段落从这里开始');
    await B.settle(400);
    await page.screenshot({ path: resolve(SHOTS, '3-split-after-enter.png') });
    await B.esc();
    return SHOTS;
  });

  await step('⌘S during a session (web legacy download: no File System Access API) → download has the typed text; session survives', async () => {
    const ctx2 = await B.browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await ctx2.addInitScript(() => { try { delete window.showSaveFilePicker; delete window.showOpenFilePicker; delete window.showDirectoryPicker; } catch { /* */ } try { delete Window.prototype.showSaveFilePicker; delete Window.prototype.showOpenFilePicker; } catch { /* */ } });
    const p2 = await ctx2.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e))); p2.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    const { makeHelpers } = await import('./inline-verify-lib.mjs');
    const H = makeHelpers(p2);
    await H.boot('mode=split');
    const fsa = await p2.evaluate(() => typeof window.showSaveFilePicker);
    await H.loadDoc(DOC, 'save.md');
    await H.clickLine(L('第二段落文字。'), 'first', '第二');
    await H.caretAt('第二段落文字。');
    await p2.keyboard.type('存盘');
    const dl = p2.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await p2.keyboard.press('ControlOrMeta+s');
    const d = await dl;
    await p2.keyboard.type('后');
    await H.settle(300);
    const e = await H.editing();
    const text = d ? readFileSync(await d.path(), 'utf8') : null;
    const src = await H.source();
    const status = await p2.evaluate(() => [...document.querySelectorAll('.mdr-statusbar__item')].map((x) => x.textContent).join(' | '));
    await ctx2.close();
    assert(d, `no download (showSaveFilePicker: ${fsa})`);
    assert(text.includes('第二段落文字。存盘'), `downloaded: ${JSON.stringify(text.slice(0, 120))}`);
    assert(e, 'session ended by ⌘S');
    assert(src.includes('第二段落文字。存盘后'), `typing after ⌘S: ${src.split('\n')[9]}`);
    assert(errs.length === 0, errs.join(' | '));
    return `downloaded ${d.suggestedFilename()} (${text.length} chars); status ${status}`;
  });


  // ------------------------------------------------------------ new file / open during a session (no stale write into the new doc)
  await step('新建 (file.new) right after typing (before the rAF write) → guard sees the typed text; 取消 keeps it; 放弃 → empty doc, no late write', async () => {
    await B.loadDoc(DOC, 'newfile.md');
    await startSession();
    await page.keyboard.type('未存');
    await page.evaluate(() => { window.__mdr.app.registry.run('file.new'); });
    await sleep(250);
    const dlg = await page.evaluate(() => { const d = document.querySelector('.mdr-dialog'); return d ? { text: d.querySelector('.mdr-dialog__text')?.textContent, btns: [...d.querySelectorAll('button')].map((b) => b.textContent) } : null; });
    const s1 = await B.source();
    assert(dlg, 'no discard guard (typed text not seen as dirty?)');
    assert(s1.includes('第二段落文字。未存'), `not committed: ${s1.split('\n')[9]}`);
    await page.locator('.mdr-dialog button').filter({ hasNotText: /放弃|丢弃|不保存/ }).first().click();
    await sleep(250);
    const s2 = await B.source();
    assert(s2 === s1, 'cancel changed the document');
    await page.evaluate(() => { window.__mdr.app.registry.run('file.new'); });
    await sleep(250);
    await page.locator('.mdr-dialog button').filter({ hasText: /放弃|丢弃|不保存/ }).first().click();
    await sleep(800);
    const s3 = await B.source();
    eq(s3, '', 'new doc text');
    eq(await B.editing(), null, 'session after new');
    return `guard «${dlg.text}» [${dlg.btns.join(', ')}]`;
  });
  await step('opening another document right after typing (before the rAF write) → new doc exact, old text not injected', async () => {
    await B.loadDoc(DOC, 'a.md');
    await startSession();
    await page.keyboard.type('旧文');
    const other = '# 另一个文档\n\n完全不同的内容。\n';
    await page.evaluate((t) => window.__mdr.loadText(t, 'b.md'), other);
    await sleep(800);
    const s = await B.source();
    eq(s, other, 'opened doc');
    eq(await B.editing(), null, 'session after open');
  });
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
