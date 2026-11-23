// bench/verify/review-toc-active.mjs — in-app repro of the TOC active-highlight loss: put the cursor inside a
// heading, type into it (same heading count → toc.ts reconcile rewrites className in place, dropping
// .is-active; activate() then short-circuits because activeEl is unchanged). Also checks that the browser's
// own copy of the outline text was updated (the TOC item text follows the edit).
// Run: PORT=5205 node bench/verify/review-toc-active.mjs
import { openPage, gotoApp, waitIdle, sleep, report } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
const tocState = () => page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.mdr-toc__item'));
  return { count: items.length, active: items.filter((a) => a.classList.contains('is-active')).map((a) => a.textContent), texts: items.map((a) => a.textContent) };
});
try {
  await gotoApp(page, 'mode=split');
  await page.evaluate(async () => { await window.__mdr.loadText('# Intro\n\ntext\n\n## Usage\n\nmore text\n\n## Other\n\nend\n', 'toc.md'); });
  await waitIdle(page);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(5, 8); ed.focus(); });
  await sleep(300);
  const s0 = await tocState();
  await page.keyboard.type('s');           // "## Usage" → "## Usages"
  await waitIdle(page);
  await sleep(300);
  const s1 = await tocState();
  // move the cursor within the same heading line and back: still the same heading → still no highlight?
  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  const s2 = await tocState();
  // moving to another heading and back restores it (activeEl changes)
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); });
  await sleep(300);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(5, 3); });
  await sleep(300);
  const s3 = await tocState();
  console.log({ s0, s1, s2, s3 });
  report('review-toc-active', [
    { name: 'before typing: cursor heading highlighted', value: JSON.stringify(s0.active), target: '["Usage"]', pass: s0.active.length === 1 && s0.active[0] === 'Usage' },
    { name: 'TOC text follows the edit', value: JSON.stringify(s1.texts), target: 'contains "Usages"', pass: s1.texts.includes('Usages') },
    { name: 'after typing inside the heading: highlight kept', value: JSON.stringify(s1.active), target: '["Usages"]', pass: s1.active.length === 1 },
    { name: 'after a cursor move inside the same heading: highlight kept', value: JSON.stringify(s2.active), target: '["Usages"]', pass: s2.active.length === 1 },
    { name: 'after leaving and re-entering the heading: highlight back', value: JSON.stringify(s3.active), target: '["Usages"]', pass: s3.active.length === 1 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
