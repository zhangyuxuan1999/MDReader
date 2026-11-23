// bench/verify/v5-chc-u2probe.mjs — challenge-c: after ⇧⌘Z pressed in preview mode outside the editor (switch OFF, a
// redo that changed the document), does the editor→preview scroll sync still work after the next document load?
// Steps on ONE build: load large.md (split), scroll the editor to 0.9, type " F" there, ⌘Z in the editor, mode preview,
// preview to the top, click a paragraph, ⇧⌘Z [skipped with --noredo], mode split, load large.md again, scroll the
// editor to 0.7 by scrollTop; prints both panes' scrollTop and the preview's first visible block after 1.5 s.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-u2probe.mjs cand [--noredo]  |  MDR_BASE_PORT=5497 ... base
import { readFileSync } from 'node:fs';
import { openPage, sleep, J } from './v5-chc-lib.mjs';

const target = process.argv[2] || 'cand';
const noredo = process.argv.includes('--noredo');
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 100000);
const LARGE = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8');
const { browser, page } = await openPage(target);
const st = () => page.evaluate(() => { const r = document.querySelector('.mdr-preview'); const s = document.querySelector('.cm-scroller'); const top = r.getBoundingClientRect().top; const first = Array.from(r.querySelectorAll('.md-block')).find((b) => b.getBoundingClientRect().bottom > top + 1); return { pv: Math.round(r.scrollTop), ed: Math.round(s.scrollTop), firstPv: first ? first.textContent.slice(0, 30) : null, active: document.activeElement?.className?.slice?.(0, 40), mode: document.body.dataset.mode || document.documentElement.dataset.mode }; });
try {
  const loadL = async () => { await page.evaluate((t) => window.__mdr.loadText(t, 'large.md'), LARGE); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(800); };
  await loadL();
  await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = (s.scrollHeight - s.clientHeight) * 0.9; });
  await sleep(800);
  const p = await page.evaluate(() => { const l = document.querySelectorAll('.cm-line')[3]; const r = l.getBoundingClientRect(); return { x: r.right - 3, y: r.top + r.height / 2 }; });
  await page.mouse.click(p.x, p.y); await page.keyboard.press('End'); await page.keyboard.type(' F'); await sleep(400);
  await page.keyboard.press('Meta+z'); await sleep(400);
  await page.evaluate(() => window.__mdr.mode('preview')); await sleep(500);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; }); await sleep(600);
  const q = await page.evaluate(() => { const e = document.querySelector('.mdr-preview p'); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; });
  await page.mouse.click(q.x, q.y); await sleep(300);
  if (!noredo) { await page.keyboard.press('Meta+Shift+z'); await sleep(800); }
  console.log('after redo', J(await st()), 'hasF', (await page.evaluate(() => window.__mdr.app.getText())).includes(' F\n'));
  await page.evaluate(() => window.__mdr.mode('split')); await sleep(600);
  console.log('split', J(await st()));
  await loadL();
  console.log('reloaded', J(await st()));
  await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = (s.scrollHeight - s.clientHeight) * 0.7; });
  await sleep(1500);
  console.log('scrollEd 0.7', J(await st()));
  await page.mouse.move(300, 400); await page.mouse.wheel(0, 300); await sleep(1500);
  console.log('wheel in editor', J(await st()));
} finally { clearTimeout(killer); await browser.close(); }
