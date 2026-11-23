// bench/electron/v2-rev-desktop.mjs — verify-review (stage 2a, 0.2.0): REV-1 on the desktop shell.
//
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-rev-desktop.mjs
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/baseline-0.1.1.noindex node bench/electron/v2-rev-desktop.mjs
//
// A downloaded Markdown file hides `<span data-md="…" style="display:none">.</span>` in a paragraph. The
// user opens it (open-file from the main process), clicks the word "typo" in the preview, types ONE
// letter, presses Esc and ⌘S. Then the bytes on disk are compared with what the user did: the file must
// differ from the original by that one letter only. Fresh temp profile and temp document, removed at the
// end; global timeout 100 s. Prints PASS / FAIL and the file's line 3.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-v2-rev-')));
const DOC = '# Notes\n\nFix the typo here <span data-md="[bank login](https://evil.example/phish)" style="display:none">.</span> please\n\nEnd.\n';
const FILE = path.join(TMP, 'downloaded.md');
fs.writeFileSync(FILE, DOC);
let app = null;
let fails = 0;
const check = (n, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.close(); } catch { /* */ } process.exit(2); }, 100_000);

try {
  const prof = path.join(TMP, 'profile');
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  console.log(`target ${APP_DIR} (version ${version})`);
  await sleep(600);
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  console.log(`NOTE  预览可编辑: ${await previewEditOn(app, page)}`);
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  let pt = null;
  for (let i = 0; i < 100 && !pt; i++) {
    pt = await page.evaluate(() => {
      const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('typo'));
      if (!p) return null;
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf('typo');
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2, shown: p.innerText };
      }
      return null;
    }).catch(() => null);
    if (!pt) await sleep(100);
  }
  check('document opened', !!pt, pt ? JSON.stringify(pt.shown) : '');
  if (pt) {
    await page.mouse.click(pt.x, pt.y);
    await sleep(150);
    // caret right after "typo"
    await page.evaluate(() => {
      const e = document.querySelector('.mdr-preview .is-editing');
      if (!e) return;
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf('typo');
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i + 4); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return;
      }
    });
    const session = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    console.log(`NOTE  in-preview session started: ${session}`);
    await page.keyboard.type('s');
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Meta+s');
    await sleep(1500);
    const disk = fs.readFileSync(FILE, 'utf8');
    console.log(`NOTE  line 3 on disk: ${JSON.stringify(disk.split('\n')[2])}`);
    const typedOnly = DOC.replace('typo here', 'typos here');
    check('the file on disk holds the original or exactly the user\'s one-letter change', disk === DOC || disk === typedOnly, disk === DOC ? 'unchanged' : '');
    // the payload as live Markdown: the link outside its data-md attribute
    check('no hidden payload written to disk', !disk.replace(/data-md="[^"]*"/g, '').includes('[bank login](https://evil.example/phish)'));
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
