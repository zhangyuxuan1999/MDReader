// s18 — document-switch storm: 20 loadText calls fired back-to-back without awaiting (small/medium/large
// alternating, plus edits between them), then settle. The preview/structure must correspond to the LAST
// document only (no stale structure or html from a previous doc applied late); stats/TOC must match.
// Also: loadText during a typing burst. Run: node bench/verify/s18_docswitch_storm.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, latencyStats, makeChecker, report, sleep, fetchTestDoc, loadText } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?mode=split');
  await settle(page, 30000);
  const small = await fetchTestDoc('small.md');
  const medium = await fetchTestDoc('medium.md');
  const large = await fetchTestDoc('large.md');
  const docs = { small, medium, large };

  // fire 20 loads without awaiting; type between some of them
  const t0 = Date.now();
  await page.evaluate(async (docs) => {
    const seq = ['large', 'small', 'medium', 'large', 'small', 'large', 'medium', 'small', 'large', 'medium', 'small', 'large', 'small', 'medium', 'large', 'small', 'medium', 'large', 'medium', 'small'];
    const ps = [];
    for (let i = 0; i < seq.length; i++) {
      ps.push(window.__mdr.loadText(docs[seq[i]], seq[i] + i + '.md'));
      if (i % 4 === 1) { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'EDIT' + i + '\n' } }); }
    }
    await Promise.all(ps);
  }, docs);
  const s = await settle(page, 120000);
  C.check('settles after 20 back-to-back loads', s.ok, s);
  C.measure('20 loads + settle wall (ms)', Date.now() - t0, 'informational', true);
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('editor holds the last document (small.md)', text === small, `len ${text.length} vs ${small.length}`);
  const sc = await structureCheck(page);
  C.check('structure tiles the final document', sc.problems.length === 0, sc);
  const incr = await previewSnapshot(page);
  await loadText(page, small, 'fresh.md');
  await settle(page, 30000);
  const fresh = await previewSnapshot(page);
  const sc2 = await structureCheck(page);
  C.check('block count equals a clean load of small.md', sc.blocks === sc2.blocks, `${sc.blocks} vs ${sc2.blocks}`);
  const diffs = diffSnapshots(incr, fresh);
  C.check('preview after storm === fresh render of small.md', diffs.length === 0, diffs);
  const toc = await page.evaluate(() => ({ items: document.querySelectorAll('.mdr-toc__item').length, first: document.querySelector('.mdr-toc__item')?.textContent }));
  const tocExpect = (small.match(/^#{1,6} /gm) || []).length;
  C.check('TOC item count matches small.md headings', toc.items === tocExpect, { toc, tocExpect });
  const stat = await page.evaluate(() => document.querySelector('.mdr-statusbar')?.textContent || '');
  C.check('status bar file name is the last loaded one', /fresh\.md/.test(stat), stat);

  // loadText in the middle of a typing burst
  await loadText(page, medium, 'medium.md');
  await settle(page, 60000);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(500, 0); ed.focus(); window.__lat.length = 0; });
  // The load must land *inside* the burst. 600 ms used to be inside it; typing 420 chars into medium.md
  // now takes ~210 ms end to end, so the timer fired after the burst (and after the assertions below) and
  // the scenario silently stopped being tested. Schedule it early and wait for it to actually apply.
  await page.evaluate((large) => {
    window.__midLoad = 'pending';
    setTimeout(() => { window.__mdr.loadText(large, 'large-mid-burst.md').then(() => { window.__midLoad = 'done'; }, (e) => { window.__midLoad = 'error: ' + e; }); }, 80);
  }, large);
  await page.keyboard.type('typing '.repeat(60), { delay: 0 });
  await page.waitForFunction(() => window.__midLoad !== 'pending', null, { timeout: 60000 });
  C.check('the mid-burst load actually ran', (await page.evaluate(() => window.__midLoad)) === 'done', await page.evaluate(() => window.__midLoad));
  const lat = await latencyStats(page);
  C.measure('latency p95 while a 2 MB load lands mid-burst (ms)', lat.p95, '< 100', lat.p95 < 100);
  const s2 = await settle(page, 120000);
  C.check('settles after load-mid-burst', s2.ok, s2);
  const t2 = await page.evaluate(() => window.__mdr.app.editor.getText());
  const sc3 = await structureCheck(page);
  C.check('structure tiles after load-mid-burst', sc3.problems.length === 0, sc3);
  C.check('editor text = large.md with the post-load keystrokes inserted (prefix/suffix intact)', t2.length >= large.length && t2.replace(/typing /g, '') === large.replace(/typing /g, ''), { len: t2.length, large: large.length });
  const incr2 = await previewSnapshot(page);
  await loadText(page, t2, 'fresh2.md');
  await settle(page, 120000);
  const fresh2 = await previewSnapshot(page);
  const diffs2 = diffSnapshots(incr2, fresh2);
  C.check('preview after load-mid-burst === fresh render', diffs2.length === 0, diffs2);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s18 docswitch storm', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
