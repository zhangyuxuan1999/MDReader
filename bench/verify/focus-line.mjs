// bench/verify/focus-line.mjs — real-browser verification of the focus line (CONTRACT §9).
//
// Run:  npx vite --port 5241 --strictPort   (in another shell)
//       MDR_BASE=http://localhost:5241 node bench/verify/focus-line.mjs
// Exit code 0 = every check passed, 1 = at least one failed. Console and page errors fail the run.
import { chromium } from '@playwright/test';

const BASE = process.env.MDR_BASE ?? 'http://localhost:5241';
const HEADLESS = process.env.HEADED !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

async function open(doc) {
  const url = `${BASE}/?doc=${doc}&mode=split`;
  // Vite may re-optimize dependencies and reload the page once: load twice, then keep the second one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
      await sleep(attempt === 0 ? 1500 : 300);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(500);
      if (attempt > 0) break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  consoleErrors.length = 0;
  pageErrors.length = 0;
}

// ---------------------------------------------------------------- in-page probes
/** State of both panes: the focus element(s) in the preview, the peer line in the editor, backgrounds. */
const probe = () =>
  page.evaluate(() => {
    const view = window.__mdr.app.editor.view;
    const focusEls = Array.from(document.querySelectorAll('.mdr-preview .is-focus'));
    const fe = focusEls[0];
    const block = fe ? fe.closest('.md-block') : null;
    const marked = fe && fe.hasAttribute('data-l') ? fe : fe ? fe.closest('[data-l]') : null;
    const peer = document.querySelector('.cm-peerLine');
    const activeLine = document.querySelector('.cm-activeLine');
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    return {
      focusCount: focusEls.length,
      focusTag: fe ? fe.tagName : null,
      focusBg: bg(fe),
      focusBlockId: block ? Number(block.dataset.id) : null,
      focusDataL: marked ? Number(marked.dataset.l) : null,
      peerLine: peer ? view.state.doc.lineAt(view.posAtDOM(peer)).number : null,
      peerBg: bg(peer),
      peerActiveClass: view.dom.classList.contains('mdr-peer-active'),
      activeLineBg: bg(activeLine),
      activeLineNumber: activeLine ? view.state.doc.lineAt(view.posAtDOM(activeLine)).number : null,
      caretLine: view.state.doc.lineAt(view.state.selection.main.head).number,
      editorFocused: view.hasFocus,
      scrollTops: { editor: view.scrollDOM.scrollTop, preview: window.__mdr.app.preview.el.scrollTop },
    };
  });

/** Marks a paragraph that is fully inside the preview viewport with `data-verify-target` (so clicking it
 *  never makes Playwright scroll the pane) and returns the absolute line it stands for. `avoid` skips a
 *  line that a previous step already focused. */
const markVisibleParagraph = ({ index = 0, avoid = null } = {}) =>
  page.evaluate((o) => {
    const pv = window.__mdr.app.preview;
    const host = pv.el;
    const box = host.getBoundingClientRect();
    const vis = Array.from(host.querySelectorAll('.md-block:not(.is-pending) p[data-l]')).filter((p) => {
      const r = p.getBoundingClientRect();
      return r.height > 0 && r.top > box.top + 40 && r.bottom < box.bottom - 40;
    });
    if (vis.length === 0) return null;
    // Block id → start line for the blocks around the viewport (the model is the only line source).
    const top = pv.topVisible().line;
    const starts = new Map();
    for (let line = Math.max(1, top - 500), guard = 0; guard < 50_000; guard++) {
      const b = pv.blockAtLine(line);
      if (b.lineCount === 0) break;
      starts.set(b.id, b.startLine);
      line = b.startLine + b.lineCount;
      if (line > top + 5000) break;
    }
    const cands = [];
    for (const el of vis) {
      const st = starts.get(Number(el.closest('.md-block').dataset.id));
      if (st === undefined) continue;
      const line = st + Number(el.dataset.l);
      if (o.avoid === null || line !== o.avoid) cands.push({ el, line });
    }
    if (cands.length === 0) return null;
    const pick = cands[Math.min(o.index, cands.length - 1)];
    for (const n of document.querySelectorAll('[data-verify-target]')) n.removeAttribute('data-verify-target');
    pick.el.setAttribute('data-verify-target', '1');
    return { line: pick.line, candidates: cands.length };
  }, { index, avoid });

/** Waits until the preview tints exactly one element (or times out). */
const waitFocus = (count = 1) =>
  page.waitForFunction((n) => document.querySelectorAll('.mdr-preview .is-focus').length === n, count, { timeout: 5000 });

const opaque = (bg) => bg !== null && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';

// ================================================================ small.md
await open('/test-data/small.md');

