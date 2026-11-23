// s09b — follow-ups from s09: (1) giant 50k-line fence: does it ever mount (giant guard 500 ms)?
// (2) unclosed fence at line 1 closed at line 2 (P7-like split into 15k blocks); (3) typing inside
// heading TEXT with 50k / 3k headings (TOC rebuild cost per keystroke); (4) 1 MB single line typing,
// 40 keystrokes. Run: node bench/verify/s09b_followups.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, makeChecker, report, sleep, fetchTestDoc, loadText } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?mode=split');
  await settle(page, 30000);

  // (1) giant fence
  await page.evaluate(async () => { await window.__mdr.loadText('```js\n' + 'const line = "x"; // filler\n'.repeat(50000) + '```\n', 'fence.md'); });
  let s = await settle(page, 60000);
  C.check('(1) fence settles', s.ok, s);
  await sleep(1500);
  let info = await page.evaluate(() => { const b = document.querySelector('.md-block'); return { cls: b?.className, plain: !!b?.querySelector('.md-code--plain'), len: b?.textContent?.length }; });
  C.check('(1) 50k-line fence mounts (PLAIN) after the 500 ms giant settle', info.plain && info.len > 1000000, info);
  // type inside the fence, then stop: must remount within ~1 s
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(25000, 5); ed.focus(); window.__lat.length = 0; });
  await page.keyboard.type('EDIT', { delay: 0 });
  let lat = await latencyStats(page);
  C.measure('(1) typing inside 50k-line fence: latency p95 (ms)', lat.p95, '< 100', lat.p95 < 100);
  s = await settle(page, 60000);
  await sleep(1500);
  info = await page.evaluate(() => { const b = document.querySelector('.md-block'); return { cls: b?.className, hasEdit: b?.textContent?.includes('EDIT'), stale: b?.classList.contains('is-stale') }; });
  C.check('(1) fence content refreshed after edit + settle', info.hasEdit === true && !info.stale, info);

  // (2) unclosed fence at top closed at line 2
  await page.evaluate(async () => { await window.__mdr.loadText('```\n' + '# H\n\npara\n\n- a\n- b\n\n'.repeat(5000), 'unclosed.md'); });
  s = await settle(page, 60000);
  let sc = await structureCheck(page);
  C.check('(2) unclosed fence = 1 giant code block', sc.blocks === 1 && sc.kinds[2] === 1, sc);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(2, 0); ed.focus(); window.__lat.length = 0; window.__longTasks.length = 0; });
  await page.keyboard.type('```\n', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(2) closing the fence at line 2: latency max (ms)', lat.max, '< 100 (P7 p95 < 16)', lat.max < 100);
  s = await settle(page, 90000);
  C.check('(2) settles after closing the fence', s.ok, s);
  sc = await structureCheck(page);
  C.check('(2) giant block split into many blocks', sc.problems.length === 0 && sc.blocks > 10000, sc);
  let lt = await longTasks(page);
  C.measure('(2) long tasks after closing (count / max / >100ms)', `${lt.count}/${lt.max}/${lt.over100}`, 'P7: tasks > 100 ms ≤ 1', lt.over100 <= 1);
  // reopen (remove the closing fence): back to 1 block
  await page.evaluate(() => { const ed = window.__mdr.app.editor; const v = ed.view; const l = v.state.doc.line(2); v.dispatch({ changes: { from: l.from, to: l.to + 1, insert: '' } }); window.__longTasks.length = 0; });
  s = await settle(page, 90000);
  sc = await structureCheck(page);
  C.check('(2) removing the closing fence → 1 block again', sc.blocks === 1, sc);
  lt = await longTasks(page);
  C.measure('(2) long tasks after re-opening (count / max)', `${lt.count}/${lt.max}`, 'informational', true);

  // (3) typing inside heading text with 50k headings
  for (const [label, count] of [['50k headings', 50000], ['3k headings (large.md-like)', 3000]]) {
    await page.evaluate(async (count) => { let t = ''; for (let i = 0; i < count; i++) t += `${'#'.repeat(1 + (i % 6))} Heading ${i}\n`; await window.__mdr.loadText(t, 'h.md'); }, count);
    s = await settle(page, 60000);
    await sleep(500);
    // Edit a LEVEL-1 heading: an outline of more than 3000 entries renders collapsed, and a collapsed
    // outline materialises only levels 1–2 (deeper entries were merely CSS-hidden before, so the user saw
    // the same thing — but the DOM assertion below needs an entry that is actually listed).
    await page.evaluate((count) => {
      const mid = Math.floor(count / 2);
      const line = mid - ((mid - 1) % 6);   // `${'#'.repeat(1 + (i % 6))} Heading ${i}` → level 1 when (line-1) % 6 === 0
      const ed = window.__mdr.app.editor; ed.gotoLine(line, 12); ed.focus(); window.__lat.length = 0; window.__longTasks.length = 0;
    }, count);
    const t0 = Date.now();
    await page.keyboard.type('abcdefghij', { delay: 0 });
    const wall = Date.now() - t0;
    lat = await latencyStats(page);
    lt = await longTasks(page);
    C.measure(`(3) ${label}: typing 10 chars inside a heading — latency p95 / max (ms)`, `${lat.p95} / ${lat.max}`, 'p95 < 100', lat.p95 < 100);
    C.measure(`(3) ${label}: long tasks during 10 keystrokes (count / max ms), wall ms`, `${lt.count}/${lt.max}, ${wall}`, '0 > 50 ms (P4)', lt.max <= 50);
    s = await settle(page, 60000);
    await sleep(300);
    const toc = await page.evaluate(() => ({ items: document.querySelectorAll('.mdr-toc__item').length, edited: Array.from(document.querySelectorAll('.mdr-toc__item')).some((a) => a.textContent.includes('abcdefghij')) }));
    C.check(`(3) ${label}: TOC updated with the edited heading`, toc.edited, toc);
  }

  // (4) 1 MB single line — 40 keystrokes at the end and at the start
  await page.evaluate(async () => { await window.__mdr.loadText('word '.repeat(200000) + 'END', 'line.md'); });
  s = await settle(page, 60000);
  for (const [label, col] of [['end of line', 1000003], ['start of line', 0]]) {
    await page.evaluate((col) => { const ed = window.__mdr.app.editor; ed.gotoLine(1, col); ed.focus(); window.__lat.length = 0; window.__longTasks.length = 0; }, col);
    const t0 = Date.now();
    await page.keyboard.type('typing into a one megabyte line xxxxxxxx', { delay: 0 });
    const wall = Date.now() - t0;
    lat = await latencyStats(page);
    lt = await longTasks(page);
    C.measure(`(4) 1 MB line, ${label}: latency p50 / p95 / max (ms)`, `${lat.p50} / ${lat.p95} / ${lat.max}`, 'p95 < 100', lat.p95 < 100);
    C.measure(`(4) 1 MB line, ${label}: long tasks (count / max ms) for 40 keystrokes, wall ms`, `${lt.count}/${lt.max}, ${wall}`, 'informational', true);
  }
  s = await settle(page, 60000);
  C.check('(4) settles', s.ok, s);
  await sleep(1500);
  const line = await page.evaluate(() => { const b = document.querySelector('.md-block'); return { pending: b?.classList.contains('is-pending'), slow: b?.classList.contains('is-slow'), len: b?.textContent?.length }; });
  C.check('(4) 1 MB paragraph mounted in preview', line.pending === false && line.len > 1000000, line);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s09b follow-ups', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
