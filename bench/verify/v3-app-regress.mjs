// bench/verify/v3-app-regress.mjs — verify-app (0.2.0 stage 2c), JOB 2: everyday preview gestures measured the
// same way on the candidate and on the 0.1.1 baseline renderer (variations beyond v2-app-regress.mjs: the
// clipboard after copy, triple click, drag past the pane edge, keyboard scrolling, links, context menu,
// heading click). Prints RESULT lines (values, not verdicts) for diffing.
// Candidate: MDR_PORT=5383 node bench/verify/v3-app-regress.mjs
// Candidate, 预览可编辑 off: MDR_EDIT=off MDR_PORT=5383 node bench/verify/v3-app-regress.mjs
// Baseline:  MDR_PERF=1 MDR_PORT=5393 node bench/verify/v3-app-regress.mjs   (vite preview of the 0.1.1 dist on 5393)
// Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page, context } = B;
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await context.addInitScript(() => {
  window.__opened = [];
  const o = window.open;
  window.open = function (...a) { window.__opened.push(String(a[0])); return null; };
  void o;
});
let popups = 0;
context.on('page', () => { popups++; });
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = ['# 标题一', '', '第一段落文字 alpha。', '', '第二段落文字 beta gamma delta。', '', '第三段落文字 gamma。', '', '- 列表项甲 word', '- 列表项乙', '',
  '```js', 'const x = 1;', '```', '', '[外部链接](https://example.com/x) 与 [锚点](#标题二)', '', ...Array.from({ length: 80 }, (_, i) => `填充段落 ${i} 一些文字。\n`), '## 标题二', '', '尾段文字。', ''].join('\n');
