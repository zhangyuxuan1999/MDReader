import { launch, open, loadText, sleep, cursor, lineText } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');
for (const delay of [0, 16, 33, 50, 100, 200, 400, 1000]) {
  await loadText(page, 'A\n\nB\n\nC 目标段落\n\nD\n', 's.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(700);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: '新\n\n' } }); });
  if (delay) await sleep(delay);
  const t = await page.evaluate(() => { const e = [...document.querySelectorAll('.mdr-preview p')].find(p => p.textContent.includes('目标段落')); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height }; });
  if (!t) { console.log(`delay=${delay}ms -> target not in preview yet`); continue; }
  await page.keyboard.down('Alt'); await page.mouse.click(t.x + 6, t.y + t.h / 2); await page.keyboard.up('Alt');
  await sleep(500);
  const c = await cursor(page);
  const line = await lineText(page, c.line);
  console.log(`delay=${delay}ms -> cursor line ${c.line} = ${JSON.stringify(line)} ${line.includes('目标段落') ? 'OK' : 'WRONG'}`);
}
console.log('errors', errors);
await browser.close();
