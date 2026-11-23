// bench/electron/v3-rev-desktop.mjs — verify-review (stage 2c, 0.2.0): REV-1 / REV-2 on the desktop shell.
//
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v3-rev-desktop.mjs
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/baseline-0.1.1.noindex node bench/electron/v3-rev-desktop.mjs
//
// Two downloaded files hide a raw <span class="md-math" style="display:none"><code>…</code></span> in a paragraph,
// its reserved class kept from rawHtmlReserved: REV-2 by `class="&Tab;md-math"`, REV-1 by a <style><![CDATA[…]]>
// token (no `<!--` in the file). For each: open it (open-file from the main process), click "terms" in the preview,
// type ONE letter, Esc, ⌘S. The bytes on disk must differ from the original by that letter only (or not at all).
// Temp documents and the profile live in the verifier's scratch directory and are removed at the end; launched
// only through _electron.mjs (isolated profile); no full screen involved. Global timeout 100 s.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v3-rev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SCRATCH, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, 'desk-')));
const RAW = {
  rev2: '<span class="&Tab;md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>',
  rev1: '<style><![CDATA[</style x="a><b title="><span class="md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>"]]>',
};
let app = null;
let fails = 0;
const check = (n, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.close(); } catch { /* */ } process.exit(2); }, 100_000);

try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${path.join(TMP, 'profile')}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  console.log(`target ${APP_DIR} (version ${await app.evaluate(({ app: a }) => a.getVersion())})`);
  await sleep(600);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  console.log(`NOTE  预览可编辑: ${await previewEditOn(app, page)}`);
  for (const [label, raw] of Object.entries(RAW)) {
    const DOC = `# Terms\n\nPlease read ${raw}the terms\n\nEnd.\n`;
    const FILE = path.join(TMP, `${label}.md`);
    fs.writeFileSync(FILE, DOC);
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
    let pt = null;
    for (let i = 0; i < 100 && !pt; i++) {
      pt = await page.evaluate((name) => {
        if (!document.title.includes(name)) return null;
        const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('terms'));
        if (!p) return null;
        const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf('terms');
          if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2);
          const b = r.getBoundingClientRect();
          return { x: b.left + 1, y: b.top + b.height / 2, shown: p.innerText };
        }
        return null;
      }, `${label}.md`).catch(() => null);
      if (!pt) await sleep(100);
    }
    check(`${label}: document opened`, !!pt, pt ? JSON.stringify(pt.shown) : '');
    if (!pt) continue;
    await sleep(700);
    await page.mouse.click(pt.x, pt.y);
    await sleep(150);
    const session = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    console.log(`NOTE  ${label}: in-preview session started: ${session}`);
    await page.keyboard.type('s');
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Meta+s');
    await sleep(1500);
    const disk = fs.readFileSync(FILE, 'utf8');
    console.log(`NOTE  ${label}: line 3 on disk: ${JSON.stringify(disk.split('\n')[2])}`);
    const typedOnly = (d) => d === DOC || (d.length === DOC.length + 1 && d.includes(raw));
    check(`${label}: the file on disk holds the original or only the user's letter added`, typedOnly(disk), disk === DOC ? 'unchanged' : '');
    check(`${label}: the hidden raw HTML is not rewritten into a formula`, !disk.includes('$\\text{Call'));
  }
} catch (err) {
  check('script', false, String(err && err.stack ? err.stack : err).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(killer);
  try { await app?.close(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
}
