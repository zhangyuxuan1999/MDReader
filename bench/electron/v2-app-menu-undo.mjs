// bench/electron/v2-app-menu-undo.mjs — verify-app (0.2.0 stage 2a): 编辑 → 撤销 / 重做 (native menu items,
// clicked through Menu.getMenuItemById) with the focus in different places, on the dev shell of a given app dir
// and a given renderer. Prints RESULT lines (values, no verdicts) so candidate and baseline can be diffed.
//   candidate: MDR_SHELL_DIR=. MDR_DEV_URL=http://localhost:5283 node bench/electron/v2-app-menu-undo.mjs
//   baseline:  MDR_SHELL_DIR=release/baseline-0.1.1.noindex MDR_DEV_URL=http://127.0.0.1:5293 node bench/electron/v2-app-menu-undo.mjs
// (5293 = the verifier's static server of the 0.1.1 dist that adds ?perf=1, so window.__mdr exists.)
// Launch only through ./_electron.mjs (isolated profile). Global timeout 100 s.
import { electron } from './_electron.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(ROOT, process.env.MDR_SHELL_DIR || '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
let app = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ } process.exit(3); }, 100_000);
const menuClick = (id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);

try {
  app = await electron.launch({ args: [DIR], env: { ...process.env, MDR_DEV_URL: process.env.MDR_DEV_URL || 'http://localhost:5283' } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 300 && !(await page.evaluate(() => !!window.__mdr).catch(() => false)); i++) await sleep(100);
  await sleep(700);
  const src = () => page.evaluate(() => window.__mdr.app.getText());
  const load = async () => {
    await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
    await page.evaluate(() => window.__mdr.loadText('第一行文字。\n\n第二行文字。\n', 'u.md'));
    await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(1).to } }); });
    await page.keyboard.type('ABC'); await sleep(700);
  };
  const state = () => page.evaluate(() => ({
    active: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).split(' ')[0]}` : null,
    value: document.activeElement && 'value' in document.activeElement ? document.activeElement.value : undefined,
    palette: !!document.querySelector('.mdr-palette:not([hidden])'),
    mode: document.querySelector('.mdr-app')?.dataset.mode,
  }));

  await load();
  out('menu-undo, focus in editor', { before: (await src()).split('\n')[0], ok: await menuClick('edit.undo'), after: (await sleep(300), (await src()).split('\n')[0]) });

  await load();
  await page.keyboard.press('Meta+Shift+P'); await sleep(300);
  await page.keyboard.type('mode'); await sleep(150);
  await menuClick('edit.undo'); await sleep(400);
  out('menu-undo, focus in palette input (typed "mode")', { doc: (await src()).split('\n')[0], ...(await state()) });
  await page.keyboard.press('Escape'); await sleep(200);

  await load();
  await page.evaluate(() => window.__mdr.app.registry.run('edit.find')); await sleep(300);
  await page.keyboard.type('xyz'); await sleep(150);
  const s0 = await state();
  await menuClick('edit.undo'); await sleep(400);
  out('menu-undo, focus in find field (typed "xyz")', { before: s0, doc: (await src()).split('\n')[0], ...(await state()) });
  await page.keyboard.press('Escape'); await sleep(200);

  await load();
  await page.keyboard.press('Meta+z'); await sleep(300);
  out('keyboard Cmd-Z in editor', (await src()).split('\n')[0]);
} catch (e) {
  out('ERROR', String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(KILL);
  try { await app?.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* */ }
  await Promise.race([app?.close().catch(() => {}), sleep(4000)]);
}
