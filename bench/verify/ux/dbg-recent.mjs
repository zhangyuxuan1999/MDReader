// Debug: why does clicking a .mdr-recent__item time out under the FSA fake? Run: node bench/verify/ux/dbg-recent.mjs
import { launch, open, sleep } from './lib.mjs';
const { browser, context, page, errors } = await launch();
await context.addInitScript(() => {
  const st = { seq: 0, reg: {} };
  const F = (window.__fsa = { calls: [], writes: [], nextPick: null, st });
  const rec = (id) => st.reg[id];
  const def = (n, fn) => Object.defineProperty(Object.prototype, n, { value: fn, enumerable: false, configurable: true, writable: true });
  def('queryPermission', async function () { return 'granted'; });
  def('requestPermission', async function () { return 'granted'; });
  def('getFile', async function () { const r = rec(this.__fsaId); F.calls.push(['getFile', this.__fsaId]); return new File([r.text], r.name, { type: 'text/markdown', lastModified: r.mtime }); });
  def('isSameEntry', async function (o) { return !!o && o.__fsaId === this.__fsaId; });
  const mk = (id) => ({ __fsaId: id, kind: 'file', name: rec(id).name });
  F.add = (name, text) => { const id = ++st.seq; st.reg[id] = { name, text, mtime: Date.now() - 100000 }; return id; };
  window.showOpenFilePicker = async () => [mk(F.nextPick)];
  window.showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError'); };
});
await open(page, '?mode=split');
await page.evaluate(() => { window.__fsa.nextPick = window.__fsa.add('alpha.md', 'alpha body\n'); });
await page.click('.cm-content');
await page.keyboard.press('Meta+o');
await page.waitForFunction(() => window.__mdr.app.getText().includes('alpha body'));
await page.evaluate(() => { window.__fsa.nextPick = window.__fsa.add('beta.md', 'beta body\n'); });
await page.keyboard.press('Meta+o');
await page.waitForFunction(() => window.__mdr.app.getText().includes('beta body'));
await sleep(200);
await page.click('.mdr-toolbar__file');
await page.waitForSelector('.mdr-recent');
await sleep(200);
console.log(await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((li) => { const r = li.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { text: li.textContent, box: [r.left, r.top, r.width, r.height].map((n) => n.toFixed(0)), hit: at === li ? 'self' : at?.className || at?.tagName, display: getComputedStyle(li).display, vis: getComputedStyle(li).visibility, pe: getComputedStyle(li).pointerEvents }; })));
console.log('ul style', await page.evaluate(() => { const u = document.querySelector('.mdr-recent'); const cs = getComputedStyle(u); return { pos: cs.position, z: cs.zIndex, top: cs.top, right: cs.right, w: cs.width, h: cs.height, overflow: cs.overflow, hostOverflow: getComputedStyle(u.parentElement).overflow, tbOverflow: getComputedStyle(document.querySelector('.mdr-toolbar')).overflow }; }));
await page.screenshot({ path: '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots/dbg-recent.png' });
try {
  await page.click('.mdr-recent__item:has-text("alpha.md")', { timeout: 3000 });
  await sleep(300);
  console.log('after click text =', JSON.stringify((await page.evaluate(() => window.__mdr.app.getText())).slice(0, 20)), 'calls', await page.evaluate(() => window.__fsa.calls));
} catch (e) { console.log('CLICK ERROR:', e.message.split('\n').slice(0, 8).join(' | ')); }
// try a raw mouse click at the item's centre
const box = await page.evaluate(() => { const li = [...document.querySelectorAll('.mdr-recent li')].find((l) => l.textContent === 'alpha.md'); if (!li) return null; const r = li.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
console.log('box', box);
if (box) { await page.mouse.click(box[0], box[1]); await sleep(400); console.log('after raw click text =', JSON.stringify((await page.evaluate(() => window.__mdr.app.getText())).slice(0, 20)), 'menu open', await page.evaluate(() => !!document.querySelector('.mdr-recent'))); }
console.log('errors', errors);
await browser.close();
