import { launch, open, loadText, step, expect, finish, sleep, getFailures, focusEditor, placeCursor } from '../ux/lib.mjs';
const BASE = (process.env.MDR_UX_BASE ?? 'http://localhost:5203').replace(/\/?$/, '/');
const { browser, page, errors } = await launch();
page.setDefaultTimeout(12000);
await open(page, '?mode=split');
await loadText(page, '# A\n\nx\n\n## B\n\ny\n', 'n.md');

await step('narrow-width TOC toggle silently flips the persisted preference', async () => {
  await page.setViewportSize({ width: 820, height: 800 });
  await sleep(400);
  const before = await page.evaluate(() => ({ ls: localStorage.getItem('mdr.toc'), attr: document.querySelector('.mdr-app').dataset.toc }));
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');   // nothing visible happens here
  await sleep(400);
  const mid = await page.evaluate(() => ({ ls: localStorage.getItem('mdr.toc'), attr: document.querySelector('.mdr-app').dataset.toc,
    paneW: Math.round(document.querySelector('.mdr-pane--toc').getBoundingClientRect().width) }));
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(500);
  const after = await page.evaluate(() => ({ ls: localStorage.getItem('mdr.toc'), attr: document.querySelector('.mdr-app').dataset.toc,
    paneW: Math.round(document.querySelector('.mdr-pane--toc').getBoundingClientRect().width) }));
  expect(!(before.ls === 'open' && mid.paneW === 0 && after.paneW === 0),
    `at 820px the toggle is a no-op on screen (pane stays ${mid.paneW}px) but still writes mdr.toc=${mid.ls}; back at 1400px the TOC is now gone (${after.paneW}px) although the user never saw the control do anything. before=${JSON.stringify(before)} mid=${JSON.stringify(mid)} after=${JSON.stringify(after)}`);
  return JSON.stringify({ before, mid, after });
});
await page.evaluate(() => localStorage.setItem('mdr.toc', 'open'));
await page.reload(); await page.waitForFunction(() => !!window.__mdr); await sleep(500);

await step('empty document status bar', async () => {
  await loadText(page, '', 'empty.md');
  await sleep(500);
  const s = await page.evaluate(() => [...document.querySelectorAll('.mdr-statusbar__item')].map(e => ({ stat: e.dataset.stat, txt: e.textContent, hidden: e.hidden })));
  return JSON.stringify(s);
});
await step('mode switch keeps the reading position', async () => {
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/medium.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  await page.evaluate(() => window.__mdr.app.editor.scrollToLine(5000, 0));
  await sleep(600);
  const a = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible(), p: window.__mdr.app.preview.topVisible() }));
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(700);
  const b = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  await page.evaluate(() => window.__mdr.mode('edit'));
  await sleep(700);
  const c = await page.evaluate(() => window.__mdr.app.editor.topVisible());
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(700);
  const d = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible(), p: window.__mdr.app.preview.topVisible() }));
  expect(Math.abs(b.line - a.e.line) <= 5, `split->preview lost position: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  expect(Math.abs(c.line - b.line) <= 5, `preview->edit lost position: ${JSON.stringify(b)} -> ${JSON.stringify(c)}`);
  expect(Math.abs(d.p.line - d.e.line) <= 5, `split panes out of sync: ${JSON.stringify(d)}`);
  return JSON.stringify({ a, b, c, d });
});
await step('view.mountAll materialises the whole document', async () => {
  await loadText(page, Array.from({length: 400}, (_, i) => `## 标题 ${i+1}\n\n段落 ${i+1} 内容。\n`).join('\n'), 'm.md');
  const before = await page.evaluate(() => document.querySelectorAll('.md-block:not(.is-pending)').length);
  const total = await page.evaluate(() => document.querySelectorAll('.md-block').length);
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(2500);
  const after = await page.evaluate(() => document.querySelectorAll('.md-block:not(.is-pending)').length);
  expect(after > before && after >= total * 0.95, `mounted ${before} -> ${after} of ${total}`);
  return `${before} -> ${after} of ${total}`;
});
await step('beforeunload guard fires when dirty', async () => {
  await loadText(page, '# 脏文档\n\n内容\n', 'd.md');
  await focusEditor(page); await placeCursor(page, 3, 0);
  await page.keyboard.type('改');
  await sleep(500);
  const returned = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    let rv; Object.defineProperty(e, 'returnValue', { get: () => rv, set: (v) => { rv = v; }, configurable: true });
    window.dispatchEvent(e);
    return { prevented: e.defaultPrevented, returnValue: rv };
  });
  expect(returned.prevented || returned.returnValue, `beforeunload not guarded: ${JSON.stringify(returned)}`);
  return JSON.stringify(returned);
});
await step('toast auto-dismisses / can be dismissed', async () => {
  await page.evaluate(() => window.__mdr.app.bus.emit('toast', { text: '测试提示', timeoutMs: 800 }));
  await sleep(200);
  const n1 = await page.locator('.mdr-toast').count();
  await sleep(1600);
  const n2 = await page.locator('.mdr-toast').count();
  expect(n1 > 0, 'toast did not show');
  expect(n2 === 0, `toast did not auto-dismiss (${n2} left)`);
});
await step('?doc= loads a document from a URL', async () => {
  await page.goto(BASE + '?doc=/test-data/small.md&mode=split');
  await page.waitForFunction(() => !!window.__mdr);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(400);
  const n = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  const title = await page.title();
  expect(n > 100, `lineCount=${n}`);
  return `${n} lines, title=${title}`;
});
await step('?perf=1 overlay renders', async () => {
  await page.goto(BASE + '?doc=/test-data/small.md&mode=split&perf=1');
  await page.waitForFunction(() => !!window.__mdr);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const o = await page.evaluate(() => {
    const e = document.querySelector('.mdr-perf, [class*=perf]');
    if (!e) return null; const r = e.getBoundingClientRect();
    return { cls: e.className, txt: e.textContent.slice(0, 200), w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(o, 'no ?perf=1 overlay found');
  return JSON.stringify(o);
});

finish('13-gaps', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
