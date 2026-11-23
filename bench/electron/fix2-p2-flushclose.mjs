// bench/electron/fix2-p2-flushclose.mjs — fix-flows-2 (0.2.0 stage 2b), check item 7 on the desktop: the shell's
// close guard asks only while ITS copy of the dirty flag is set (electron/main.mjs). Text typed into a preview
// session of a clean document, followed by a window close before the next animation frame, must still be
// counted: the close question comes up and the window stays.
// Dev shell of the tree + a running Vite:  MDR_PORT=5314 node bench/electron/fix2-p2-flushclose.mjs
// (MDR_WHERE='preview session' or MDR_WHERE=editor runs one of the two cases.)
// Launches only through ./_electron.mjs (isolated profile). Global timeout 100 s.
import { electron } from './_electron.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = `http://localhost:${Number(process.env.MDR_PORT || 5314)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
let app = null;
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); try { app?.process()?.kill('SIGKILL'); } catch { /* */ } process.exit(3); }, 100_000);

async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}

try {
  app = await electron.launch({ args: [ROOT], env: { ...process.env, MDR_DEV_URL: BASE } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await until(page, () => !!window.__mdr, null, 30000);
  await sleep(1200);
  let lost = false;
  for (const where of process.env.MDR_WHERE ? [process.env.MDR_WHERE] : ['preview session', 'editor']) {
    for (const run of [1, 2, 3]) {
      await page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-dialog__btn')) if (b.textContent.trim() === '取消') b.click(); });
      await page.evaluate(() => window.__mdr.app.preview.endEditSession());
      await page.evaluate(() => window.__mdr.loadText('甲段落文字。\n\n乙段落文字。\n', `clean-${Math.random()}.md`));
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(400);
      if (where === 'preview session') {
        const pt = await page.evaluate(() => {
          const p = [...document.querySelectorAll('.mdr-preview section.md-block p')].find((e) => e.textContent.includes('甲段落'));
          const r = document.createRange(); r.setStart(p.firstChild, 5); r.setEnd(p.firstChild, 6);
          const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 };
        });
        await page.mouse.click(pt.x, pt.y);
        const ok = await until(page, () => !!document.querySelector('.mdr-preview .is-editing'), null, 3000);
        if (!ok) { check(`${where} run ${run}: session started`, false); continue; }
        await sleep(200);
      } else {
        await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }); });
        await sleep(200);
      }
      const dirtyBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited());
      // Type, then close from the main process (what ⌘W / the red button do) before the next animation frame:
      // frames are held back for 1.5 s (a busy renderer), so neither the session's flush nor the status refresh
      // has run when the shell decides.
      await page.evaluate(() => {
        const raf = window.requestAnimationFrame.bind(window);
        window.__fix2Raf = raf;
        window.requestAnimationFrame = (cb) => setTimeout(() => raf(cb), 1500);
        document.execCommand('insertText', false, 'Z');
      });
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); }).catch(() => {});
      await sleep(600);
      await page.evaluate(() => { if (window.__fix2Raf) window.requestAnimationFrame = window.__fix2Raf; }).catch(() => {});
      await sleep(1600);
      const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length).catch(() => 0);
      if (!alive) {
        check(`${where} run ${run}: the window stays and the close question asks (clean before: ${!dirtyBefore})`, false, 'the window closed without asking: the typed text was lost');
        lost = true;
        break;
      }
      const q = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
      const text = await page.evaluate(() => window.__mdr.app.getText());
      check(`${where} run ${run}: the window stays and the close question asks (clean before: ${!dirtyBefore})`, q.some((t) => t.includes('未保存')), `dialog ${JSON.stringify(q)}, text ${JSON.stringify(text.split('\n')[0])}`);
    }
    if (lost) { console.log('NOTE the window was lost; the remaining cases are skipped'); break; }
  }
} catch (e) {
  check('script', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(KILL);
  try { await app?.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* gone */ }
  await Promise.race([app?.close().catch(() => {}), sleep(4000)]);
  console.log(`${pass}/${pass + fails.length} checks passed`);
}
