// bench/verify/v2-cfm-render-diag.mjs — confirm agent (0.2.0 stage 2a): why does inline-verify-render.mjs's
// last step ("split · large.md: Enter in a block scrolled far down") fail with "no paragraph on screen"?
// Replays the steps before it (split small.md wheel, split large.md wheel, preview small.md wheel, back to split)
// and then the failing step's wheelToAndClick, printing where the preview landed and what is on screen.
// Run: MDR_PORT=5288 node bench/verify/v2-cfm-render-diag.mjs [fresh]   (fresh = skip the earlier steps)
// Own vite on MDR_PORT (killed at exit); writes nothing into the tree; global timeout 100 s.
import { startServer, stopServer, openBrowser, sleep } from './inline-verify-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
const fresh = process.argv[2] === 'fresh';
await startServer();
const B = await openBrowser();
const { page } = B;
async function wheel(url, px) {
  await page.evaluate((u) => window.__mdr.loadUrl(u), url);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(1000);
  const pb = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  for (let left = px; left > 0; left -= 3000) { await page.mouse.wheel(0, Math.min(3000, left)); await sleep(30); }
  await sleep(600);
  return page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const vh = pv.el.getBoundingClientRect();
    const vis = [];
    for (const s of document.querySelectorAll('.mdr-preview section.md-block')) {
      const r = s.getBoundingClientRect();
      if (r.bottom > vh.top && r.top < vh.bottom) vis.push({ top: Math.round(r.top), h: Math.round(r.height), pending: s.classList.contains('is-pending'), p: !!s.querySelector('p'), t: (s.textContent || '').slice(0, 24) });
    }
    return { st: Math.round(pv.el.scrollTop), sh: pv.el.scrollHeight, topLine: pv.topVisible().line, lines: window.__mdr.app.editor.lineCount(), vh: { top: Math.round(vh.top), bottom: Math.round(vh.bottom) }, vis };
  });
}
try {
  await B.boot('mode=split');
  if (!fresh) {
    for (const [mode, url, px] of [['split', '/test-data/small.md', 30000], ['split', '/test-data/large.md', 300000], ['preview', '/test-data/small.md', 30000]]) {
      await page.evaluate((m) => window.__mdr.mode(m), mode); await sleep(300);
      const r = await wheel(url, px);
      console.log(`EARLIER ${mode} ${url} → st ${r.st} topLine ${r.topLine} visible ${r.vis.length}`);
      const pt = await page.evaluate(() => {
        const vh = window.__mdr.app.preview.el.getBoundingClientRect();
        for (const s of document.querySelectorAll('.mdr-preview section.md-block:not(.is-pending)')) {
          const r = s.getBoundingClientRect(); const p = s.querySelector('p');
          if (r.top > vh.top + 50 && r.bottom < vh.bottom - 50 && p && p.textContent.includes('性能测试的段落')) {
            const n = document.createTreeWalker(p, 4).nextNode(); const i = n.data.indexOf('性能测试');
            const rg = document.createRange(); rg.setStart(n, i + 2); rg.setEnd(n, i + 3); const rr = rg.getBoundingClientRect();
            return { x: rr.left + 1, y: rr.top + rr.height / 2 };
          }
        }
        return null;
      });
      if (pt) { await page.mouse.click(pt.x, pt.y); await sleep(100); await page.keyboard.type('xyz', { delay: 40 }); await sleep(700); }
      console.log(`  clicked+typed: ${!!pt}`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__mdr.mode('split'));
    }
  }
  for (let i = 0; i < 2; i++) {
    const r = await wheel('/test-data/large.md', 300000);
    console.log(`FINAL#${i} st ${r.st} / ${r.sh} topLine ${r.topLine} of ${r.lines}; viewport ${JSON.stringify(r.vh)}`);
    for (const v of r.vis) console.log('   ', JSON.stringify(v));
  }
} catch (e) {
  console.log('ERROR', e.stack);
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  stopServer();
}
