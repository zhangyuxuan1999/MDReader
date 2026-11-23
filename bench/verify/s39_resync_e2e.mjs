// s39 — resync end to end (CONTRACT §8).
// A structureDelta the preview cannot express is NOT silently dropped: `deltaIsApplicable` rejects it,
// the preview calls `opts.resync()` exactly once, App forwards it to the worker client, the client posts
// one coalesced `{type:'resync'}`, the worker drains its queued edits and answers with a FULL `structure`
// (+ the still-dirty ids as `changed`) and an `idle`, and the preview is consistent again — the block
// table tiles the document and later edits render normally.
// Run: MDR_BASE=http://localhost:5199/ node bench/verify/s39_resync_e2e.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep } from './_lib.mjs';

// Count main→worker `resync` posts and worker→main FULL `structure` messages separately from _lib's
// __wmsgs (which collapses structure and structureDelta into one counter).
const INIT = `
(() => {
  window.__resyncPosts = 0;
  const P = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    if (m && m.type === 'resync') window.__resyncPosts++;
    return P.call(this, m, ...rest);
  };
  window.__fullStructures = 0;
  const AEL = Worker.prototype.addEventListener;
  Worker.prototype.addEventListener = function (t, fn, ...rest) {
    if (t === 'message') {
      return AEL.call(this, t, (e) => {
        if (e && e.data && e.data.type === 'structure') window.__fullStructures++;
        return fn(e);
      }, ...rest);
    }
    return AEL.call(this, t, fn, ...rest);
  };
})();`;

const { browser, page, log } = await launch({ initScript: INIT });
const C = makeChecker();

// Sample the block table through the public API (blockAtLine) at fixed document lines.
const snapshot = () => page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const ed = window.__mdr.app.editor;
  const docLines = ed.lineCount();
  const sample = [1, 2, 10, Math.floor(docLines / 2), docLines - 1, docLines]
    .filter((l) => l >= 1 && l <= docLines)
    .map((l) => { const b = p.blockAtLine(l); return { l, index: b.index, id: b.id, startLine: b.startLine, lineCount: b.lineCount }; });
  return { n: p.blockCount(), sample, docLines };
});

