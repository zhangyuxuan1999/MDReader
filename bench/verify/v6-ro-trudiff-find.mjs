// bench/verify/v6-ro-trudiff-find.mjs — regress-off (stage 2f, round 5): find the generated document of
// bench/verify/v4-tru-diff.mjs (seed 1, default run) on which its in-page check throws ("Illegal invocation" inside
// DOMPurify), then open that document in the app itself (window.__mdr.loadText) and report what the preview shows
// and whether the page threw.
//   MDR_PORT=5478 node bench/verify/v6-ro-trudiff-find.mjs [seed=1] [fromChunk=3] [toChunk=20]
// Needs the tree's dev server on MDR_PORT. Global timeout 110 s. Writes only the found document to $MDR_OUT if set.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { setupPage } from './v4-tru-diff.mjs';

const PORT = Number(process.env.MDR_PORT || 5478);
const SEED = Number(process.argv[2] ?? 1);
const FROM = Number(process.argv[3] ?? 3), TO = Number(process.argv[4] ?? 20);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  const setup = await setupPage(page);
  if (setup !== 'ok') throw new Error(setup);
  let found = null;
  for (let c = FROM; c < TO && !found; c++) {
    found = await page.evaluate(({ seed, from }) => {
      const { gen, check } = window.__v4tru;
      const r = gen.rng(seed + from * 7919);
      for (let i = 0; i < 1000; i++) {
        const doc = gen.generate(r, 0);
        try { check(doc); } catch (e) { return { from, i, doc, err: String(e && e.message) }; }
      }
      return null;
    }, { seed: SEED, from: c * 1000 });
    if (!found) console.log(`chunk ${c} ok`);
  }
  if (!found) { console.log('RESULT nothing throws in the chunks searched'); }
  else {
    console.log(`FOUND chunk-from ${found.from} doc ${found.i}: ${found.err}`);
    console.log('DOC ' + JSON.stringify(found.doc).slice(0, 1500));
    if (process.env.MDR_OUT) writeFileSync(process.env.MDR_OUT, found.doc);
    // the same document in the app (a fresh page, the real pipeline: worker render, sanitize, mount)
    const p2 = await browser.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e && e.message)));
    p2.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
    await p2.goto(`http://localhost:${PORT}/?mode=split`, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    await p2.evaluate(() => localStorage.setItem('mdr.previewEdit', '0'));
    await p2.evaluate((t) => window.__mdr.loadText(t, 'f.md'), found.doc);
    await p2.evaluate(() => window.__mdr.waitIdle());
    await new Promise((r) => setTimeout(r, 800));
    const shown = await p2.evaluate(() => ({ blocks: document.querySelectorAll('.mdr-preview .md-block').length, text: (document.querySelector('.mdr-preview')?.innerText || '').slice(0, 300) }));
    console.log('APP ' + JSON.stringify({ shown, errs: errs.slice(0, 5) }));
  }
} catch (e) { console.log('ERROR', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e); process.exitCode = 2; }
finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
