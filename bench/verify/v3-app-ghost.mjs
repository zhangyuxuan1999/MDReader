// bench/verify/v3-app-ghost.mjs — verify-app (0.2.0 stage 2c): the emptied-block placeholder (ghost) and the
// edit hold (createPreview held(id) / evict / window request) against scrolling far away in a long document:
// empty a block, scroll the preview to the end (its chunk leaves the window), then type / Esc / ⌘Z, scroll back,
// and compare the source and what the preview shows around that place.
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-ghost.mjs [case-prefix]
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const t = (name, fn) => (only && !name.startsWith(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
const { page } = B;
const N = 900;
const DOC = Array.from({ length: N }, (_, i) => `段落 p${i} 的文字内容。`).join('\n\n') + '\n';
const lineOf = (i) => 2 * i + 1;
async function emptyP(i) {
  await B.clickLine(lineOf(i), 'first', `p${i}`);
  assert(await B.editing(), 'no session');
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el.querySelector('p'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  await B.settle(200);
}
const farAway = async () => {
  await page.evaluate(() => { const el = window.__mdr.app.preview.el; el.scrollTop = el.scrollHeight; });
  await sleep(500);
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 4000); await sleep(400);
  await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
};
const back = async () => {
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0, 'instant'));
  await sleep(800);
  await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
};
const around = () => page.evaluate(() => {
  const secs = [...document.querySelectorAll('.mdr-preview section.md-block')].filter((e) => e.getBoundingClientRect().height >= 0);
  const top = secs.slice(0, 12).map((e) => (e.closest('.md-ghost-holder') ? 'GHOST:' : '') + (e.textContent.trim() || '∅') + (e.classList.contains('is-editing') ? '*' : ''));
  const box = window.__mdr.app.preview.el.getBoundingClientRect();
  const vis = secs.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
  return { top, ghosts: document.querySelectorAll('.md-ghost-holder').length, empties: vis.filter((e) => !e.textContent.trim()).length, visible: vis.length };
});

try {
  await B.boot('mode=split');
  await t('GH1 empty p3, scroll to the end, type N (focus still in the placeholder), scroll back: N where p3 was', async () => {
    await B.loadDoc(DOC);
    await emptyP(3);
    await farAway();
    const ed = await B.editing();
    const act = await page.evaluate(() => document.activeElement?.tagName + '.' + String(document.activeElement?.className).split(' ')[0]);
    await page.keyboard.type('N');
    await B.settle(500);
    const s = await B.source();
    await back();
    const a = await around();
    await B.esc();
    const want = DOC.replace('段落 p3 的文字内容。', 'N');
    assert(s === want, `source ${JSON.stringify(s.slice(0, 120))} (session ${!!ed}, active ${act})`);
    assert(a.top[3] && a.top[3].startsWith('N'), `screen ${JSON.stringify(a)}`);
    return JSON.stringify(a.top.slice(0, 6));
  });
  await t('GH2 empty p3, scroll to the end, Esc, scroll back: no leftover empty wrapper, p2 then p4', async () => {
    await B.loadDoc(DOC);
    await emptyP(3);
    await farAway();
    await page.keyboard.press('Escape'); await B.settle(300);
    await back();
    const a = await around();
    const s = await B.source();
    assert(s === DOC.replace('段落 p3 的文字内容。\n\n', ''), `source ${JSON.stringify(s.slice(0, 120))}`);
    assert(a.empties === 0 && a.ghosts === 0, `leftover: ${JSON.stringify(a)}`);
    assert(a.top[2].includes('p2') && a.top[3].includes('p4'), `screen ${JSON.stringify(a.top)}`);
  });
  await t('GH3 empty p3, scroll to the end, click p890 and type Q, scroll back: Q in p890, p3 gone, no leftover', async () => {
    await B.loadDoc(DOC);
    await emptyP(3);
    await farAway();
    const s0 = await B.source();
    const line = s0.split('\n').findIndex((l) => l.includes('p890 ')) + 1;
    await B.clickLine(line, 'first', 'p890');
    await B.caretAt('p890');
    await page.keyboard.type('Q');
    await B.settle(400);
    await B.esc();
    await back();
    const a = await around();
    const s = await B.source();
    assert(s === DOC.replace('段落 p3 的文字内容。\n\n', '').replace('p890', 'p890Q'), `source near: ${JSON.stringify(s.split('\n').filter((l) => /p3 |p890/.test(l)))}`);
    assert(a.empties === 0 && a.ghosts === 0, `leftover: ${JSON.stringify(a)}`);
  });
  await t('GH4 empty p3, scroll to the end, ⌘Z: p3 back (source and screen after scrolling back)', async () => {
    await B.loadDoc(DOC);
    await emptyP(3);
    await farAway();
    await page.keyboard.press('Meta+z');
    await B.settle(800);
    await sleep(1500);
    const s = await B.source();
    await back();
    const a = await around();
    await page.keyboard.press('Escape');
    assert(s === DOC, `source ${JSON.stringify(s.slice(0, 120))}`);
    assert(a.top[3] && a.top[3].includes('p3'), `screen ${JSON.stringify(a)}`);
    assert(a.empties === 0, `leftover ${JSON.stringify(a)}`);
  });
  await t('GH5 empty p0 (first block), scroll away, type N, back: N first', async () => {
    await B.loadDoc(DOC);
    await emptyP(0);
    await farAway();
    await page.keyboard.type('N');
    await B.settle(500);
    const s = await B.source();
    await back();
    const a = await around();
    await B.esc();
    assert(s === DOC.replace('段落 p0 的文字内容。', 'N'), `source ${JSON.stringify(s.slice(0, 80))}`);
    assert(a.top[0].startsWith('N'), `screen ${JSON.stringify(a.top.slice(0, 4))}`);
  });
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