let editorLine = 0;
await step('editor click tints the matching preview element with the caret-line colour', async () => {
  // A line with text, a little way down the visible editor.
  const target = page.locator('.cm-content .cm-line').nth(8);
  await target.click();
  editorLine = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    return v.state.doc.lineAt(v.state.selection.main.head).number;
  });
  await waitFocus(1);
  const s = await probe();
  assert(s.editorFocused, 'the editor should have focus after a click in it');
  assert(s.focusCount === 1, `expected one tinted preview element, got ${s.focusCount}`);
  assert(!s.peerActiveClass && s.peerLine === null, 'the editor must not tint a peer line while it owns the caret');
  assert(opaque(s.activeLineBg), `caret line should keep its own background, got ${s.activeLineBg}`);
  assert(s.focusBg === s.activeLineBg, `preview tint ${s.focusBg} != caret line ${s.activeLineBg}`);
  const expected = await page.evaluate((line) => {
    const b = window.__mdr.app.preview.blockAtLine(line);
    return { id: b.id, rel: line - b.startLine };
  }, editorLine);
  assert(s.focusBlockId === expected.id, `tinted block ${s.focusBlockId}, expected ${expected.id} for line ${editorLine}`);
  assert(s.focusDataL === null || s.focusDataL <= expected.rel, `data-l ${s.focusDataL} passes the line (rel ${expected.rel})`);
  return `editor line ${editorLine} → block ${s.focusBlockId} <${s.focusTag}> ${s.focusBg}`;
});

let previewLine = 0;
await step('preview click tints here and mirrors into the editor, hiding the caret line', async () => {
  const target = await markVisibleParagraph({ index: 3 });
  assert(target !== null, 'could not resolve a visible paragraph to a line');
  previewLine = target.line;
  await page.locator('[data-verify-target="1"]').click();
  await waitFocus(1);
  await page.waitForFunction(() => !!document.querySelector('.cm-peerLine'), null, { timeout: 5000 });
  const s = await probe();
  assert(s.peerLine === previewLine, `peer line ${s.peerLine}, expected ${previewLine}`);
  assert(s.peerActiveClass, 'view.dom should carry mdr-peer-active');
  assert(opaque(s.peerBg), `peer line should be tinted, got ${s.peerBg}`);
  assert(!opaque(s.activeLineBg), `caret line background should be hidden while a peer line shows, got ${s.activeLineBg}`);
  assert(s.focusCount === 1 && opaque(s.focusBg), `preview element should stay tinted (${s.focusCount}, ${s.focusBg})`);
  assert(s.peerBg === s.focusBg, `editor peer tint ${s.peerBg} != preview tint ${s.focusBg}`);
  return `preview line ${previewLine} → .cm-peerLine ${s.peerBg}`;
});

await step('the preview click did not scroll either pane or move the caret', async () => {
  const before = await probe();
  await page.locator('[data-verify-target="1"]').click();
  await sleep(250);
  const after = await probe();
  assert(Math.abs(after.scrollTops.editor - before.scrollTops.editor) < 2, `editor scrolled ${before.scrollTops.editor} → ${after.scrollTops.editor}`);
  assert(Math.abs(after.scrollTops.preview - before.scrollTops.preview) < 2, `preview scrolled ${before.scrollTops.preview} → ${after.scrollTops.preview}`);
  assert(after.caretLine === before.caretLine, `caret moved ${before.caretLine} → ${after.caretLine}`);
  assert(!after.editorFocused, 'a preview click must not pull focus into the editor');
  return `caret still on line ${after.caretLine}, scrollTops unchanged`;
});

