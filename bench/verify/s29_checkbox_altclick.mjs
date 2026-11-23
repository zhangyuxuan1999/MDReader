// s29 — preview → source write-back at scale: toggle the FIRST, MIDDLE and LAST checkbox of a
// 4000-item task list (after the giant-block mount guard), and Alt+click-to-source on deep blocks.
// Run: node bench/verify/s29_checkbox_altclick.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?mode=split');
  await settle(page, 60000);

  // ---- one giant list block, 4000 loose tasks (one source line per task, blank line between)
  await page.evaluate(async () => { let t = ''; for (let i = 0; i < 4000; i++) t += `- [ ] task ${i}\n\n`; await window.__mdr.loadText(t, 'tasks.md'); });
  let s = await settle(page, 120000);
  C.check('4000-task doc settles', s.ok, s);
  await page.waitForFunction(() => { const b = document.querySelector('.md-block'); return b && !b.classList.contains('is-pending') && b.innerHTML.length > 0; }, null, { timeout: 30000 });
  const n = await page.evaluate(() => document.querySelectorAll('.md-block input[type=checkbox]').length);
  C.check('all 4000 checkboxes rendered in the single block', n === 4000, `checkboxes=${n}`);

  for (const [label, idx] of [['first', 0], ['middle', 2000], ['last', 3999]]) {
    const res = await page.evaluate(async (idx) => {
      const boxes = document.querySelectorAll('.md-block input[type=checkbox]');
      const before = window.__mdr.app.editor.getText().split('\n');
      boxes[idx].click();
      await new Promise((r) => setTimeout(r, 400));
      const after = window.__mdr.app.editor.getText().split('\n');
      const changed = [];
      for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) changed.push({ i, before: before[i], after: after[i] });
      return { changed, expectedLineIdx: idx * 2 };
    }, idx);
    C.check(`toggling the ${label} checkbox (#${idx}) changes exactly one source line`, res.changed.length === 1, res.changed.slice(0, 3));
    C.check(`toggling the ${label} checkbox (#${idx}) changes the RIGHT source line`,
      res.changed.length === 1 && res.changed[0].i === res.expectedLineIdx && /- \[x\] task /i.test(res.changed[0].after),
      { got: res.changed[0], expectedLineIdx: res.expectedLineIdx });
    s = await settle(page, 120000);
    C.check(`settles after toggling the ${label} checkbox`, s.ok, s);
  }
  let sc = await structureCheck(page);
  C.check('structure tiles after the toggles', sc.problems.length === 0, sc);

  // ---- many separate task blocks (blank-line separated headings between) — line mapping across blocks
  await page.evaluate(async () => {
    let t = '';
    for (let i = 0; i < 1000; i++) t += `## Section ${i}\n\n- [ ] task ${i}\n\n`;
    await window.__mdr.loadText(t, 'sections.md');
  });
  s = await settle(page, 120000);
  C.check('1000-section task doc settles', s.ok, s);
  await page.evaluate(() => window.__mdr.app.preview.mountAll());
  await sleep(800);
  const deep = await page.evaluate(async () => {
    const boxes = document.querySelectorAll('.md-block input[type=checkbox]');
    if (boxes.length < 900) return { ok: false, n: boxes.length };
    const before = window.__mdr.app.editor.getText().split('\n');
    boxes[900].click();
    await new Promise((r) => setTimeout(r, 500));
    const after = window.__mdr.app.editor.getText().split('\n');
    const changed = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push({ i, before: before[i], after: after[i] });
    return { ok: true, n: boxes.length, changed, expectedLineIdx: 900 * 4 + 2 };
  });
  C.check('toggling checkbox #900 across 1000 blocks hits exactly the right line', deep.ok && deep.changed.length === 1 && deep.changed[0].i === deep.expectedLineIdx, deep);

  // ---- Alt+click-to-source deep in the document
  await page.evaluate(async () => { await window.__mdr.loadUrl('/test-data/large.md'); });
  s = await settle(page, 180000);
  C.check('large.md settles', s.ok, s);
  const alt = await page.evaluate(async () => {
    const p = window.__mdr.app.preview;
    p.scrollToLine(60000, 0);
    await new Promise((r) => setTimeout(r, 1200));
    const r = p.el.getBoundingClientRect();
    let target = null;
    for (const b of document.querySelectorAll('.md-block')) {
      const br = b.getBoundingClientRect();
      if (br.top > r.top + 30 && br.top < r.bottom - 30 && b.firstElementChild) { target = b.querySelector('[data-l]') || b.firstElementChild; break; }
    }
    if (!target) return { ok: false, reason: 'no mounted block in view' };
    const blockId = Number(target.closest('.md-block').dataset.id);
    const info = p.blockAtLine(p.scrollTopToLine(p.el.scrollTop).line);
    const rel = Number(target.getAttribute('data-l') ?? 0);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    await new Promise((rr) => setTimeout(rr, 800));
    const e = window.__mdr.app.editor;
    return { ok: true, blockId, cursorLine: e.view.state.doc.lineAt(e.view.state.selection.main.head).number, rel, topBlock: info };
  });
  C.check('Alt+click deep in the preview moves the editor cursor near that line', alt.ok && Math.abs(alt.cursorLine - alt.topBlock.startLine) < 200, alt);
  sc = await structureCheck(page);
  C.check('structure tiles at the end', sc.problems.length === 0, sc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s29 checkbox + alt-click', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
