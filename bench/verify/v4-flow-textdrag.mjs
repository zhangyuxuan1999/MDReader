// bench/verify/v4-flow-textdrag.mjs — verify-flows (round-3 re-verification): drags that are NOT files, from the
// preview into the editor and from outside into the preview / editor, on the candidate and on 0.1.1 with the
// same code. Real mouse drags (Playwright's Chromium drag interception) and trusted CDP drops.
//   [MDR_URL=http://localhost:5434/] [MDR_BASE_URL='http://localhost:5444/?perf=1'] node bench/verify/v4-flow-textdrag.mjs [case …]
// Writes nothing into the tree. Global timeout 110 s.
import { sleep, runBoth, snap, loadDoc, pointOf, cdpDrag } from './v4-flow-lib.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DOC = `first editor line\n\n![pic](${PNG})\n\nsee [the link](https://example.com/x) here\n\nwords to drag here\n`;
const editorPoint = (page) => page.evaluate(() => {
  const v = window.__mdr.app.editor.view;
  const c = v.coordsAtPos(5);
  return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
});
async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await sleep(100);
  await page.mouse.up();
  await sleep(900);
}
const C = {};
C['img-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    const from = await pointOf(page, '.mdr-preview img');
    if (!from) return { error: 'no img' };
    await mouseDrag(page, from, await editorPoint(page));
    return snap(page);
  },
  expect: (r, b) => !b || (r.text === b.text && r.toasts.length === b.toasts.length),
};
C['link-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    const from = await pointOf(page, '.mdr-preview a');
    await mouseDrag(page, from, await editorPoint(page));
    return snap(page);
  },
  expect: (r, b) => !b || (r.text === b.text && r.toasts.length === b.toasts.length),
};
// Text selected in the preview WITHOUT a session (a drag-selection across two blocks), dragged to the editor.
C['preview-sel-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.mdr-preview p')];
      const a = ps.find((p) => p.textContent.startsWith('see'));
      const b = ps.find((p) => p.textContent.startsWith('words'));
      const r = document.createRange();
      r.setStart(a.firstChild, 0);
      r.setEnd(b.firstChild, 5);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    const from = await pointOf(page, '.mdr-preview p:last-of-type', 0.02);
    await mouseDrag(page, from, await editorPoint(page));
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview [contenteditable="true"]'));
    return { ...(await snap(page)), live };
  },
  expect: (r, b) => !b || r.text === b.text,
};
// A word selected INSIDE a live session (double-click), dragged into the editor pane.
C['session-word-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    const p = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.startsWith('words'));
      const r = document.createRange();
      r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 5);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    await page.mouse.dblclick(p.x, p.y);
    await sleep(300);
    const sel = await page.evaluate(() => String(getSelection()));
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview [contenteditable="true"]'));
    await mouseDrag(page, p, await editorPoint(page));
    await page.keyboard.press('Escape');
    await sleep(700);
    return { sel, live, ...(await snap(page)) };
  },
  // Whatever happens, the document holds every word exactly once or the dragged word twice (a copy) — never
  // a word lost.
  expect: (r) => r.text.includes('words') && r.text.includes('to drag here') && r.text.includes('first'),
};
C['ext-uri-to-session'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    const p = await pointOf(page, '.mdr-preview p:last-of-type', 0.9);
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    await cdpDrag(page, p, { items: [{ mimeType: 'text/uri-list', data: 'https://example.com/u' }, { mimeType: 'text/plain', data: 'https://example.com/u' }], dragOperationsMask: 1 | 2 | 16 });
    await sleep(800);
    await page.keyboard.press('Escape');
    await sleep(600);
    return snap(page);
  },
  expect: (r) => r.text === DOC,
};
C['ext-html-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    await cdpDrag(page, await editorPoint(page), { items: [{ mimeType: 'text/html', data: '<b>B</b>' }, { mimeType: 'text/plain', data: 'PLAINX' }], dragOperationsMask: 1 | 2 | 16 });
    await sleep(700);
    return snap(page);
  },
  expect: (r, b) => !b || r.text === b.text,
};
C['ext-htmlonly-to-editor'] = {
  async run(page) {
    await loadDoc(page, DOC, 'drag.md');
    await cdpDrag(page, await editorPoint(page), { items: [{ mimeType: 'text/html', data: '<b>B</b>' }], dragOperationsMask: 1 | 2 | 16 });
    await sleep(700);
    return snap(page);
  },
  expect: (r, b) => !b || r.text === b.text,
};
process.exit((await runBoth(C)) ? 1 : 0);
