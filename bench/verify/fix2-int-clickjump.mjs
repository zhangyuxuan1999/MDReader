// bench/verify/fix2-int-clickjump.mjs — integrator (stage 2b): does a click right after a programmatic jump
// (scrollToLine, whose navigation anchor re-applies the line for about 600 ms) start a session under U7
// (press and release in the same block)? Compares an immediate click with one after the anchor expired, and
// records the block under the pointer at mousedown and at mouseup.
// Run: MDR_PORT=5320 node bench/verify/fix2-int-clickjump.mjs [lines…]   (own Vite on MDR_PORT, killed at exit)
import { readFileSync } from 'node:fs';
import { startServer, stopServer, openBrowser, sleep } from './inline-verify-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
const lines = process.argv.slice(2).map(Number);
const want = lines.length ? lines : [403, 447, 549, 568, 575, 583, 859];
await startServer();
const B = await openBrowser();
const { page } = B;
let immediateOk = 0, waitedOk = 0;
try {
  await B.boot('mode=split');
  const text = readFileSync(new URL('../../test-data/small.md', import.meta.url), 'utf8');
  await B.loadDoc(text, 'small.md');
  await page.evaluate(() => {
    window.__cj = [];
    for (const t of ['mousedown', 'mouseup']) {
      document.addEventListener(t, (e) => {
        const w = e.target instanceof Element ? e.target.closest('.md-block') : null;
        window.__cj.push(`${t}:${w ? w.dataset.id : '-'}`);
      }, true);
    }
  });
  for (const line of want) {
    for (const mode of ['immediate', 'waited']) {
      if (process.env.MDR_SEQ) {
        // as v2-fid-walk: an edit of the block before, Esc, then the original document loaded again
        const prev = await page.evaluate((l) => { const pv = window.__mdr.app.preview; const b = pv.blockAtLine(l); return Math.max(1, b.startLine - 2); }, line);
        await B.clickLine(prev, 'first').catch(() => {});
        await page.keyboard.type('x');
        await sleep(250);
        await B.esc();
        await sleep(150);
        await page.evaluate(() => window.__mdr.waitIdle());
        await B.loadDoc(text, 'small.md');
        await page.evaluate(() => getSelection().removeAllRanges());
      } else {
        await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(1, 0, 'instant'); });
        await sleep(700);
      }
      await page.evaluate(() => { window.__cj = []; });
      const pt = await B.textPoint(line, 'first');
      if (mode === 'waited') await sleep(800);
      const p2 = mode === 'waited' ? await B.textPoint(line, 'first') : pt;
      const hit = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); const w = e && e.closest('.md-block'); return w ? w.dataset.id : (e ? e.tagName + '.' + e.className : 'none'); }, p2);
      await page.evaluate(() => { window.__cj = []; });
      await page.mouse.click(p2.x, p2.y);
      await sleep(150);
      const ed = await B.editing();
      const ev = await page.evaluate(() => window.__cj.join(' '));
      const target = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l).id, line);
      console.log(`${mode.padEnd(9)} line ${line} (block ${target}): session=${!!ed} hitBefore=${hit} events=${ev}`);
      if (ed) { if (mode === 'immediate') immediateOk++; else waitedOk++; }
      await B.esc();
      await sleep(100);
    }
  }
  console.log(`SUMMARY immediate ${immediateOk}/${want.length} waited ${waitedOk}/${want.length}`);
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  clearTimeout(KILL);
  await B.close?.();
  stopServer();
  process.exit(0);
}