await step('selecting text in the preview focuses the anchor line', async () => {
  const target = await markVisibleParagraph({ index: 1, avoid: previewLine });
  assert(target !== null, 'could not resolve a visible paragraph to a line');
  assert(target.line !== previewLine, 'the selection must land on a different line than the click test used');
  await page.evaluate(() => {
    const el = document.querySelector('[data-verify-target="1"]');
    const text = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : el;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(8, (text.textContent || '').length || 1));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.waitForFunction((l) => {
    const v = window.__mdr.app.editor.view;
    const peer = document.querySelector('.cm-peerLine');
    return !!peer && v.state.doc.lineAt(v.posAtDOM(peer)).number === l;
  }, target.line, { timeout: 5000 });
  const s = await probe();
  assert(s.focusCount === 1, `expected one tinted preview element, got ${s.focusCount}`);
  assert(!opaque(s.activeLineBg), `caret line should stay hidden, got ${s.activeLineBg}`);
  return `selection anchor line ${target.line} mirrored into the editor`;
});

await step('clicking back into the editor clears the peer line', async () => {
  await page.locator('.cm-content .cm-line').nth(2).click();
  await page.waitForFunction(() => !document.querySelector('.cm-peerLine'), null, { timeout: 5000 });
  const s = await probe();
  assert(!s.peerActiveClass, 'mdr-peer-active should be gone');
  assert(opaque(s.activeLineBg), `caret line should be tinted again, got ${s.activeLineBg}`);
  assert(s.focusCount === 1 && s.focusBg === s.activeLineBg, `preview should follow the caret (${s.focusCount}, ${s.focusBg} vs ${s.activeLineBg})`);
  return `caret line ${s.caretLine} owns the tint again`;
});

await step('the tint survives a theme toggle in both panes', async () => {
  const light = await probe();
  await page.evaluate(() => window.__mdr.app.registry.run('view.toggleTheme'));
  await sleep(300);
  const dark = await probe();
  assert(dark.focusBg !== light.focusBg, `the tint should change with the theme (${light.focusBg} → ${dark.focusBg})`);
  assert(opaque(dark.focusBg) && dark.focusBg === dark.activeLineBg, `dark: ${dark.focusBg} vs ${dark.activeLineBg}`);
  // …and the preview → editor direction still works in the new theme.
  const target = await markVisibleParagraph({ index: 2 });
  assert(target !== null, 'could not resolve a visible paragraph to a line');
  await page.locator('[data-verify-target="1"]').click();
  await page.waitForFunction((l) => {
    const v = window.__mdr.app.editor.view;
    const peer = document.querySelector('.cm-peerLine');
    return !!peer && v.state.doc.lineAt(v.posAtDOM(peer)).number === l;
  }, target.line, { timeout: 5000 });
  const s = await probe();
  assert(s.peerBg === s.focusBg && opaque(s.peerBg), `dark peer ${s.peerBg} vs preview ${s.focusBg}`);
  assert(!opaque(s.activeLineBg), `dark caret line should be hidden, got ${s.activeLineBg}`);
  await page.evaluate(() => window.__mdr.app.registry.run('view.toggleTheme'));
  await sleep(300);
  return `light ${light.focusBg} / dark ${dark.focusBg}`;
});

await step('mode switches keep the state, and a new document clears it', async () => {
  await page.evaluate(() => window.__mdr.mode('edit'));
  await sleep(200);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(300);
  const kept = await probe();
  assert(kept.focusCount === 1, `the preview tint should survive a mode switch, got ${kept.focusCount}`);
  await page.evaluate(() => window.__mdr.loadText('# fresh\n\npara one\n\npara two\n', 'fresh.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const fresh = await probe();
  assert(fresh.focusCount === 0, `a new document must start untinted in the preview, got ${fresh.focusCount}`);
  assert(fresh.peerLine === null, 'a new document must start without a peer line');
  return 'cleared on load';
});

// ================================================================ large.md
await open('/test-data/large.md');

await step('large.md: a preview click near line 50000 tints exactly one element and the right editor line', async () => {
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(50_000, 0));
  await sleep(1500);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.waitForFunction(
    () => document.querySelectorAll('.mdr-preview .md-block:not(.is-pending) p[data-l]').length > 0,
    null,
    { timeout: 30_000 },
  );
  await sleep(500);
  const target = await markVisibleParagraph({ index: 2 });
  assert(target !== null, 'no mounted paragraph found near line 50000');
  assert(target.line > 40_000, `expected a line deep in the document, got ${target.line}`);
  await page.locator('[data-verify-target="1"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.is-focus').length === 1, null, { timeout: 10_000 });
  // The editor is still at the top of the document (a programmatic preview scroll does not drag it along),
  // so CodeMirror renders nothing around line 50000 yet: the decoration exists in the state, and the
  // `mdr-peer-active` attribute proves it. Scroll the editor there — which never clears a peer line — and
  // the decorated line must be exactly the clicked one.
  const offScreen = await probe();
  assert(offScreen.peerActiveClass, 'the peer line should be set even while its line is outside the viewport');
  // CodeMirror's height map is estimated this far down, so the first scroll lands a couple of hundred
  // lines off and the second one — with the real heights measured — is exact.
  let rendered = false;
  for (let attempt = 0; attempt < 8 && !rendered; attempt++) {
    await page.evaluate((l) => window.__mdr.app.editor.scrollToLine(Math.max(1, l - 10), 0), target.line);
    await sleep(350);
    rendered = await page.evaluate(() => !!document.querySelector('.cm-peerLine'));
  }
  assert(rendered, 'the peer line never rendered, even with the editor scrolled onto it');
  const at = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    return v.state.doc.lineAt(v.posAtDOM(document.querySelector('.cm-peerLine'))).number;
  });
  assert(at === target.line, `editor decoration on line ${at}, expected ${target.line}`);
  const all = await page.evaluate(() => document.querySelectorAll('.is-focus').length);
  assert(all === 1, `exactly one tinted element expected in the whole document, got ${all}`);
  const s = await probe();
  assert(s.peerLine === target.line, `editor decoration on line ${s.peerLine}, expected ${target.line}`);
  assert(opaque(s.peerBg) && s.peerBg === s.focusBg, `tints differ: editor ${s.peerBg}, preview ${s.focusBg}`);
  assert(!opaque(s.activeLineBg), `caret line should be hidden, got ${s.activeLineBg}`);
  return `line ${target.line}: one .is-focus, .cm-peerLine on the same line`;
});

// ================================================================ errors
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
