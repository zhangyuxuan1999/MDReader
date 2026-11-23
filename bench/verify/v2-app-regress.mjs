// bench/verify/v2-app-regress.mjs — verify-app (0.2.0 stage 2a), JOB 2: everyday preview behaviour measured
// the same way on the candidate and on the 0.1.1 baseline renderer. Prints one RESULT line per probe (the
// value, not a verdict) so the two runs can be diffed.
// Candidate: MDR_BASE_URL=http://localhost:5283 node bench/verify/v2-app-regress.mjs
// Baseline:  npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5293 --strictPort &
//            MDR_PERF=1 MDR_BASE_URL=http://localhost:5293 node bench/verify/v2-app-regress.mjs
// Optional: MDR_EDIT=off → switch 预览可编辑 off first (candidate only; the baseline has no such toggle).
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 105_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = ['# 标题一', '', '第一段落文字 alpha。', '', '第二段落文字 beta。', '', '第三段落文字 gamma。', '', '- [ ] 任务一', '- [ ] 任务二', '',
  '```js', 'const x = 1;', '```', '', '[跳到标题二](#标题二)', '', ...Array.from({ length: 80 }, (_, i) => `填充段落 ${i}。\n`), '## 标题二', '', '尾段文字。', ''].join('\n');
const L = (needle) => DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
const textRect = (needle, from, to) => page.evaluate(({ needle, from, to }) => {
  const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + from); r.setEnd(n, i + to);
    const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, r: b.right };
  }
  return null;
}, { needle, from, to });
const probe = async (k, fn) => { try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };

try {
  await B.boot('mode=split');
  if (process.env.MDR_EDIT === 'off') {
    await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
    await sleep(200);
    out('previewEdit', await page.evaluate(() => localStorage.getItem('mdr.previewEdit')));
  }
  const reset = async () => { await B.loadDoc(DOC); await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); }); };

  await probe('drag-select across three paragraphs (selection text)', async () => {
    await reset();
    await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0, 'instant')); await sleep(300);
    const a = await textRect('第一段落文字', 0, 1), b = await textRect('第三段落文字 gamma', 10, 11);
    await page.mouse.move(a.x + 1, a.y); await page.mouse.down();
    await page.mouse.move((a.x + b.r) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.r, b.y, { steps: 5 }); await page.mouse.up();
    await sleep(150);
    return page.evaluate(() => getSelection().toString().replace(/\s+/g, ' '));
  });
  await probe('shift+click extends selection to another paragraph', async () => {
    await reset();
    const a = await textRect('第一段落文字', 0, 1), b = await textRect('第二段落文字 beta', 6, 7);
    await page.mouse.click(a.x + 1, a.y); await sleep(80);
    await page.mouse.click(b.r, b.y, { modifiers: ['Shift'] }); await sleep(150);
    return page.evaluate(() => getSelection().toString().replace(/\s+/g, ' '));
  });
  // Lead decision U7 (stage 2): inside a session ⌘A first selects the block's content, ⌘A again selects the
  // whole preview; pressed twice here (outside a session — the baseline — the second press changes nothing).
  await probe('Cmd-A twice after a click in the preview (selection length)', async () => {
    await reset();
    const a = await textRect('第二段落文字', 1, 2);
    await page.mouse.click(a.x, a.y); await sleep(80);
    await page.keyboard.press('ControlOrMeta+a'); await sleep(100);
    await page.keyboard.press('ControlOrMeta+a'); await sleep(100);
    const s = await page.evaluate(() => getSelection().toString());
    return { len: s.length, hasFirst: s.includes('第一段落'), hasThird: s.includes('第三段落') };
  });
  await probe('double-click selects a word', async () => {
    await reset();
    const a = await textRect('alpha', 1, 2);
    await page.mouse.dblclick(a.x, a.y); await sleep(120);
    return page.evaluate(() => getSelection().toString());
  });
  await probe('click in preview: source unchanged, editor caret line, tint line', async () => {
    await reset();
    const before = await B.source();
    const a = await textRect('第三段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(200);
    const s = await B.source();
    return await page.evaluate((same) => {
      const v = window.__mdr.app.editor.view; const head = v.state.selection.main.head;
      const tint = document.querySelector('.mdr-preview .is-focus');
      return { same, editorLine: v.state.doc.lineAt(head).number, tintText: tint ? tint.textContent.trim().slice(0, 12) : null, peer: !!document.querySelector('.cm-line[class*="peer"], .mdr-peer-line, .cm-peerLine') };
    }, s === before);
  });
  await probe('task checkbox click toggles the source', async () => {
    await reset();
    await page.click('.mdr-preview li:nth-child(2) input[type="checkbox"]'); await B.settle(300);
    return (await B.source()).split('\n').filter((l) => l.includes('任务'));
  });
  await probe('anchor link click scrolls preview to 标题二 (top line)', async () => {
    await reset();
    await page.click('.mdr-preview a[href="#标题二"], .mdr-preview a[href*="%E6%A0%87"]'); await sleep(900);
    return page.evaluate(() => window.__mdr.app.preview.topVisible().line);
  });
  await probe('code copy button present / click shows copied', async () => {
    await reset();
    await sleep(300);
    const btn = await page.$('.mdr-preview .md-code__copy, .mdr-preview button[class*="copy"]');
    if (!btn) return 'no button';
    await btn.click(); await sleep(200);
    return page.evaluate(() => { const b = document.querySelector('.mdr-preview .md-code__copy, .mdr-preview button[class*="copy"]'); return { text: b.textContent, label: b.getAttribute('aria-label'), cls: b.className }; });
  });
  await probe('Alt+click in preview moves the editor caret to that line', async () => {
    await reset();
    const a = await textRect('第二段落文字', 1, 2);
    await page.mouse.click(a.x, a.y, { modifiers: ['Alt'] }); await sleep(300);
    return page.evaluate(() => { const v = window.__mdr.app.editor.view; return { line: v.state.doc.lineAt(v.state.selection.main.head).number, focus: v.hasFocus }; });
  });
  await probe('typing in the editor far below → preview follows, tint on that line', async () => {
    await reset();
    await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(l).to }, scrollIntoView: true }); }, L('尾段文字'));
    await sleep(300);
    await page.keyboard.type('ZZ'); await B.settle(500);
    return page.evaluate((l) => ({ visible: window.__mdr.app.preview.isLineVisible(l), tint: document.querySelector('.mdr-preview .is-focus')?.textContent.trim() ?? null }), L('尾段文字'));
  });
  await probe('Cmd-Z in preview after clicking a paragraph (no typing) → source changes?', async () => {
    await reset();
    await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(l).to } }); }, L('第一段落'));
    await page.keyboard.type('Q'); await B.settle(300);
    const a = await textRect('第三段落文字', 2, 3);
    await page.mouse.click(a.x, a.y); await sleep(150);
    await page.keyboard.press('ControlOrMeta+z'); await B.settle(300);
    return (await B.source()).split('\n')[2];
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