const textRect = (needle, from, to) => page.evaluate(({ needle, from, to }) => {
  const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + from); r.setEnd(n, i + to);
    const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, r: b.right };
  }
  return null;
}, { needle, from, to });
const probe = async (k, fn) => { if (only && !k.startsWith(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
const clip = () => page.evaluate(async () => {
  try {
    const items = await navigator.clipboard.read();
    const r = {};
    for (const it of items) for (const ty of it.types) r[ty] = await (await it.getType(ty)).text();
    const html = r['text/html'] ?? '';
    // compare the shape, not the inline styles Chromium adds
    const shape = html.replace(/<meta[^>]*>/g, '').replace(/\s(style|class|data-[\w-]+|dir)="[^"]*"/g, '').replace(/<\/?span>/g, '');
    return { plain: r['text/plain'] ?? null, html: shape.slice(0, 400), ce: /contenteditable/i.test(html), zw: /[\u200b\ufeff]/.test(r['text/plain'] ?? '') };
  } catch (e) { return `clip error ${e.message}`; }
});
const clearClip = () => page.evaluate(async () => { try { await navigator.clipboard.writeText('<empty>'); } catch { /* */ } });
const state = () => page.evaluate(() => ({
  session: !!document.querySelector('.mdr-preview .is-editing'),
  active: (document.activeElement?.tagName ?? '') + '.' + String(document.activeElement?.className ?? '').split(' ')[0],
}));

try {
  await B.boot('mode=split');
  if (process.env.MDR_EDIT === 'off') {
    await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
    await sleep(200);
    out('previewEdit', await page.evaluate(() => localStorage.getItem('mdr.previewEdit')));
  }
  const reset = async () => {
    await page.keyboard.press('Escape');
    await B.loadDoc(DOC);
    await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); window.__mdr.app.preview.scrollToLine(1, 0, 'instant'); });
    await sleep(700);   // the navigation anchor expires
    await clearClip();
  };

  await probe('C1 drag across 3 paragraphs + Cmd-C: clipboard', async () => {
    await reset();
    const a = await textRect('第一段落文字', 0, 1), b = await textRect('第三段落文字 gamma', 10, 11);
    await page.mouse.move(a.x + 1, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.r) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.r, b.y, { steps: 5 }); await page.mouse.up();
    await sleep(150);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ')), clip: await clip(), ...(await state()), src: (await B.source()) === DOC };
  });
  await probe('C2 drag inside one paragraph + Cmd-C: clipboard', async () => {
    await reset();
    const a = await textRect('第二段落文字 beta', 1, 2), b = await textRect('第二段落文字 beta', 10, 11);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.r, b.y, { steps: 6 }); await page.mouse.up();
    await sleep(150);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString()), clip: await clip(), ...(await state()), src: (await B.source()) === DOC };
  });
  await probe('C3 triple-click a paragraph + Cmd-C', async () => {
    await reset();
    const a = await textRect('第二段落文字 beta', 3, 4);
    await page.mouse.click(a.x, a.y, { clickCount: 1 }); await page.mouse.click(a.x, a.y, { clickCount: 2 }); await page.mouse.click(a.x, a.y, { clickCount: 3 });
    await sleep(150);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString()), clip: await clip(), ...(await state()) };
  });
  await probe('C4 double-click a word in a list item + Cmd-C', async () => {
    await reset();
    const a = await textRect('word', 1, 2);
    await page.mouse.dblclick(a.x, a.y); await sleep(150);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString()), clip: (await clip()).plain, ...(await state()) };
  });
  await probe('C5 double-click a word in the code block', async () => {
    await reset();
    const a = await textRect('const', 1, 2);
    await page.mouse.dblclick(a.x, a.y); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString()), ...(await state()) };
  });
  await probe('A1 click in the code block, Cmd-A twice: selection', async () => {
    await reset();
    const a = await textRect('const', 1, 2);
    await page.mouse.click(a.x, a.y); await sleep(150);
    await page.keyboard.press('ControlOrMeta+a'); await sleep(120);
    await page.keyboard.press('ControlOrMeta+a'); await sleep(150);
    return page.evaluate(() => { const x = getSelection().toString(); return { whole: x.includes('尾段文字'), len: x.length > 500 ? '>500' : x.length, session: !!document.querySelector('.mdr-preview .is-editing') }; });
  });
  await probe('C6 drag from heading into the code block + Cmd-C plain', async () => {
    await reset();
    const a = await textRect('标题一', 0, 1), b = await textRect('const', 3, 4);
    await page.mouse.move(a.x + 1, a.y); await page.mouse.down();
    await page.mouse.move(b.r, b.y, { steps: 8 }); await page.mouse.up(); await sleep(150);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ')), clip: (await clip()).plain?.replace(/\s+/g, ' '), ...(await state()) };
  });
  await probe('C7 drag past the bottom edge of the preview for 1.2 s: autoscroll + selection', async () => {
    await reset();
    const a = await textRect('第二段落文字', 0, 1);
    const box = await page.evaluate(() => { const r = window.__mdr.app.preview.el.getBoundingClientRect(); return { bottom: r.bottom, left: r.left, right: r.right }; });
    const top0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    await page.mouse.move(a.x + 1, a.y); await page.mouse.down();
    await page.mouse.move(a.x + 40, box.bottom - 5, { steps: 6 });
    await page.mouse.move(a.x + 40, box.bottom + 30, { steps: 4 });
    for (let i = 0; i < 12; i++) { await page.mouse.move(a.x + 40 + (i % 2), box.bottom + 30); await sleep(100); }
    await page.mouse.up(); await sleep(150);
    const top1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    const sel = await page.evaluate(() => getSelection().toString());
    return { scrolled: top1 - top0 > 50, selLen: sel.length > 60 ? '>60' : sel.length, selStart: sel.slice(0, 6), ...(await state()) };
  });
  await probe('K1 click a paragraph then PageDown ×2: preview scrolls, source unchanged', async () => {
    await reset();
    const a = await textRect('第一段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    const t0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    await page.keyboard.press('PageDown'); await sleep(250); await page.keyboard.press('PageDown'); await sleep(400);
    const t1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    return { scrolled: t1 - t0 > 200, src: (await B.source()) === DOC, ...(await state()) };
  });
  await probe('K2 click a paragraph then ArrowDown ×6: preview scroll delta, source unchanged', async () => {
    await reset();
    const a = await textRect('第一段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    const t0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); await sleep(60); }
    await sleep(300);
    const t1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    return { delta: Math.round(t1 - t0) > 0 ? '>0' : Math.round(t1 - t0), src: (await B.source()) === DOC, ...(await state()) };
  });
  await probe('K3 click a paragraph then Space: source unchanged?', async () => {
    await reset();
    const a = await textRect('第一段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    const t0 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    await page.keyboard.press(' '); await B.settle(300);
    const t1 = await page.evaluate(() => window.__mdr.app.preview.el.scrollTop);
    const s = await B.source();
    return { scrolled: t1 - t0 > 100, changedLine: s === DOC ? null : s.split('\n')[2], ...(await state()) };
  });
  await probe('K4 wheel over the preview after a click: editor follows (top line)', async () => {
    await reset();
    const a = await textRect('第一段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    await page.mouse.wheel(0, 1500); await sleep(800);
    return page.evaluate(() => ({ previewTop: window.__mdr.app.preview.topVisible().line > 20, editorTop: window.__mdr.app.editor.topVisible?.().line > 20 }));
  });
  await probe('L1 click an external link: window.open / popup / URL', async () => {
    await reset();
    await page.evaluate(() => { window.__opened = []; });
    const before = popups;
    await page.click('.mdr-preview a[href^="https://example.com"]'); await sleep(500);
    return { opened: await page.evaluate(() => window.__opened), popups: popups - before, url: page.url().replace(BASE, ''), src: (await B.source()) === DOC, ...(await state()) };
  });
  await probe('L2 click the #anchor link: preview top line, editor caret line', async () => {
    await reset();
    await page.click('.mdr-preview a[href^="#"]'); await sleep(1000);
    return page.evaluate(() => ({ top: window.__mdr.app.preview.topVisible().line, url: location.hash, session: !!document.querySelector('.mdr-preview .is-editing') }));
  });
  await probe('L3 click a heading: editor caret line, TOC active, tint', async () => {
    await reset();
    const a = await textRect('标题一', 1, 2);
    await page.mouse.click(a.x, a.y); await sleep(300);
    return page.evaluate(() => {
      const v = window.__mdr.app.editor.view;
      return { caretLine: v.state.doc.lineAt(v.state.selection.main.head).number, toc: document.querySelector('.mdr-toc [aria-current], .mdr-toc .is-active')?.textContent?.trim() ?? null, tint: document.querySelector('.mdr-preview .is-focus')?.textContent?.trim().slice(0, 8) ?? null, status: document.querySelector('.mdr-statusbar')?.textContent?.match(/行\s*\d+|Ln\s*\d+|\d+\s*:\s*\d+/)?.[0] ?? null };
    });
  });
  await probe('M1 right-click a paragraph: session? source unchanged', async () => {
    await reset();
    const a = await textRect('第二段落文字', 2, 3);
    await page.mouse.click(a.x, a.y, { button: 'right' }); await sleep(200);
    return { src: (await B.source()) === DOC, sel: await page.evaluate(() => getSelection().toString()), ...(await state()) };
  });
  await probe('F1 click a paragraph then Cmd-F: find panel?', async () => {
    await reset();
    const a = await textRect('第二段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    await page.keyboard.press('ControlOrMeta+f'); await sleep(400);
    return page.evaluate(() => ({ panel: !!document.querySelector('.cm-search, .cm-panel'), active: document.activeElement?.tagName + '.' + document.activeElement?.className, toast: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent).slice(-1)[0] ?? null }));
  });
  await probe('S1 select in one block (drag) then Esc then Cmd-C: clipboard', async () => {
    await reset();
    const a = await textRect('第三段落文字', 1, 2), b = await textRect('第三段落文字', 5, 6);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.r, b.y, { steps: 5 }); await page.mouse.up(); await sleep(150);
    await page.keyboard.press('Escape'); await sleep(200);
    await page.keyboard.press('ControlOrMeta+c'); await sleep(150);
    return { sel: await page.evaluate(() => getSelection().toString()), clip: (await clip()).plain, ...(await state()) };
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
