// bench/verify/ux/14-top-sync-progress.mjs — (a) does syncing from the editor at line 1 scroll the
// preview past its top padding (heading flush under the toolbar)?  (b) preview-mode switch at the top;
// (c) progress indicator trace on large.md; (d) mixed task/plain list bullets; (e) binary / non-md drop.
// Run: node bench/verify/ux/14-top-sync-progress.mjs
import { launch, open, loadText, getText, step, expect, check, measure, finish, sleep, statusText, getFailures } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');

const pvState = () => page.evaluate(() => {
  const sc = document.querySelector('.mdr-preview');
  const body = document.querySelector('.mdr-preview__body');
  const h1 = sc.querySelector('h1');
  const sr = sc.getBoundingClientRect();
  return {
    scrollTop: sc.scrollTop,
    bodyPadTop: getComputedStyle(body).paddingTop,
    h1Top: h1 ? +(h1.getBoundingClientRect().top - sr.top).toFixed(1) : null,
    edTop: window.__mdr.app.editor.topVisible(),
    pvTop: window.__mdr.app.preview.topVisible(),
    l1: window.__mdr.app.preview.lineToScrollTop(1, 0),
  };
});

await step('Fresh load: preview shows its top padding (baseline)', async () => {
  const s = await pvState();
  return JSON.stringify(s);
});
await step('Wheel down then back to the very top of the editor: preview returns to scrollTop 0 (padding visible)', async () => {
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, 1500);
  await sleep(300);
  await page.mouse.wheel(0, -5000);
  await sleep(500);
  const s = await pvState();
  await page.screenshot({ path: `${OUT}/top-after-sync.png` });
  expect(s.edTop.line === 1, `editor not at top: ${JSON.stringify(s.edTop)}`);
  expect(s.scrollTop <= 1, `preview scrollTop ${s.scrollTop} after editor returned to line 1 (h1 offset ${s.h1Top}px, body padding ${s.bodyPadTop}, lineToScrollTop(1,0)=${s.l1})`);
  return JSON.stringify(s);
});
await step('Switch split → preview while at the top: preview starts at scrollTop 0', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(400);
  const s = await pvState();
  await page.screenshot({ path: `${OUT}/preview-mode-top.png` });
  expect(s.scrollTop <= 1, `preview scrollTop ${s.scrollTop} in preview mode (h1 offset ${s.h1Top}px)`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  return JSON.stringify(s);
});
await step('Keyboard: Mod-Home in the editor → preview at top', async () => {
  await page.click('.cm-content', { position: { x: 100, y: 300 } });
  await page.keyboard.press('Meta+End');
  await sleep(400);
  await page.keyboard.press('Meta+Home');
  await sleep(500);
  const s = await pvState();
  // Mod-Home leaves CodeMirror itself a fraction of a line from the very top (topVisible reports
  // line 1 / fraction ≈ 0.025), and the preview's first `bodyTop` px ramp doubles that offset. The
  // invariant is that the article's top padding is still visible — the fresh-load look — not an exact 0.
  expect(s.scrollTop <= 4 && s.h1Top >= 28, `preview scrollTop ${s.scrollTop} after Mod-Home (h1 offset ${s.h1Top}px)`);
  return JSON.stringify(s);
});

// ---------------------------------------------------------------- progress trace
await step('Progress indicator trace on large.md (values seen while visible)', async () => {
  await page.evaluate(() => {
    window.__prog = [];
    const el = document.querySelector('[data-stat="progress"]');
    new MutationObserver(() => window.__prog.push({ t: performance.now(), hidden: el.hidden, text: el.textContent })).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  const t0 = Date.now();
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  const dt = Date.now() - t0;
  const log = await page.evaluate(() => window.__prog);
  const values = log.filter((e) => !e.hidden).map((e) => Number(/(\d+)%/.exec(e.text)?.[1] ?? -1));
  const max = Math.max(-1, ...values);
  measure('progress indicator max % (large.md, 6002 blocks)', max, '≥ 90 before hiding (spec: 渲染中 37%)', max >= 90);
  return `load→idle ${dt} ms; ${log.length} mutations; visible values: ${[...new Set(values)].join(',')}`;
});

// ---------------------------------------------------------------- mixed list bullets
await loadText(page, '- 普通项一\n- 普通项二\n- [ ] 任务项\n- [x] 完成项\n', 'mixed.md');
await step('Plain items in a list that also contains task items keep their bullets', async () => {
  const r = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview li')].map((li) => ({ text: li.textContent.trim(), task: li.classList.contains('task-list-item'), listStyle: getComputedStyle(li).listStyleType, marker: getComputedStyle(li, '::marker').content })));
  await page.screenshot({ path: `${OUT}/mixed-list.png`, clip: { x: 820, y: 44, width: 580, height: 220 } });
  const bad = r.filter((x) => !x.task && x.listStyle === 'none');
  expect(bad.length === 0, `plain items without bullet: ${JSON.stringify(bad)}`);
  return JSON.stringify(r);
});

// ---------------------------------------------------------------- binary drop
await step('Dropping a .png replaces the document with binary garbage and no feedback', async () => {
  await loadText(page, '# 原文档\n', 'orig.md');
  await page.evaluate(() => {
    const app = document.querySelector('.mdr-app');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2])], 'pic.png', { type: 'image/png' }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(500);
  const txt = await getText(page);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
  const title = await page.title();
  expect(txt === '# 原文档\n' || toasts.length > 0, `text now ${JSON.stringify(txt)}, title "${title}", toasts ${JSON.stringify(toasts)}`);
  return `text ${JSON.stringify(txt)} title ${title}`;
});

// ---------------------------------------------------------------- toasts dedupe
await loadText(page, '[相对](./a.md) 文本\n', 'toast.md');
await step('Clicking a relative link 5× stacks 5 identical toasts', async () => {
  for (let i = 0; i < 5; i++) { await page.locator('.mdr-preview a').click(); await sleep(60); }
  // Count only the toasts for THIS action: earlier steps leave unrelated ones on screen (the binary-drop
  // error toast runs for 8 s), and the invariant under test is that identical toasts coalesce.
  const texts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent ?? ''));
  const n = texts.filter((t) => t.startsWith('暂不支持打开相对链接')).length;
  await page.screenshot({ path: `${OUT}/toast-stack.png` });
  expect(n <= 2, `${n} identical toasts visible (all: ${JSON.stringify(texts)})`);
});

finish('14-top-sync-progress', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
