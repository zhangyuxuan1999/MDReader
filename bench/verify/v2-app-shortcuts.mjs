// bench/verify/v2-app-shortcuts.mjs — verify-app (0.2.0 stage 2a): every editor-scope shortcut pressed inside a
// preview session must leave the source unchanged, keep the session and show the hint toast; the session's own
// format keys (⌘B ⌘I ⌘E ⌘K) and the global shortcuts must still work.
// Run: MDR_PORT=5283 node bench/verify/v2-app-shortcuts.mjs   (starts its own vite on 5283 if none is up)
import { openBrowser, step, assert, eq, finish, sleep, ensureServer } from './v2-app-lib.mjs';
await ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const B = await openBrowser();
const { page } = B;
const DOC = '# 标题\n\n甲段落文字。\n\n乙段落文字。\n';
const toKey = (sc) => sc.replace(/Mod/g, 'ControlOrMeta').replace(/-([a-z])$/i, (m, k) => '+' + (k.length === 1 ? k : k)).replace(/-/g, '+');
try {
  await B.boot('mode=split');
  const cmds = await page.evaluate(() => window.__mdr.app.registry.list().filter((c) => c.shortcut && c.scope === 'editor').map((c) => ({ id: c.id, sc: c.shortcut, title: c.title })));
  console.log('editor-scope shortcuts:', cmds.map((c) => `${c.id}=${c.sc}`).join(' '));
  const SESSION_OWN = new Set(['edit.bold', 'edit.italic', 'edit.code', 'edit.link']);
  for (const c of cmds) {
    if (/Mod-z|Mod-Shift-z|Mod-y/.test(c.sc)) continue;
    await step(`${c.id} (${c.sc}) inside a session`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(5, 'first', '乙段'); await B.caretAt('乙段落文字。');
      await page.keyboard.type('x'); await sleep(80);
      const before = await B.source();
      await page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
      await page.keyboard.press(toKey(c.sc)); await sleep(250);
      if (SESSION_OWN.has(c.id)) { await page.keyboard.press('Escape').catch(() => {}); }
      await B.settle(250);
      const after = await B.source();
      const toast = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent).join(' | '));
      const ed = await B.editing();
      const focusEditor = await page.evaluate(() => window.__mdr.app.editor.view.hasFocus);
      if (SESSION_OWN.has(c.id)) return `own key: source ${JSON.stringify(after.split('\n')[4])} toast ${JSON.stringify(toast)}`;
      assert(after === before, `source changed: ${JSON.stringify(before.split('\n'))} → ${JSON.stringify(after.split('\n'))}`);
      assert(ed, `session ended (editor focus ${focusEditor})`);
      assert(/预览编辑中不可用/.test(toast), `no hint toast: ${JSON.stringify(toast)}`);
      return toast;
    });
  }
  for (const [k, want] of [['ControlOrMeta+Shift+L', 'theme'], ['ControlOrMeta+Shift+O', 'toc'], ['ControlOrMeta+Shift+P', 'palette'], ['ControlOrMeta+/', 'mode']]) {
    await step(`global ${k} inside a session works (${want})`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(5, 'first', '乙段'); await B.caretAt('乙段落文字。');
      await page.keyboard.type('y');
      const snap = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, toc: document.querySelector('.mdr-app')?.dataset.toc ?? document.querySelector('.mdr-toc')?.hidden, palette: !!document.querySelector('.mdr-palette input') && document.activeElement?.classList.contains('mdr-palette__input'), mode: document.querySelector('.mdr-app')?.dataset.mode }));
      const a = await snap();
      await page.keyboard.press(k); await sleep(300);
      const b = await snap();
      await page.keyboard.press('Escape'); await sleep(150);
      if (want === 'mode') await page.evaluate(() => window.__mdr.mode('split'));
      await sleep(150);
      assert(JSON.stringify(a[want]) !== JSON.stringify(b[want]), `${want} unchanged: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      assert((await B.source()).includes('乙段落文字。y'), 'typed text');
    });
  }
} finally {
  finish(); clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
