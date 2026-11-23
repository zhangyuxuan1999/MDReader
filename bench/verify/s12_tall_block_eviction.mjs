// s12 — a single block taller than 20 screens (50k-line fence; also a 30k-line list): scroll the preview
// into its middle (no edits) and sample the wrapper state every 100 ms for 6 s. Expected: content stays
// mounted. Suspected: eviction uses the block's top, so the visible block is emptied (is-pending) and
// re-requested in a loop. Run: node bench/verify/s12_tall_block_eviction.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

async function sampleBlock(ms, every = 100) {
  return page.evaluate(async ({ ms, every }) => {
    const out = [];
    const el = window.__mdr.app.preview.el;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const b = document.querySelector('.md-block');
      out.push({ t: Math.round(performance.now() - t0), pending: b.classList.contains('is-pending'), slow: b.classList.contains('is-slow'), stale: b.classList.contains('is-stale'), len: b.textContent.length, scrollTop: Math.round(el.scrollTop), H: el.clientHeight, blockH: Math.round(b.getBoundingClientRect().height), html: window.__wmsgs.html });
      await new Promise((r) => setTimeout(r, every));
    }
    return out;
  }, { ms, every });
}
function summarise(samples) {
  const mounted = samples.filter((s) => !s.pending && s.len > 0).length;
  const empty = samples.filter((s) => s.pending || s.len === 0).length;
  let transitions = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].pending !== samples[i - 1].pending) transitions++;
  return { samples: samples.length, mounted, empty, transitions, htmlMsgsDelta: samples[samples.length - 1].html - samples[0].html, first: samples[0], last: samples[samples.length - 1] };
}

try {
  await open(page, '?mode=split');
  await settle(page, 30000);

  for (const [label, text, midLine] of [
    ['50k-line fence', '```js\n' + 'const line = "x"; // filler\n'.repeat(50000) + '```\n', 25000],
    ['30k-item list', '- item\n'.repeat(30000), 15000],
    ['20k-line paragraph (single block)', 'lorem ipsum dolor sit amet\n'.repeat(20000), 10000],
  ]) {
    await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'tall.md'); }, text);
    const s = await settle(page, 60000);
    C.check(`[${label}] settles`, s.ok, s);
    await sleep(1500);
    const before = await page.evaluate(() => { const b = document.querySelector('.md-block'); return { pending: b.classList.contains('is-pending'), len: b.textContent.length, blockH: Math.round(b.getBoundingClientRect().height), H: window.__mdr.app.preview.el.clientHeight, blocks: window.__mdr.app.preview.blockCount() }; });
    C.check(`[${label}] single block, mounted at top`, before.blocks === 1 && !before.pending && before.len > 0, before);
    C.measure(`[${label}] block height / viewport height (screens)`, (before.blockH / before.H).toFixed(1), '> 20 (eviction distance) for this test', before.blockH / before.H > 20);
    // Scroll the preview into the middle of the block (preview is scroll master here)
    await page.evaluate((line) => { window.__mdr.app.preview.scrollToLine(line, 0, 'instant'); }, midLine);
    const samples = await sampleBlock(6000);
    const sum = summarise(samples);
    C.check(`[${label}] block stays mounted while scrolled into its middle (6 s)`, sum.empty === 0 && sum.transitions === 0, sum);
    if (sum.empty > 0) {
      console.log('  timeline:', samples.filter((_, i) => i % 5 === 0).map((x) => `${x.t}ms:${x.pending ? 'EMPTY' : 'ok'}${x.slow ? '/slow' : ''}`).join(' '));
    }
    // Editor follows? and does the editor→preview sync path also trigger the eviction (type one char)
    await page.evaluate((line) => { const ed = window.__mdr.app.editor; ed.gotoLine(line, 3); ed.focus(); }, midLine);
    await page.keyboard.type('Z', { delay: 0 });
    await settle(page, 60000);
    const samples2 = await sampleBlock(4000);
    const sum2 = summarise(samples2);
    C.check(`[${label}] after one keystroke mid-block: content (re)mounted and stays`, sum2.last.pending === false && sum2.last.len > 0, sum2);
  }

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s12 tall block eviction', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
