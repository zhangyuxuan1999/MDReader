// bench/verify/fixA-large-jump.mjs — fixer-A probe / regression for finding high 1 on test-data/large.md
// (docs/FINDINGS-inline-r1.md): split mode, wheel the PREVIEW far down, click a paragraph, type → the preview
// must stay put; Enter in that block → the session resumes on the new paragraph and typing lands there.
// Waits for the blocks under the viewport to mount instead of assuming 600 ms is enough (a loaded machine).
// Run: MDR_PORT=5271 node bench/verify/fixA-large-jump.mjs   (own vite on MDR_PORT, killed at exit; global timeout)
import { startServer, stopServer, openBrowser, step, assert, finish, sleep, check } from './inline-verify-lib.mjs';

const GLOBAL_MS = Number(process.env.MDR_TIMEOUT_MS) || 240_000;
const killer = setTimeout(() => { console.log('FAIL  global timeout'); stopServer(); process.exit(2); }, GLOBAL_MS);

await startServer();
const B = await openBrowser();
const { page } = B;

async function wheelToAndClick(url, wheelPx) {
  await page.evaluate((u) => window.__mdr.loadUrl(u), url);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(1000);
  const pb = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  for (let left = wheelPx; left > 0; left -= 3000) { await page.mouse.wheel(0, Math.min(3000, left)); await sleep(30); }
  let pt = null;
  let diag = null;
  for (let i = 0; i < 40 && !pt; i++) {
    await sleep(250);
    const r = await page.evaluate(() => {
      const vh = window.__mdr.app.preview.el.getBoundingClientRect();
      const seen = [];
      for (const s of document.querySelectorAll('.mdr-preview section.md-block')) {
        const r = s.getBoundingClientRect();
        if (r.bottom < vh.top || r.top > vh.bottom) continue;
        seen.push(`${s.dataset.id}:${s.className.replace(/md-block ?/, '')}:${(s.textContent || '').slice(0, 20)}`);
        if (s.classList.contains('is-pending')) continue;
        const p = s.querySelector('p');
        if (r.top > vh.top + 50 && r.bottom < vh.bottom - 50 && p && /[一-鿿]{4}/.test(p.textContent || '')) {
          const n = document.createTreeWalker(p, 4).nextNode();
          if (!n || n.data.length < 4) continue;
          const rg = document.createRange(); rg.setStart(n, 2); rg.setEnd(n, 3); const rr = rg.getBoundingClientRect();
          return { pt: { x: rr.left + 1, y: rr.top + rr.height / 2, line: window.__mdr.app.preview.blockOfElement(s)?.startLine }, seen };
        }
      }
      return { pt: null, seen };
    });
    pt = r.pt; diag = r.seen;
  }
  assert(pt, `no paragraph on screen after 10 s; visible: ${JSON.stringify(diag?.slice(0, 6))}`);
  await page.mouse.click(pt.x, pt.y);
  await sleep(150);
  assert(await B.editing(), 'no session');
  return pt;
}
const state = () => page.evaluate(() => {
  const a = window.__mdr.app;
  const e = document.querySelector('.is-editing');
  const v = a.preview.el.getBoundingClientRect();
  const r = e?.getBoundingClientRect();
  const head = a.editor.view.state.selection.main.head;
  const pos = document.querySelector('.mdr-statusbar__item[data-stat="pos"]')?.textContent ?? '';
  const focus = document.querySelector('.mdr-preview .is-focus');
  return {
    st: a.preview.el.scrollTop, top: a.preview.topVisible().line, vis: !!r && r.bottom > v.top && r.top < v.bottom,
    edLine: a.editor.view.state.doc.lineAt(head).number, pos, active: document.activeElement?.className ?? '',
    editorFocused: a.editor.hasFocus(), focusInEditing: !!(focus && e && e.contains(focus)),
  };
});

try {
  await B.boot('mode=split');
  await step('split · large.md: typing in a block scrolled far down keeps the preview where it is, focus and tint stay', async () => {
    const pt = await wheelToAndClick('/test-data/large.md', 300000);
    const before = await state();
    await page.keyboard.type('xyz', { delay: 40 });
    await sleep(700);
    const after = await state();
    await B.esc();
    const d = Math.round(after.st - before.st);
    assert(Math.abs(d) < 50 && after.vis, `preview moved ${d} px (top ${before.top} → ${after.top}), block visible ${after.vis}`);
    assert(!after.editorFocused, 'editor took focus');
    assert(after.focusInEditing, 'focus-line tint left the edited block');
    assert(Math.abs(after.edLine - pt.line) < 40, `editor caret line ${after.edLine} not at the edited block (line ${pt.line})`);
    assert(after.pos.includes(String(after.edLine)), `status bar "${after.pos}" does not show line ${after.edLine}`);
    return `drift ${d} px; block line ${pt.line}; status bar "${after.pos}"`;
  });
  await step('split · large.md: Enter in a block scrolled far down → session resumes on the new paragraph and typing lands there', async () => {
    const pt = await wheelToAndClick('/test-data/large.md', 300000);
    await page.evaluate(() => { window.__fixAMarker = 1; });
    const before = await state();
    await page.keyboard.press('Enter');
    await sleep(600);
    const e = await B.editing();
    await page.keyboard.type('abc');
    await B.settle(400);
    const src = await B.source();
    const after = await state();
    await B.esc();
    const reloaded = await page.evaluate(() => window.__fixAMarker !== 1);
    const around = src.split('\n').slice(pt.line - 1, pt.line + 5).map((l) => l.slice(0, 40)).join(' ⏎ ');
    assert(!reloaded, 'the page reloaded during the step (Vite HMR from another agent\'s edit?) — inconclusive');
    assert(e, `no session after Enter (resume failed); source: ${around}`);
    // The clicked block may be a quote or a list (whatever is on screen): the new paragraph / item then starts
    // with its container's prefix (`> abc…`, `- abc…`) — integrator, 2026-11-20.
    assert(/\n[ \t]*(?:(?:>[ \t]?)|(?:[-*+]|\d+[.)])[ \t]+)*abc/.test(src), `typed text lost; source at line ${pt.line}: ${around}`);
    assert(Math.abs(after.st - before.st) < 200, `preview moved ${Math.round(after.st - before.st)} px`);
    return `drift ${Math.round(after.st - before.st)} px`;
  });
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
