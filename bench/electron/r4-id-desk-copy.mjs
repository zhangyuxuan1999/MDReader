// bench/electron/r4-id-desk-copy.mjs — fix-session-d (round 4, item 4: J2 / P-A) in the desktop dev shell: the edit
// menu's 拷贝 and 剪切 (role items: webContents.copy() / cut()) on a session selection that holds the U21 spacer put no
// U+200B on Electron's clipboard, and an ordinary selection is copied as the browser copies it. Prints PASS / FAIL.
//   MDR_DEV_URL=http://localhost:5466/ node bench/electron/r4-id-desk-copy.mjs
// Dev shell = electron/ of the tree. Launch only through ./_electron.mjs (isolated profile). The system clipboard is
// saved inside the main process before the first copy (clipboard.read(): ClipboardItems) and written back at the end (its content never leaves that
// process). Global timeout 100 s; the instance is ended with app.exit(0) (no window in full screen), then SIGKILLed if
// it is still there.
import { electron } from './_electron.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
let app = null;
let proc = null;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };
async function finish() {
  try { await app?.evaluate(async ({ clipboard }) => { const s = globalThis.__r4idClip; if (!s) return; if (s.length) await clipboard.write(s); else clipboard.clear(); }); } catch { /* */ }
  try { await Promise.race([app?.evaluate(({ app: a, BrowserWindow }) => { if (BrowserWindow.getAllWindows().some((w) => w.isFullScreen())) return; a.exit(0); }), sleep(3000)]); } catch { /* */ }
  await sleep(1500);
  try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* */ }
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await finish(); process.exit(3); }, 100_000);
const ZW = String.fromCharCode(0x200b);
const DOC = '$x^2$ starts this para here\n\nplain para with words\n\nlast\n';
try {
  app = await electron.launch({ args: [ROOT], env: { ...process.env, MDR_DEV_URL: process.env.MDR_DEV_URL || 'http://localhost:5466/' } });
  proc = app.process();
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 300 && !(await page.evaluate(() => !!window.__mdr?.app).catch(() => false)); i++) await sleep(100);
  await sleep(1200);
  // (Electron 44: clipboard.read() gives ClipboardItems; they stay in the main process and are written back at the end)
  await app.evaluate(async ({ clipboard }) => { globalThis.__r4idClip = await clipboard.read(); });
  const menu = (label) => app.evaluate(({ Menu, BrowserWindow }, lb) => {
    const find = (items) => { for (const it of items) { if (it.label === lb) return it; if (it.submenu) { const r = find(it.submenu.items); if (r) return r; } } return null; };
    const it = find(Menu.getApplicationMenu().items);
    const w = BrowserWindow.getAllWindows()[0];
    if (!it) return false;
    w.focus();
    it.click(undefined, w, w.webContents);
    return it.role || true;
  }, label);
  /** The menu item; when the OS focus is elsewhere (other test windows) the role does not reach the page: the call the
   *  role makes (webContents.copy() / cut()) instead. Returns which path wrote the clipboard. */
  const menuOrRole = async (label) => {
    const role = await menu(label);
    await sleep(300);
    if ((await clip()).text !== '<<none>>') return 'menu';
    await app.evaluate(({ BrowserWindow }, r) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents[r === 'cut' ? 'cut' : 'copy'](); }, role);
    await sleep(300);
    return 'webContents.' + role;
  };
  const clip = () => app.evaluate(async ({ clipboard }) => {
    const r = { text: String(await clipboard.readText()), html: '' };
    for (const it of await clipboard.read()) if (it.types.includes('text/html')) r.html = await (await it.getType('text/html')).text();
    return r;
  });
  const point = (needle, k = 1) => page.evaluate(({ needle, k }) => {
    const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { needle, k });
  const load = async () => {
    await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
    await page.evaluate((t) => window.__mdr.loadText(t, 'desk-copy.md'), DOC);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(500);
  };
  const session = async (needle) => {
    const p = await point(needle);
    await page.mouse.click(p.x, p.y);
    await sleep(400);
    return page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  };
  // 1. ⌘A in the session on the paragraph that starts with a formula, menu 拷贝
  await load();
  const s1 = await session('starts');
  await page.keyboard.press('Meta+a'); await sleep(200);
  const selZw = await page.evaluate((zw) => getSelection().toString().includes(zw), ZW);
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<none>>'); });
  const m1 = await menuOrRole('拷贝'); await sleep(100);
  const c1 = await clip();
  const back = await page.evaluate((zw) => (document.querySelector('.mdr-preview .is-editing')?.textContent ?? '').includes(zw), ZW);
  check('menu-copy-helper', s1 && selZw && c1.text !== '<<none>>' && !c1.text.includes(ZW) && !c1.html.includes(ZW) && back,
    `session=${s1} via=${m1} selectionHeldSpacer=${selZw} text=${J(c1.text.slice(0, 40))} zwText=${c1.text.includes(ZW)} zwHtml=${c1.html.includes(ZW)} spacerBackAfter=${back}`);
  // 2. the same with ⌘C (the keyboard path in the desktop shell)
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<none>>'); });
  await page.keyboard.press('Meta+c'); await sleep(400);
  const c2 = await clip();
  check('key-copy-helper', c2.text !== '<<none>>' && !c2.text.includes(ZW) && !c2.html.includes(ZW), `text=${J(c2.text.slice(0, 40))}`);
  // 3. an ordinary selection (a double-clicked word, no helper): copied as the browser copies it
  await page.keyboard.press('Escape'); await sleep(300);
  const p3 = await point('with');
  await page.mouse.move(p3.x, p3.y); await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 }); await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); await sleep(300);
  const sel3 = await page.evaluate(() => getSelection().toString());
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<none>>'); });
  const m3 = await menuOrRole('拷贝'); await sleep(100);
  const c3 = await clip();
  check('menu-copy-ordinary', c3.text === sel3 && sel3.length > 0, `via=${m3} selection=${J(sel3)} clipboard=${J(c3.text)}`);
  // 4. menu 剪切 over the helper: the clipboard and the source hold no U+200B, the text is gone from the source
  await page.keyboard.press('Escape'); await sleep(300);
  await load();
  await session('starts');
  await page.keyboard.press('Meta+a'); await sleep(200);
  await app.evaluate(async ({ clipboard }) => { await clipboard.writeText('<<none>>'); });
  const m4 = await menuOrRole('剪切'); await sleep(300);
  const c4 = await clip();
  await page.keyboard.press('Escape'); await sleep(500);
  const src4 = await page.evaluate(() => window.__mdr.app.getText());
  check('menu-cut-helper', c4.text !== '<<none>>' && !c4.text.includes(ZW) && !src4.includes(ZW) && !src4.includes('starts'), `via=${m4} clipboard=${J(c4.text.slice(0, 40))} source=${J(src4)}`);
} catch (e) {
  fail++;
  console.log('ERROR', String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(KILL);
  console.log(`${pass}/${pass + fail} passed`);
  await finish();
  process.exitCode = fail ? 1 : 0;
}
