// bench/verify/review-docswitch.mjs — static-review follow-ups measured in the browser:
//  (1) App.save() re-seeds the worker with setDoc under a new docId after Save-As: the preview gets a
//      structure reset (all wrappers recreated, all ids new). Reproduce the same call path via the worker api.
//  (2) applyStructure reset removes old wrappers one by one (removeBlock per id): measure the longest task
//      when switching from large.md to a tiny document.
//  (3) theme matchMedia listener survives app.dispose().
// run: node bench/verify/review-docswitch.mjs   (server on :5205)
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, report, sleep } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
const results = [];
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, 'large.md');
  await waitIdle(page);
  await installMonitor(page);

  // ---------- (1) Save-As path: worker.setDoc(newDocId, editor.version, text)
  const before = await page.evaluate(() => ({
    blocks: window.__mdr.app.preview.blockCount(),
    pending: document.querySelectorAll('.md-block.is-pending').length,
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
    firstId: document.querySelector('.md-block')?.dataset.id,
    structureMarks: performance.getEntriesByName('mdr:structure').length,
    scrollTop: window.__mdr.app.preview.el.scrollTop,
  }));
  // scroll somewhere in the middle first so the effect is visible
  await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(30000, 0); });
  await sleep(600);
  await waitIdle(page);
  const mid = await page.evaluate(() => ({
    scrollTop: window.__mdr.app.preview.el.scrollTop,
    top: window.__mdr.app.preview.topVisible(),
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
    // The first wrapper AFTER scrolling: far-away chunks are dormant, so `before.firstId` (sampled at the
    // top of the document) is not the right baseline for the re-seed comparison.
    firstId: document.querySelector('.md-block')?.dataset.id,
  }));
  await resetMonitor(page);
  const t0 = Date.now();
  await page.evaluate(() => {
    const app = window.__mdr.app;
    // exactly what App.save() does when the docId changes (Save-As of an untitled/legacy document):
    app.worker.setDoc('new-doc-id', app.editor.version, app.editor.getText());
    app.worker.draft('enable');
  });
  // Right after the structure arrives: how much of the DOM was thrown away? A fixed wait, not a wait for
  // a new `mdr:structure` mark — an identity-preserving re-seed is no longer a reset, so that mark (which
  // the preview only sets for a setDoc-sized replacement) is exactly what must NOT appear.
  await sleep(1000);
  const after = await page.evaluate(() => ({
    pending: document.querySelectorAll('.md-block.is-pending').length,
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
    firstId: document.querySelector('.md-block')?.dataset.id,
    structureMarks: performance.getEntriesByName('mdr:structure').length,
    scrollTop: window.__mdr.app.preview.el.scrollTop,
    top: window.__mdr.app.preview.topVisible(),
  }));
  await waitIdle(page);
  const settled = await page.evaluate(() => ({
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
    scrollTop: window.__mdr.app.preview.el.scrollTop,
    top: window.__mdr.app.preview.topVisible(),
  }));
  const mon1 = await readMonitor(page);
  console.log('save-as path: before', before, '\n mid', mid, '\n after structure', after, '\n settled', settled, `\n elapsed ${Date.now() - t0} ms`, '\n monitor', { over50: mon1.over50, maxGap: mon1.maxGap, longtasks: mon1.longtasks.map((t) => Math.round(t.dur)) });
  results.push({ name: 'save-as re-seed: preview structure reset (mdr:structure marks +1, first wrapper id changed)', value: `marks ${before.structureMarks}→${after.structureMarks}, firstId ${mid.firstId}→${after.firstId}, mounted ${mid.mounted}→${after.mounted}`, target: 'no reset (ids kept, mounted content kept)', pass: after.structureMarks === before.structureMarks && after.firstId === mid.firstId });
  results.push({ name: 'save-as re-seed: reading position kept', value: `line ${mid.top.line} → ${settled.top.line}`, target: 'same line ±2', pass: Math.abs(mid.top.line - settled.top.line) <= 2 });

  // ---------- (2) doc switch large → tiny: longest task
  await resetMonitor(page);
  await page.evaluate(async () => { await window.__mdr.loadText('# tiny\n\nhello', 'tiny.md'); });
  await waitIdle(page);
  await sleep(300);
  const mon2 = await readMonitor(page);
  const longest = mon2.longtasks.reduce((m, t) => Math.max(m, t.dur), 0);
  console.log('large→tiny switch: longtasks', mon2.longtasks.map((t) => Math.round(t.dur)), 'maxGap', Math.round(mon2.maxGap));
  results.push({ name: 'large.md → tiny doc: longest main-thread task', value: `${Math.round(longest)} ms`, target: '< 120 ms (P4 budget for the open path)', pass: longest < 120 });

  // ---------- (3) dispose leaves the matchMedia listener
  const disposed = await page.evaluate(() => {
    const app = window.__mdr.app;
    const before = document.documentElement.dataset.theme;
    app.theme.set('light');
    app.dispose();
    document.documentElement.dataset.theme = 'probe';
    // emulate prefers-color-scheme change: theme.ts listens on matchMedia('(prefers-color-scheme: dark)')
    return { before, still: !!document.querySelector('.mdr-app'), theme: document.documentElement.dataset.theme };
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(100);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  console.log('dispose probe', disposed, 'theme after media change:', themeAfter);
  results.push({ name: 'theme listener after app.dispose() (data-theme rewritten by a disposed app on media change)', value: `data-theme=${themeAfter}`, target: '"probe" (listener removed)', pass: themeAfter === 'probe' });
} finally {
  report('review-docswitch', results);
  if (errors.length) console.log('console/page errors:', errors);
  await browser.close();
}
