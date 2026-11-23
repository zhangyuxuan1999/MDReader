// s35 — quantify the worker's `edit` handling cost vs. the number of changes in ONE transaction
// (this is what a search-panel "replace all" produces). Measures dispatch → `structure` arrival.
// Run: node bench/verify/s35_edit_scaling.mjs
import { launch, open, settle, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

/** Load a doc, then replace `n` occurrences of `tok` in ONE transaction; time until `structure`. */
async function run(label, docGen, n, expectBlocks) {
  await page.evaluate(async (src) => { await window.__mdr.loadText(new Function('return (' + src + ')')()(), 'x.md'); }, docGen.toString());
  const s0 = await settle(page, 240000);
  if (!s0.ok) { C.check(`[${label}] base settles`, false, s0); return; }
  const blocks = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  const res = await page.evaluate(async (n) => {
    const v = window.__mdr.app.editor.view;
    const text = v.state.doc.toString();
    const changes = [];
    let idx = -1, count = 0;
    while (count < n && (idx = text.indexOf('tok', idx + 1)) !== -1) { changes.push({ from: idx, to: idx + 3, insert: 'TOKEN-REPLACED' }); count++; }
    const wantVersion = window.__mdr.version() + 1;
    const t0 = performance.now();
    v.dispatch({ changes });
    const dispatchMs = performance.now() - t0;
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      if (window.__wmsgs.structure >= wantVersion) return { changes: changes.length, dispatchMs: +dispatchMs.toFixed(1), structureMs: +(performance.now() - t0).toFixed(0), timeout: false };
      await new Promise((r) => setTimeout(r, 20));
    }
    return { changes: changes.length, dispatchMs: +dispatchMs.toFixed(1), structureMs: -1, timeout: true };
  }, n);
  C.measure(`[${label}] ${blocks} block(s), ${res.changes} changes in one transaction: CM dispatch ms`, res.dispatchMs, '< 500', res.dispatchMs < 500);
  C.measure(`[${label}] ${blocks} block(s), ${res.changes} changes: dispatch → worker \`structure\` ms`, res.timeout ? '>120000' : res.structureMs, '< 10000 (silence limit)', !res.timeout && res.structureMs < 10000);
  console.log(`      ${label}: blocks=${blocks} ${JSON.stringify(res)} restarts=${log.restarts}`);
  await settle(page, 240000);
  return { ...res, blocks };
}

const oneBlock = (lines) => new Function('return (' + (() => { let t = ''; for (let i = 0; i < LINES; i++) t += `tok line ${i} tok\n`; return t; }).toString().replace('LINES', String(lines)) + ')')();

try {
  await open(page, '?mode=split');
  await settle(page, 60000);

  // A. one 50 000-line Prose block (no blank lines), increasing change counts
  for (const n of [100, 1000, 5000, 20000, 100000]) {
    await run(`1 block / 50k lines / n=${n}`, oneBlock(50000), n);
    if (log.restarts) { console.log('  !! restart already happened; remaining rows are polluted'); break; }
  }
  const restartsA = log.restarts;
  C.check('(A) replace-all in a single 50k-line block never triggers a renderer restart', restartsA === 0, `restarts=${restartsA}`);

  // B. same change counts but the document is split into paragraphs (normal markdown)
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 60000 });
  await settle(page, 60000);
  const restartsB0 = log.restarts;
  const manyBlocks = (paras) => new Function('return (' + (() => { let t = ''; for (let i = 0; i < PARAS; i++) t += `tok line ${i} tok\n\n`; return t; }).toString().replace('PARAS', String(paras)) + ')')();
  for (const n of [1000, 20000, 100000]) {
    await run(`${'50k paragraphs'} / n=${n}`, manyBlocks(50000), n);
    if (log.restarts > restartsB0) break;
  }
  C.check('(B) replace-all across 50 000 paragraph blocks never triggers a renderer restart', log.restarts === restartsB0, `restarts=${log.restarts - restartsB0}`);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  console.log('warnings:', JSON.stringify(log.warnings.slice(0, 10)));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s35 edit scaling', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
