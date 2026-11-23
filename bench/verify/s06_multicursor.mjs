// s06 — multi-cursor edits: (a) 3 real cursors + keyboard typing, (b) one transaction with 200
// non-adjacent changes incl. cross-block deletions and newline insertions (reverse-order application),
// (c) 50 cursors typing. After each: worker mirror must equal a from-scratch render of editor.getText().
// Run: node bench/verify/s06_multicursor.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, makeChecker, report, loadText, fetchTestDoc, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

async function compareWithFresh(label) {
  const s = await settle(page, 90000);
  C.check(`${label}: settled`, s.ok, s);
  const sc = await structureCheck(page);
  C.check(`${label}: structure tiles`, sc.problems.length === 0, sc);
  const incr = await previewSnapshot(page);
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  await loadText(page, text, 'fresh.md');
  const s2 = await settle(page, 90000);
  C.check(`${label}: fresh settled`, s2.ok, s2);
  const fresh = await previewSnapshot(page);
  const diffs = diffSnapshots(incr, fresh);
  C.check(`${label}: incremental preview === fresh render`, diffs.length === 0, diffs);
  C.check(`${label}: block count`, incr.length === fresh.length, `${incr.length} vs ${fresh.length}`);
  return text;
}

try {
  await open(page, '?mode=split');
  const small = await fetchTestDoc('small.md');
  await loadText(page, small, 'small.md');
  await settle(page, 60000);

  // (a) three cursors on three different lines, type text
  await page.evaluate(() => {
    const view = window.__mdr.app.editor.view;
    const ES = view.state.selection.constructor;
    const d = view.state.doc;
    const cursors = [10, 300, 800].map((l) => ES.cursor(d.line(l).from));
    view.dispatch({ selection: ES.create(cursors, 0) });
    view.focus();
  });
  await page.keyboard.type('MULTI ', { delay: 0 });
  const n = await page.evaluate(() => (window.__mdr.app.editor.getText().match(/MULTI /g) || []).length);
  C.check('3-cursor typing inserted 3 copies', n === 3, `count=${n}`);
  await compareWithFresh('3 cursors typing');

  // (b) one transaction with 200 changes at increasing offsets: alternating inserts of "\n\n# H\n\n" and deletions of 30 chars
  await loadText(page, small, 'small-b.md');
  await settle(page, 60000);
  await page.evaluate(() => {
    const view = window.__mdr.app.editor.view;
    const len = view.state.doc.length;
    const changes = [];
    for (let i = 0; i < 200; i++) {
      const from = Math.floor((i + 1) * len / 202);
      if (i % 2 === 0) changes.push({ from, insert: '\n\n# H' + i + '\n\n' });
      else changes.push({ from, to: Math.min(len, from + 30), insert: '' });
    }
    view.dispatch({ changes });
  });
  await compareWithFresh('200-change transaction');

  // (c) 50 cursors typing incl. Enter (list continuation etc.) on medium.md
  const medium = await fetchTestDoc('medium.md');
  await loadText(page, medium, 'medium.md');
  await settle(page, 60000);
  await page.evaluate(() => {
    const view = window.__mdr.app.editor.view;
    const ES = view.state.selection.constructor;
    const d = view.state.doc;
    const cursors = [];
    for (let i = 1; i <= 50; i++) cursors.push(ES.cursor(d.line(i * 400).from));
    view.dispatch({ selection: ES.create(cursors, 0) });
    view.focus();
  });
  await page.keyboard.type('fifty\nlines ', { delay: 0 });
  const n2 = await page.evaluate(() => (window.__mdr.app.editor.getText().match(/fifty\n/g) || []).length);
  C.check('50-cursor typing inserted 50 copies', n2 === 50, `count=${n2}`);
  await compareWithFresh('50 cursors typing');

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s06 multi-cursor', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
