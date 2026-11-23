// bench/electron/v5-offk-j13.mjs — verify-off-desktop (0.2.0 r4 verification): J13 / U24 variations in the real
// desktop window, switch OFF (production renderer, nothing stored), one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-j13.mjs [case ...]
// Real (trusted) mouse and key input through Playwright; webContents.setZoomFactor for the zoomed case. Prints
// OBS <case> {...} with the source's task lines before / after. Launch only through ./_electron.mjs. No full screen.
// Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-j13-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const OVER = 'position:absolute;left:0;top:0;width:100%;height:3000px;opacity:0;display:block;z-index:5';
const DOCS = {
  overlay: `Intro paragraph you click to read.\n\n- <label style="${OVER}">x\n  - [ ] wire the money\n\nlast line\n`,
  'overlay-fixed': `Intro paragraph you click to read.\n\n- <label style="position:fixed;left:0;top:0;right:0;bottom:0;opacity:0;display:block;z-index:50">x\n  - [ ] wire the money\n\nlast line\n`,
  'wrap-list': `Intro paragraph.\n\n<label>\n\n- [ ] first task text\n- [ ] second task\n\n</label>\n\nlast line\n`,
  'visible-label': `Intro.\n\n- <label>click this label text\n  - [ ] nested task\n\nend\n`,
};
async function launch() {
  app = await electron.launch({ args: [DIR, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(900);
}
const src = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).filter((l) => /\[[ xX]\]/.test(l)).join('|'));
const boxes = () => page.evaluate(() => [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((b) => (b.checked ? 1 : 0)).join(''));
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
async function open(name) {
  const f = path.join(TMP, `${name}.md`); fs.writeFileSync(f, DOCS[name]);
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, f);
  const d = Date.now() + 6000;
  while (Date.now() < d) { await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃'); if (b) b.click(); }); if ((await page.evaluate(() => document.title)).replace('● ', '') === `${name}.md`) break; await sleep(100); }
  await sleep(900);
}
const ptOf = (sel, re) => page.evaluate(([s, r]) => { const e = [...document.querySelectorAll(s)].find((x) => new RegExp(r).test(x.textContent)); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 }; }, [sel, re]);
const boxPt = (i) => page.evaluate((k) => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
const hitAt = (pt) => page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + (e.closest('.mdr-preview') ? '@preview' : e.closest('.cm-editor') ? '@editor' : '') : null; }, pt);
const obs = async () => ({ src: await src(), boxes: await boxes(), toasts: await toasts(), title: await page.evaluate(() => document.title), focus: await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + (a.closest('.mdr-preview') ? '@preview' : a.closest('.cm-editor') ? '@editor' : '') : null; }) });
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);

const CASES = {
  async overlay() {
    await open('overlay'); const a = await obs();
    const pt = await ptOf('.mdr-preview p', '^Intro'); const hit = await hitAt(pt);
    await page.mouse.click(pt.x, pt.y); await sleep(600); const b = await obs();
    await page.keyboard.press('Space'); await sleep(500); const c = await obs();
    await page.mouse.dblclick(pt.x, pt.y + 30); await sleep(600); const d = await obs();
    out('overlay', { hit, a, b, afterSpace: c, afterDbl: d });
  },
  async 'overlay-zoom'() {
    await open('overlay');
    const r = {};
    for (const z of [0.8, 1.5, 2]) {
      await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), z);
      await sleep(700);
      const pt = await ptOf('.mdr-preview p', '^Intro');
      await page.mouse.click(pt.x, pt.y); await sleep(600);
      r[z] = await obs();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    out('overlay-zoom', r);
  },
  async 'overlay-fixed'() {
    await open('overlay-fixed'); const a = await obs();
    const pe = await page.evaluate(() => { const e = document.querySelector('.cm-content .cm-line'); const b = e.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; });
    const hit = await hitAt(pe);
    await page.mouse.click(pe.x, pe.y); await sleep(600); const b = await obs();
    await page.keyboard.type('Q'); await sleep(400); const c = await obs();
    out('overlay-fixed', { hit, a, b, typed: c });
  },
  async 'wrap-list'() {
    await open('wrap-list'); const a = await obs();
    const pt = await ptOf('.mdr-preview li', 'second task'); const hit = await hitAt(pt);
    await page.mouse.click(pt.x + 30, pt.y); await sleep(600); const b = await obs();
    const bp = await boxPt(1);
    await page.mouse.click(bp.x, bp.y); await sleep(600); const c = await obs();
    const bp0 = await boxPt(0);
    await page.mouse.move(bp0.x, bp0.y); await page.mouse.down(); await page.keyboard.press('Shift'); await page.mouse.up(); await sleep(600); const d = await obs();
    out('wrap-list', { hit, a, textClick: b, ownBox: c, pressShiftRelease: d });
  },
  async 'visible-label'() {
    await open('visible-label'); const a = await obs();
    const pt = await ptOf('.mdr-preview label', 'click this label'); const hit = await hitAt(pt);
    await page.mouse.click(pt.x, pt.y); await sleep(600); const b = await obs();
    await page.keyboard.press('Space'); await sleep(500); const c = await obs();
    const bp = await boxPt(0);
    await page.mouse.click(bp.x, bp.y); await sleep(600); const d = await obs();
    await page.keyboard.press('Space'); await sleep(500); const e = await obs();
    out('visible-label', { hit, a, labelClick: b, spaceAfterLabel: c, boxClick: d, spaceAfterBox: e });
  },
};
try {
  await launch();
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try { await fn(); } catch (e) { out(name, { threw: String(e).split('\n')[0] }); }
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
