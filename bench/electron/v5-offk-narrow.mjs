// bench/electron/v5-offk-narrow.mjs — verify-off-desktop (0.2.0 r4 verification): the window at its minimum size
// and other narrow widths, light and dark, with the switch OFF: toolbar, status bar and preview geometry per build.
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-narrow.mjs > x.log
//   node bench/electron/v5-offk-menu.mjs --compare cand.log base.log
// Prints, per width x theme: the toolbar's height, its scrollWidth vs clientWidth, every toolbar button's
// visibility and rectangle (by data-cmd), the status bar height, the editor / preview pane widths and the preview's
// scrollHeight. Launch only through ./_electron.mjs. No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-narrow-')));
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
const DOC = `# 窄窗口\n\n${Array.from({ length: 20 }, (_, i) => `段落 ${i}：一些文字，足够换行的长度，用来看预览宽度是否一样。$x^${i}$`).join('\n\n')}\n\n- [ ] 任务\n`;
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
try {
  const f = path.join(TMP, 'narrow.md'); fs.writeFileSync(f, DOC);
  app = await electron.launch({ args: [DIR, f, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(1500);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('view.toggleTheme').click()); await sleep(600); }
    for (const w of [640, 720, 800, 1000]) {
      await app.evaluate(({ BrowserWindow }, ww) => { const b = BrowserWindow.getAllWindows()[0]; b.setContentSize(ww, 500); }, w);
      await sleep(700);
      const g = await page.evaluate(() => {
        const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
        const tb = document.querySelector('.mdr-toolbar, [role=toolbar], header');
        const btns = {};
        for (const b of (tb ? tb.querySelectorAll('[data-cmd], button') : [])) { const k = b.getAttribute('data-cmd') || b.textContent.trim().slice(0, 8); const cs = getComputedStyle(b); btns[k] = (cs.display === 'none' || cs.visibility === 'hidden' ? 'hidden ' : '') + JSON.stringify(r(b)); }
        const prev = document.querySelector('.mdr-preview');
        return {
          vw: innerWidth, tb: r(tb), tbOverflow: tb ? `${tb.scrollWidth}/${tb.clientWidth}` : null, btns,
          status: r(document.querySelector('.mdr-status, .mdr-statusbar, footer')), editor: r(document.querySelector('.cm-editor')), preview: r(prev), prevScrollH: prev ? prev.scrollHeight : null,
          docScroll: `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`, theme: document.documentElement.getAttribute('data-theme'),
          bg: getComputedStyle(document.body).backgroundColor, prevBg: prev ? getComputedStyle(prev).backgroundColor : null,
        };
      });
      out(`${theme}-${w}`, g);
    }
  }
} catch (e) {
  console.log('THREW', String(e).split('\n')[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
