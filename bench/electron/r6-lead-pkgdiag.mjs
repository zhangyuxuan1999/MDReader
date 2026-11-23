// bench/electron/r6-lead-pkgdiag.mjs — lead, stage 3: why packaged-e2e.mjs does not find the table and the
// highlighted code block. Launches the packaged app (MDR_APP, default release/mac-arm64/MDReader.app) or a
// candidate directory (MDR_APP_DIR) through the wrapper (isolated profile), opens packaged-e2e's document and
// polls the preview for five seconds. Read-only: nothing is typed, the app quits cleanly.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'bench/electron/packaged-e2e.mjs'), 'utf8');
const m = /const DOC = `([\s\S]*?)`;/.exec(src);
if (!m) throw new Error('DOC not found');
const DOC = m[1].split('\\`').join('`').split('\\\\').join('\\');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-pkgdiag-'));
const docPath = path.join(tmp, 'diag.md');
fs.writeFileSync(docPath, DOC);
const dir = process.env.MDR_APP_DIR;
const appBundle = process.env.MDR_APP || path.join(ROOT, 'release', 'mac-arm64', 'MDReader.app');
const timer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 60000);
let app;
try {
  app = dir ? await electron.launch({ args: [dir, docPath] }) : await electron.launch({ executablePath: path.join(appBundle, 'Contents', 'MacOS', 'MDReader'), args: [docPath] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const t0 = Date.now();
  let seen = { table: -1, code: -1 };
  for (let i = 0; i < 50; i++) {
    const r = await page.evaluate(() => ({
      table: !!document.querySelector('.mdr-preview__body table'),
      code: !!document.querySelector('.mdr-preview__body pre code span'),
      blocks: [...document.querySelectorAll('.mdr-preview__body .md-block')].map((b) => (b.firstElementChild ? b.firstElementChild.tagName : '-') + ':' + b.className.replace('md-block', '').trim() + ':' + (b.textContent || '').length),
      version: document.title,
    }));
    if (r.table && seen.table < 0) seen.table = Date.now() - t0;
    if (r.code && seen.code < 0) seen.code = Date.now() - t0;
    if (i === 0 || i === 49 || (seen.table >= 0 && seen.code >= 0)) console.log(`t=${Date.now() - t0}ms table=${r.table} code=${r.code} blocks=${JSON.stringify(r.blocks)}`);
    if (seen.table >= 0 && seen.code >= 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log('first seen ms:', JSON.stringify(seen));
  const html = await page.evaluate(() => { const pre = document.querySelector('.mdr-preview__body pre'); const tw = document.querySelector('.mdr-preview__body [class*="table"], .mdr-preview__body table'); return { pre: pre ? pre.outerHTML.slice(0, 400) : null, table: tw ? tw.outerHTML.slice(0, 300) : null }; });
  console.log('pre:', html.pre);
  console.log('table:', html.table);
} finally {
  try { if (app) { await app.evaluate(({ app: a }) => a.quit()); await app.close().catch(() => {}); } } catch { /* already gone */ }
  clearTimeout(timer);
  fs.rmSync(tmp, { recursive: true, force: true });
}
