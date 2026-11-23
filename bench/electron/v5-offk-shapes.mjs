// bench/electron/v5-offk-shapes.mjs — verify-off-desktop (0.2.0 r4 verification): every task-line shape the
// renderer gives a checkbox, clicked once in the real desktop window with the switch OFF, per build:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-shapes.mjs > x.log
//   node bench/electron/v5-offk-menu.mjs --compare cand.log base.log
// For each box (in document order): the source lines before / after the click, the box state and the toasts.
// Launch only through ./_electron.mjs. No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-shapes-')));
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
const TAB = String.fromCharCode(9);
const NBSP = String.fromCharCode(0xa0);
const SHAPES = [
  '- [ ] s01 dash', '* [ ] s02 star', '+ [ ] s03 plus', '- [x] s04 lower x', '- [X] s05 capital X',
  '-   [ ] s06 three spaces', `- [ ]${TAB}s07 tab after`, `-${TAB}[ ] s08 tab before`, '- [ ] s09 trailing  ',
  '1. [ ] s10 ordered', '2) [ ] s11 paren', '10. [ ] s12 ten',
  '- [ ] s13 parent\n  - [ ] s14 child two\n    - [ ] s15 grandchild',
  '- [ ] s16 parent4\n    - [ ] s17 child four',
  '> - [ ] s18 quoted', '> > - [ ] s19 double quoted', '>- [ ] s20 no space quote',
  '- [ ] s21 loose\n\n- [ ] s22 loose two',
  '- [ ] s23 lazy\ncontinuation line',
  '- [ ]', '- [x] ', `- [ ] s26 nbsp${NBSP}inside`, '- [ ] **s27 bold** and `code`', '- [ ] s28 $x^2$ math',
  '-  [ ]  s29 two and two', '   - [ ] s30 three indent',
  '1. item\n   - [ ] s31 under ordered', '- a\n\n  - [ ] s32 under loose',
  '| t |\n|---|\n| - [ ] s33 in table |',
  '<details><summary>d</summary>\n\n- [ ] s34 in details\n\n</details>',
];
const DOC = `# Shapes\n\n${SHAPES.join('\n\nsep\n\n')}\n\nend\n`;
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);
const lines = () => page.evaluate(async () => {
  const sc = document.querySelector('.cm-scroller'); const keep = sc.scrollTop; const seen = new Map();
  for (let y = 0; y <= sc.scrollHeight; y += Math.max(200, sc.clientHeight - 100)) {
    sc.scrollTop = y; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const l of document.querySelectorAll('.cm-content .cm-line')) { const m = l.textContent.match(/s(\d\d) /) || (/^- \[[ xX]\] ?$/.test(l.textContent) ? [0, 'e' + l.textContent.length] : null); if (m) seen.set(m[1], l.textContent); }
  }
  sc.scrollTop = keep; return [...seen.entries()].sort().map(([k, v]) => k + '=' + v);
});
try {
  const f = path.join(TMP, 'shapes.md'); fs.writeFileSync(f, DOC);
  app = await electron.launch({ args: [DIR, f, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('.mdr-preview')?.textContent || '').includes('s34'), null, { timeout: 15000 }).catch(async () => { console.log('DBG', JSON.stringify(await page.evaluate(() => ({ t: document.title, pv: (document.querySelector('.mdr-preview')?.textContent || '').slice(-200), cm: document.querySelectorAll('.cm-line').length })))); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1300, 2400));
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('view.mountAll').click());
  await sleep(1500);
  await page.evaluate(() => { window.__offkToasts = []; new MutationObserver(() => { for (const t of document.querySelectorAll('.mdr-toast')) { const s = t.textContent.trim(); if (s !== t.__last) { t.__last = s; window.__offkToasts.push(s); } } }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
  const n = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type=checkbox]').length);
  out('count', { n });
  for (let i = 0; i < n; i++) {
    const before = await lines();
    const info = await page.evaluate((k) => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k]; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const li = b.closest('li'); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (li ? li.textContent : b.parentElement.textContent).trim().slice(0, 24), cls: b.className }; }, i);
    await sleep(150);
    const p2 = await page.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    await page.mouse.click(p2.x, p2.y);
    await sleep(700);
    const after = await lines();
    const changed = [];
    for (let j = 0; j < Math.max(before.length, after.length); j++) if (before[j] !== after[j]) changed.push(`${j + 1}:${JSON.stringify(before[j])}->${JSON.stringify(after[j])}`);
    const toasts = await page.evaluate(() => window.__offkToasts.splice(0));
    out(`box${String(i).padStart(2, '0')}`, { label: info.label, cls: info.cls, changed, toasts, checked: await page.evaluate((k) => document.querySelectorAll('.mdr-preview input[type=checkbox]')[k]?.checked ?? null, i) });
  }
} catch (e) {
  console.log('THREW', String(e).split('\n')[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
