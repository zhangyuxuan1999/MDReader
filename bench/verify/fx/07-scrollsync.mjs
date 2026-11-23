import { launch, open, step, expect, measure, finish, sleep, getFailures, placeCursor, focusEditor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(15000);
await open(page, '?doc=/test-data/medium.md&mode=split');
await sleep(800);

const lineCount = await page.evaluate(() => window.__mdr.app.editor.lineCount());
console.log('lineCount', lineCount);

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

async function sample(dir, n) {
  const errsLine = [], errsFrac = [], errsBlock = [];
  for (let i = 0; i < n; i++) {
    const line = 2 + Math.floor(rnd() * (lineCount - 4));
    if (dir === 'editor') {
      await page.evaluate((l) => { const v = window.__mdr.app.editor.view; window.__mdr.app.editor.scrollToLine(l, 0); v.scrollDOM.dispatchEvent(new WheelEvent('wheel', {bubbles:true})); }, line);
    } else {
      await page.evaluate((l) => { const p = window.__mdr.app.preview; p.el.dispatchEvent(new WheelEvent('wheel', {bubbles:true})); p.scrollToLine(l, 0, 'instant'); }, line);
    }
    await sleep(220);
    const r = await page.evaluate(() => {
      const e = window.__mdr.app.editor.topVisible();
      const p = window.__mdr.app.preview.topVisible();
      const be = window.__mdr.app.preview.blockAtLine(e.line);
      const bp = window.__mdr.app.preview.blockAtLine(p.line);
      return { e, p, bi: be.index, pi: bp.index };
    });
    errsLine.push(Math.abs(r.e.line - r.p.line));
    errsFrac.push(Math.abs((r.e.line + (r.e.fraction ?? 0)) - (r.p.line + (r.p.fraction ?? 0))));
    errsBlock.push(Math.abs(r.bi - r.pi));
  }
  return { errsLine, errsFrac, errsBlock };
}

const pct = (a, q) => { const s = [...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(q*s.length))]; };

await step('scroll sync: editor → preview (20 random positions)', async () => {
  const { errsLine, errsFrac, errsBlock } = await sample('editor', 20);
  const maxB = Math.max(...errsBlock), maxF = Math.max(...errsFrac), maxL = Math.max(...errsLine);
  measure('sync-e2p block error max', maxB, '<= 1', maxB <= 1);
  measure('sync-e2p position error (lines) max', maxF.toFixed(3), '< 0.25', maxF < 0.25);
  measure('sync-e2p line error p90', pct(errsLine, 0.9), 'informational', true);
  expect(maxB <= 1, `block errors=${JSON.stringify(errsBlock)} lineErrors=${JSON.stringify(errsLine)}`);
  return `maxBlock=${maxB} maxFrac=${maxF.toFixed(3)} maxLine=${maxL}`;
});
await step('scroll sync: preview → editor (20 random positions)', async () => {
  const { errsLine, errsFrac, errsBlock } = await sample('preview', 20);
  const maxB = Math.max(...errsBlock), maxF = Math.max(...errsFrac), maxL = Math.max(...errsLine);
  measure('sync-p2e block error max', maxB, '<= 1', maxB <= 1);
  measure('sync-p2e position error (lines) max', maxF.toFixed(3), '< 0.25', maxF < 0.25);
  expect(maxB <= 1, `block errors=${JSON.stringify(errsBlock)} lineErrors=${JSON.stringify(errsLine)}`);
  return `maxBlock=${maxB} maxFrac=${maxF.toFixed(3)} maxLine=${maxL}`;
});
await step('real wheel on the preview moves the editor', async () => {
  await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(500, 0, 'instant'); window.__mdr.app.editor.scrollToLine(500, 0); });
  await sleep(400);
  const before = await page.evaluate(() => window.__mdr.app.editor.topVisible().line);
  const box = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 300); await sleep(60); }
  await sleep(500);
  const after = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible(), p: window.__mdr.app.preview.topVisible() }));
  expect(after.e.line > before, `editor did not follow: before=${before} after=${JSON.stringify(after)}`);
  expect(Math.abs(after.e.line - after.p.line) <= 3, `panes diverged: ${JSON.stringify(after)}`);
  return `before=${before} after=${JSON.stringify(after)}`;
});
await step('real wheel on the editor moves the preview', async () => {
  const box = await page.locator('.cm-scroller').boundingBox();
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  const before = await page.evaluate(() => window.__mdr.app.preview.topVisible().line);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 300); await sleep(60); }
  await sleep(500);
  const after = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible(), p: window.__mdr.app.preview.topVisible() }));
  expect(after.p.line > before, `preview did not follow: before=${before} after=${JSON.stringify(after)}`);
  expect(Math.abs(after.e.line - after.p.line) <= 3, `panes diverged: ${JSON.stringify(after)}`);
  return `before=${before} after=${JSON.stringify(after)}`;
});
await step('sync is disabled outside split mode', async () => {
  await page.evaluate(() => window.__mdr.mode('edit'));
  await sleep(300);
  await page.evaluate(() => window.__mdr.app.editor.scrollToLine(3000, 0));
  await sleep(400);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(600);
  const r = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible(), p: window.__mdr.app.preview.topVisible() }));
  expect(Math.abs(r.e.line - r.p.line) <= 3, `after returning to split the panes are out of sync: ${JSON.stringify(r)}`);
  return JSON.stringify(r);
});
await step('typing off-screen scrolls the preview to the cursor', async () => {
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(2000); });
  await sleep(500);
  await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(20, 0, 'instant'); });
  await sleep(400);
  const before = await page.evaluate(() => window.__mdr.app.preview.topVisible().line);
  await focusEditor(page);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(2000); });
  await sleep(200);
  await page.keyboard.type('XYZ');
  await sleep(1200);
  const after = await page.evaluate(() => ({ p: window.__mdr.app.preview.topVisible(), vis: window.__mdr.app.preview.isLineVisible(2000) }));
  expect(after.vis, `cursor line 2000 not visible in the preview after typing (before top=${before}, after=${JSON.stringify(after)})`);
  return `before=${before} after=${JSON.stringify(after)}`;
});

finish('07-scrollsync', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
