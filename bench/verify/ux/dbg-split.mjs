// bench/verify/ux/dbg-split.mjs — state immediately after preview → split (button), sampled over 3 s.
import { launch, open, sleep, finish } from './lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');
const st = () => page.evaluate(() => {
  const c = document.querySelector('.cm-content'); const r = c.getBoundingClientRect();
  const ed = document.querySelector('.mdr-pane--editor').getBoundingClientRect();
  return { mode: document.querySelector('.mdr-app').dataset.mode, cm: [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(0)), pane: [ed.x, ed.width].map((n) => +n.toFixed(0)), dialog: !!document.querySelector('.mdr-dialog'), palette: !document.querySelector('.mdr-palette').hidden, overlayHit: (() => { const e = document.elementFromPoint(ed.x + 100, ed.y + 300); return e ? e.tagName + '.' + e.className.toString().slice(0, 40) : null; })() };
});
await page.mouse.move(500, 400); await page.mouse.wheel(0, 1500); await sleep(300); await page.mouse.wheel(0, -5000); await sleep(500);
await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]'); await sleep(400);
console.log('preview:', JSON.stringify(await st()));
await page.screenshot({ path: '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots/dbg-split-preview.png' });
await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
for (let i = 0; i < 6; i++) { console.log(`+${i * 500}ms:`, JSON.stringify(await st())); await sleep(500); }
let clicked = 'ok';
try { await page.click('.cm-content', { position: { x: 100, y: 300 }, timeout: 3000 }); } catch (e) { clicked = e.message.split('\n').slice(0, 12).join(' | '); }
console.log('click:', clicked);
const box = await page.locator('.cm-content').boundingBox();
console.log('boundingBox:', JSON.stringify(box), 'isVisible:', await page.locator('.cm-content').isVisible());
finish('dbg-split', errors);
await browser.close();