try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  const settled = await settle(page);
  C.check('document settled', settled.ok, JSON.stringify(settled));

  const before = await structureCheck(page);
  C.check('baseline structure tiles the document', before.problems.length === 0, JSON.stringify(before.problems));
  const beforeSnap = await snapshot();
  C.check('baseline has blocks', beforeSnap.n > 100, `blockCount ${beforeSnap.n}`);

  const counters0 = await page.evaluate(() => ({ resync: window.__resyncPosts, full: window.__fullStructures }));

  // ---- feed the preview five deltas that CANNOT be expressed against its current block table.
  // Each is well-formed as a message but violates one of the applicability invariants: out-of-range
  // index, a non-tiling replacement, a lineDelta that disagrees with the inserted/removed line counts,
  // a stale version, and an `inserted` whose length is not a multiple of BLOCK_STRIDE.
  const bogus = await page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const v = window.__mdr.version();
    const n = p.blockCount();
    const lineCount = window.__mdr.app.editor.lineCount();
    const stats = { bytes: 0, chars: 0, words: 0, lines: lineCount, headings: 0, codeBlocks: 0, links: 0, images: 0, tables: 0, tasks: 0, readingMinutes: 0 };
    const base = { type: 'structureDelta', version: v, changed: new Int32Array(0), lineCount, stats, outlineVersion: 0 };
    const deltas = [
      // 1. index past the end of the table
      { ...base, index: n + 50, removed: 0, inserted: new Int32Array([999001, 1, 1, 0]), lineDelta: 0 },
      // 2. replacement does not tile: inserted block starts nowhere near the removed range
      { ...base, index: 1, removed: 1, inserted: new Int32Array([999002, 40000, 1, 0]), lineDelta: 0 },
      // 3. lineDelta disagrees with inserted − removed lines
      { ...base, index: 1, removed: 1, inserted: new Int32Array([999003, 2, 7, 0]), lineDelta: 0 },
      // 4. stale version (a version gap / out-of-order delta)
      { ...base, version: v - 5, index: 1, removed: 1, inserted: new Int32Array([999004, 2, 1, 0]), lineDelta: 0 },
      // 5. inserted length is not a multiple of BLOCK_STRIDE
      { ...base, index: 1, removed: 1, inserted: new Int32Array([999005, 2, 1]), lineDelta: 0 },
    ];
    let threw = 0;
    for (const d of deltas) {
      try { p.applyStructureDelta(d); } catch (e) { threw++; }
    }
    return { sent: deltas.length, threw };
  });
  C.check('5 inexpressible deltas applied without throwing', bogus.threw === 0, `threw ${bogus.threw}`);

  // The preview must have asked for a resync; the client coalesces per animation frame.
  await page.waitForFunction((n0) => window.__resyncPosts > n0, counters0.resync, { timeout: 10000 })
    .then(() => C.check('preview requested a resync', true, ''))
    .catch(() => C.check('preview requested a resync', false, 'no resync posted within 10 s'));
  await sleep(500);
  const counters1 = await page.evaluate(() => ({ resync: window.__resyncPosts, full: window.__fullStructures }));
  C.check('exactly one resync posted (coalesced, not repeated per delta)',
    counters1.resync - counters0.resync === 1, `posted ${counters1.resync - counters0.resync}`);

  // ---- the worker answers with a full structure and an idle.
  await page.waitForFunction((n0) => window.__fullStructures > n0, counters0.full, { timeout: 15000 })
    .then(() => C.check('worker answered with a full structure', true, ''))
    .catch(() => C.check('worker answered with a full structure', false, 'no full structure within 15 s'));
  const afterResync = await settle(page);
  C.check('an idle follows the resync (app leaves the rendering state)', afterResync.ok, JSON.stringify(afterResync));

  const after = await structureCheck(page);
  C.check('preview consistent after the resync (structure tiles the document)',
    after.problems.length === 0, JSON.stringify(after.problems));
  const afterSnap = await snapshot();
  C.check('block table unchanged by the rejected deltas',
    afterSnap.n === beforeSnap.n && JSON.stringify(afterSnap.sample) === JSON.stringify(beforeSnap.sample),
    `${beforeSnap.n} → ${afterSnap.n}; ${JSON.stringify(beforeSnap.sample)} → ${JSON.stringify(afterSnap.sample)}`);
  C.check('no bogus block ids leaked into the table',
    !JSON.stringify(afterSnap.sample).includes('99900'), JSON.stringify(afterSnap.sample));
  C.check('no error toast / no giveup', after.errors === 0, `md-error ${after.errors}`);

  // ---- deltas apply again: a real edit renders in the preview.
  const edit = await page.evaluate(async () => {
    const ed = window.__mdr.app.editor;
    const line = Math.floor(ed.lineCount() / 2);
    ed.gotoLine(line, 0);
    return { line };
  });
  await page.keyboard.type('RESYNC-OK');
  await sleep(300);
  await settle(page);
  await sleep(400);
  const rendered = await page.evaluate((line) => {
    const p = window.__mdr.app.preview;
    const b = p.blockAtLine(line);
    const el = document.querySelector(`.md-block[data-id="${b.id}"]`);
    return { text: el ? el.textContent : null, stale: el ? el.classList.contains('is-stale') : null };
  }, edit.line);
  C.check('an edit after the resync renders in the preview',
    !!rendered.text && rendered.text.includes('RESYNC-OK') && rendered.stale === false,
    JSON.stringify(rendered).slice(0, 200));

  const finalCounters = await page.evaluate(() => ({ resync: window.__resyncPosts, full: window.__fullStructures }));
  C.check('no further resync during normal editing',
    finalCounters.resync === counters1.resync, `${counters1.resync} → ${finalCounters.resync}`);

  const finalCheck = await structureCheck(page);
  C.check('structure still tiles the document after the edit', finalCheck.problems.length === 0, JSON.stringify(finalCheck.problems));
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 3).join(' | '));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 3).join(' | '));
  C.check('no worker restarts', log.restarts === 0, `restarts ${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s39 resync e2e', log, { checks: C.results.length, failed: C.failures() });
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
