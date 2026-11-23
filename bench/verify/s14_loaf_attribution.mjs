// s14 — Long Animation Frame attribution for the long tasks seen in s09/s04/s09b:
// (c) loading 50k headings, (d) 6 MB paste into medium.md, (f) keystrokes in a 1 MB single line,
// (g) opening large.md (P4 reference). Prints for every LoAF > 50 ms: duration, blockingDuration,
// script vs style/layout split, and the top scripts by duration (invoker + source function).
// Run: node bench/verify/s14_loaf_attribution.mjs
import { launch, open, settle, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const LOAF = `
window.__loaf = [];
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      const scripts = (e.scripts || []).map((s) => ({ dur: Math.round(s.duration), invoker: s.invoker, fn: s.sourceFunctionName, url: (s.sourceURL || '').replace(/^.*\\/(src|node_modules)\\//, '$1/').replace(/\\?.*$/, ''), line: s.sourceCharPosition, forcedLayout: Math.round(s.forcedStyleAndLayoutDuration || 0) }));
      scripts.sort((a, b) => b.dur - a.dur);
      window.__loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration), styleLayout: Math.round(e.startTime + e.duration - e.styleAndLayoutStart), renderMs: Math.round(e.startTime + e.duration - e.renderStart), scriptMs: Math.round(scripts.reduce((a, s) => a + s.dur, 0)), scripts: scripts.slice(0, 4) });
    }
  }).observe({ type: 'long-animation-frame', buffered: true });
} catch (e) { window.__loafErr = String(e); }
`;
const { browser, page, log } = await launch({ initScript: LOAF });
const C = makeChecker();
const takeLoaf = (min = 50) => page.evaluate((min) => { const l = window.__loaf.filter((x) => x.dur >= min); window.__loaf.length = 0; return l; }, min);
const show = (label, l) => { console.log(`--- ${label}: ${l.length} LoAF ≥ 50 ms`); for (const e of l) console.log(`  ${e.dur} ms (blocking ${e.blocking}, script ${e.scriptMs}, render ${e.renderMs}, style+layout ${e.styleLayout}) ` + e.scripts.map((s) => `[${s.dur}ms ${s.invoker} → ${s.fn || '(anon)'} ${s.url}:${s.line}${s.forcedLayout ? ' forcedLayout=' + s.forcedLayout : ''}]`).join(' ')); };

try {
  await open(page, '?mode=split');
  await settle(page, 30000);
  C.check('LoAF observer installed', await page.evaluate(() => !window.__loafErr), await page.evaluate(() => window.__loafErr));
  await takeLoaf();

  // (c) 50k headings
  await page.evaluate(async () => { let t = ''; for (let i = 0; i < 50000; i++) t += `${'#'.repeat(1 + (i % 6))} Heading ${i}\n`; await window.__mdr.loadText(t, 'h.md'); });
  await settle(page, 60000); await sleep(1500);
  let l = await takeLoaf(); show('(c) load 50k headings', l);
  C.measure('(c) 50k headings load: longest LoAF ms / script ms / style+layout ms', l.length ? `${Math.max(...l.map((x) => x.dur))} / ${l[0].scriptMs} / ${l[0].styleLayout}` : '0', 'informational', true);

  // (d) 6 MB paste
  await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'medium.md'); }, await fetchTestDoc('medium.md'));
  await settle(page, 60000); await sleep(500); await takeLoaf();
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(10000, 0); });
  await page.evaluate(() => {
    const unit = '## Pasted heading\n\nA pasted paragraph with **bold**, `code`, 中文 and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n```ts\nexport const x: number = 42;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n';
    let text = ''; while (text.length < 6 * 1024 * 1024) text += unit;
    const view = window.__mdr.app.editor.view;
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.paste' });
  });
  await settle(page, 120000); await sleep(1500);
  l = await takeLoaf(); show('(d) 6 MB paste', l);
  C.measure('(d) 6 MB paste: longest LoAF ms', l.length ? Math.max(...l.map((x) => x.dur)) : 0, 'informational', true);

  // (f) 1 MB line keystrokes
  await page.evaluate(async () => { await window.__mdr.loadText('word '.repeat(200000) + 'END', 'line.md'); });
  await settle(page, 60000); await sleep(500); await takeLoaf();
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(1, 1000003); ed.focus(); });
  await page.keyboard.type('abcde', { delay: 0 });
  await sleep(500);
  l = await takeLoaf(); show('(f) 5 keystrokes in a 1 MB line', l);
  C.measure('(f) 1 MB line: LoAF per keystroke (count ≥ 50 ms / max ms)', `${l.length} / ${l.length ? Math.max(...l.map((x) => x.dur)) : 0}`, 'informational', true);
  await settle(page, 60000);

  // (g) large.md open (reference)
  await takeLoaf();
  await page.evaluate(async (t) => { await window.__mdr.loadText(t, 'large.md'); }, await fetchTestDoc('large.md'));
  await settle(page, 120000); await sleep(1500);
  l = await takeLoaf(); show('(g) load large.md', l);
  C.measure('(g) large.md load: longest LoAF ms', l.length ? Math.max(...l.map((x) => x.dur)) : 0, 'P4 < 120', !l.length || Math.max(...l.map((x) => x.dur)) < 120);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s14 LoAF attribution', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
