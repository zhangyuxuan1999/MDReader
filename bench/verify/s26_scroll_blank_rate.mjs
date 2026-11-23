// s26 — characterise the "blank viewport while scrolling" symptom seen in s25(B):
// sweep scroll speeds on large.md and huge.md, measure the fraction of frames whose visible
// viewport contains no rendered content, and the recovery time after scrolling stops.
// Also runs a real wheel gesture (P8-style, 20 screens) for comparison.
// Run: node bench/verify/s26_scroll_blank_rate.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

async function sweep(label, pxPerFrame, frames) {
  return page.evaluate(async ({ pxPerFrame, frames }) => {
    const el = window.__mdr.app.preview.el;
    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 600));
    const r = el.getBoundingClientRect();
    const sample = () => {
      let total = 0, filled = 0, coveredPx = 0;
      for (const b of document.querySelectorAll('.md-block')) {
        const br = b.getBoundingClientRect();
        if (br.bottom > r.top && br.top < r.bottom) {
          total++;
          if (b.firstChild) { filled++; coveredPx += Math.min(br.bottom, r.bottom) - Math.max(br.top, r.top); }
        }
      }
      return { total, filled, coverage: coveredPx / r.height };
    };
    let blank = 0, halfEmpty = 0, sumCov = 0, n = 0;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      el.scrollTop += pxPerFrame;
      await new Promise((rr) => requestAnimationFrame(rr));
      const s = sample();
      n++; sumCov += s.coverage;
      if (s.coverage < 0.02) blank++;
      if (s.coverage < 0.5) halfEmpty++;
    }
    const wallMs = performance.now() - t0;
    // recovery
    const tRec = performance.now();
    let recoveredMs = -1;
    while (performance.now() - tRec < 5000) {
      await new Promise((rr) => requestAnimationFrame(rr));
      if (sample().coverage > 0.9) { recoveredMs = Math.round(performance.now() - tRec); break; }
    }
    return {
      frames: n, blankPct: +(100 * blank / n).toFixed(1), halfEmptyPct: +(100 * halfEmpty / n).toFixed(1),
      avgCoverage: +(sumCov / n).toFixed(3), pxPerSec: Math.round(pxPerFrame * n / (wallMs / 1000)), recoveredMs,
    };
  }, { pxPerFrame, frames });
}

try {
  for (const doc of ['large.md', 'huge.md']) {
    await open(page, `?doc=/test-data/${doc}&mode=split`);
    await page.waitForFunction(() => window.__mdr.version() >= 1, null, { timeout: 120000 });
    const s = await settle(page, 240000);
    C.check(`${doc} settles`, s.ok, s);
    const H = await page.evaluate(() => window.__mdr.app.preview.el.clientHeight);
    for (const px of [60, 150, 300, 600, 900, 2500]) {
      const r = await sweep(doc, px, 60);
      const screensPerSec = (r.pxPerSec / H).toFixed(1);
      C.measure(`[${doc}] ${px} px/frame (~${r.pxPerSec} px/s, ${screensPerSec} screens/s): blank frames %`,
        r.blankPct, '< 5 %', r.blankPct < 5);
      console.log(`      detail ${doc} ${px}px/frame:`, JSON.stringify(r));
    }
    // P8-style real wheel: 20 screens
    await page.evaluate(() => { window.__mdr.app.preview.el.scrollTop = 0; });
    await sleep(500);
    await page.mouse.move(1100, 500);
    const wheelRes = await page.evaluate(() => {
      window.__wheelProbe = { blank: 0, n: 0 };
      const el = window.__mdr.app.preview.el;
      const r = el.getBoundingClientRect();
      const tick = () => {
        let cov = 0;
        for (const b of document.querySelectorAll('.md-block')) {
          const br = b.getBoundingClientRect();
          if (br.bottom > r.top && br.top < r.bottom && b.firstChild) cov += Math.min(br.bottom, r.bottom) - Math.max(br.top, r.top);
        }
        window.__wheelProbe.n++;
        if (cov / r.height < 0.02) window.__wheelProbe.blank++;
        if (window.__wheelProbe.n < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    });
    const screens = 20, H2 = H;
    for (let i = 0; i < screens; i++) { await page.mouse.wheel(0, H2); await sleep(16); }
    await sleep(300);
    const wp = await page.evaluate(() => window.__wheelProbe);
    C.measure(`[${doc}] real wheel, 20 screens (~1 screen/frame): blank frames %`, +(100 * wp.blank / wp.n).toFixed(1), '< 5 %', 100 * wp.blank / wp.n < 5);
  }
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s26 scroll blank rate', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
