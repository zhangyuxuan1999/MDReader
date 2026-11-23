// bench/verify/r7-c7-nobox.mjs — challenge-7 (round 7): for the generated documents of seed 12 (planted <?form ?>, see
// bench/verify/r7-c7-export.mjs) whose export has no md-error box although the whole document throws, prints what the
// PREVIEW shows (error blocks, their text) next to the exported body. MDR_PORT=5465 node bench/verify/r7-c7-nobox.mjs
// Global timeout 100 s. Writes nothing in the tree.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import * as gen from './v4-tru-gen.mjs';
const PORT = process.env.MDR_PORT || '5465';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const want = [21, 175];
const r = gen.rng(12);
const docs = {};
for (let i = 0; i <= Math.max(...want); i++) { let d = gen.generate(r, 0); if (want.includes(i)) { const p = d.split('\n\n'); p[i % p.length] += ' <?form ?>'; docs[i] = p.join('\n\n'); } }
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  for (const i of want) {
    await page.evaluate((t) => window.__mdr.loadText(t, 'doc.md'), docs[i]);
    await page.evaluate(() => window.__mdr.waitIdle());
    const pv = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b) => ({ err: !!b.querySelector('.md-error'), html: b.innerHTML.slice(0, 300) })));
    const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
    await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
    const d = await dl; const f = d ? readFileSync(await d.path(), 'utf8') : null;
    const body = f ? f.slice(f.indexOf('<article'), f.lastIndexOf('</article>')) : null;
    console.log('DOC', i, JSON.stringify(docs[i]));
    console.log('PREVIEW', JSON.stringify(pv));
    console.log('EXPORT', JSON.stringify(body));
  }
  console.log('page errors', errs.length, errs.slice(0, 2).join(' | '));
} finally { clearTimeout(killer); await browser.close(); }
