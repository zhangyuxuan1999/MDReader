import { launch, open, loadText, placeCursor, cursor, sleep } from './lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?mode=split');
await loadText(page, '# 标题一\n\n普通段落 hello world\n\n- 列表项 A\n- 列表项 B\n', 'k.md');
await placeCursor(page, 3, 0);
await page.evaluate(() => {
  window.__keys = [];
  window.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, code: e.code, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, prevented: e.defaultPrevented }), true);
});
await page.keyboard.press('Meta+Alt+g');
await sleep(200);
console.log('keys', JSON.stringify(await page.evaluate(() => window.__keys)));
console.log('panels', await page.evaluate(() => [...document.querySelectorAll('.cm-panel')].map((p) => p.className + ' :: ' + p.innerText.replace(/\s+/g, ' '))));
// try via palette command
await page.keyboard.press('Escape');
await page.evaluate(() => window.__mdr.app.registry.run('edit.gotoLine'));
await sleep(200);
console.log('panels after registry.run', await page.evaluate(() => [...document.querySelectorAll('.cm-panel')].map((p) => p.className + ' :: ' + p.innerText.replace(/\s+/g, ' '))));
await page.keyboard.press('Escape');
// search enter
await page.keyboard.press('Meta+f');
await page.waitForSelector('.cm-search');
console.log('active after Mod-f', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
await page.keyboard.type('列表项');
await sleep(50);
console.log('active after type', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
await page.keyboard.press('Enter');
await sleep(50);
console.log('cursor after Enter', JSON.stringify(await cursor(page)));
await page.keyboard.press('Enter');
await sleep(50);
console.log('cursor after Enter2', JSON.stringify(await cursor(page)));
console.log('search field value', await page.evaluate(() => document.querySelector('.cm-search input[name=search]').value));
console.log(errors);
await browser.close();
