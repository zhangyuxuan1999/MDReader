// s36 — cost matrix for one `edit` transaction: (lines in the containing block) × (number of changes).
// Fresh page per row so an earlier restart cannot pollute the next measurement.
// Run: node bench/verify/s36_edit_matrix.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const rows = [];

async function row(blockLines, n, sep) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 60000 });
  await settle(page, 60000);
  const restarts0 = log.restarts;
  await page.evaluate(async ({ blockLines, sep }) => {
    let t = ''; for (let i = 0; i < blockLines; i++) t += `tok line ${i} tok\n` + sep;
    await window.__mdr.loadText(t, 'm.md');
  }, { blockLines, sep });
  const s0 = await settle(page, 240000);
  if (!s0.ok) { C.check(`base settles (${blockLines} lines, sep=${JSON.stringify(sep)})`, false, s0); return; }
  const blocks = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  const res = await page.evaluate(async (n) => {
    const v = window.__mdr.app.editor.view;
    const text = v.state.doc.toString();
    const changes = []; let idx = -1;
    while (changes.length < n && (idx = text.indexOf('tok', idx + 1)) !== -1) changes.push({ from: idx, to: idx + 3, insert: 'TOKEN' });
    const want = window.__mdr.version() + 1;
    const t0 = performance.now();
    v.dispatch({ changes });
    const deadline = performance.now() + 60000;
    while (performance.now() < deadline) {
      if (window.__wmsgs.structure >= want) return { n: changes.length, ms: +(performance.now() - t0).toFixed(0), timeout: false };
      await new Promise((r) => setTimeout(r, 20));
    }
    return { n: changes.length, ms: -1, timeout: true };
  }, n);
  await sleep(500);
  const r = { blockLines, blocks, changes: res.n, ms: res.timeout ? '>60000' : res.ms, perChangeMs: res.timeout ? null : +(res.ms / res.n).toFixed(2), restarted: log.restarts > restarts0 };
  rows.push(r);
  console.log('  ', JSON.stringify(r));
  C.measure(`block=${blockLines} lines (${blocks} blocks), ${res.n} changes → structure ms`, r.ms, '< 10000 (silence limit)', !res.timeout && res.ms < 10000 && !r.restarted);
  return r;
}

try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  console.log('--- single block (no blank lines): block size × change count');
  for (const [lines, n] of [[1000, 1000], [5000, 1000], [5000, 5000], [20000, 1000], [50000, 1000], [50000, 5000]]) await row(lines, n, '');
  console.log('--- paragraph-separated control');
  for (const [lines, n] of [[50000, 5000], [50000, 100000]]) await row(lines, n, '\n');
  console.log('\nMATRIX');
  console.table(rows);
  const bad = rows.filter((r) => r.restarted || r.ms === '>60000' || r.ms > 10000);
  C.check('no configuration exceeds the 10 s silence budget', bad.length === 0, bad);
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s36 edit matrix', log, { warnings: log.warnings.slice(0, 10) });
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
