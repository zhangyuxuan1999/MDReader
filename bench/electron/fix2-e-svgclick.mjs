// bench/electron/fix2-e-svgclick.mjs — fix-shell (0.2.0 stage 2b): is a Playwright click on an SVG
// <a> whose navigation the shell cancels actually delivered (page click listener + will-navigate in
// the main process), and does the page keep working afterwards? Diagnostic for v2-shell-doclink.
//   MDR_APP_DIR=<shell dir> node bench/electron/fix2-e-svgclick.mjs
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-fix2e-svg-'));
let app = null;
const timer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await done(); process.exit(2); }, 90000);
async function done() {
  if (app) {
    const pid = app.process()?.pid;
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    app = null;
  }
  fs.rmSync(prof, { recursive: true, force: true });
}
try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__ev = [];
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.on('will-navigate', (e) => globalThis.__ev.push(`will-navigate ${e.url} prevented=${e.defaultPrevented}`));
  });
  await page.evaluate((href) => {
    window.__clicks = 0;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:40px;top:120px;z-index:99999;background:#fff';
    box.innerHTML = `<svg width="260" height="40"><a href="${href}"><text x="5" y="25" font-size="20">FIX2E-CLICK</text></a></svg>`;
    document.body.appendChild(box);
    document.addEventListener('click', () => { window.__clicks++; }, true);
  }, process.env.HREF || '//mdreader/nonexistent.md');
  // A real input event from the main process, twice: is the page still taking clicks after the first
  // (cancelled) navigation? (Playwright's own actions hang after a cancelled navigation, baseline too.)
  for (let i = 1; i <= 2; i++) {
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 60, y: 145, button: 'left', clickCount: 1 });
    });
    await sleep(800);
    const clicks = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.__clicks'));
    const ev = await app.evaluate(({ BrowserWindow }) => { const r = [...globalThis.__ev, `URL ${BrowserWindow.getAllWindows()[0].webContents.getURL()}`]; globalThis.__ev = []; return r; });
    console.log(`== sendInputEvent #${i}: pageClicks=${clicks}`);
    for (const e of ev) console.log(`   ${e}`);
  }
  if (process.env.PW_CLICKS === '1') for (const mode of ['locator', 'locator-noWaitAfter', 'mouse']) {
    let res = 'ok';
    const t0 = Date.now();
    try {
      if (mode === 'mouse') {
        const b = await page.locator('svg text').filter({ hasText: 'FIX2E-CLICK' }).boundingBox();
        await page.mouse.click(b.x + 10, b.y + b.height / 2);
      } else {
        await page.locator('svg text').filter({ hasText: 'FIX2E-CLICK' }).click({ timeout: 4000, ...(mode === 'locator-noWaitAfter' ? { noWaitAfter: true } : {}) });
      }
    } catch (e) { res = String(e.message).split('\n')[0]; }
    await sleep(800);
    const clicks = await page.evaluate(() => window.__clicks).catch((e) => `ERR ${e.message}`);
    const ev = await app.evaluate(({ BrowserWindow }) => { const r = [...globalThis.__ev, `URL ${BrowserWindow.getAllWindows()[0].webContents.getURL()}`]; globalThis.__ev = []; return r; });
    console.log(`== ${mode}: ${res} (${Date.now() - t0} ms) pageClicks=${clicks}`);
    for (const e of ev) console.log(`   ${e}`);
  }
  const alive = await page.evaluate(() => document.title).catch((e) => `ERR ${e.message}`);
  console.log(`page alive: title=${JSON.stringify(alive)}`);
} finally {
  clearTimeout(timer);
  await done();
}
