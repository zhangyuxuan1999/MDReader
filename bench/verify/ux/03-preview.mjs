// bench/verify/ux/03-preview.mjs — preview interactions (checkbox, Alt+click, anchors, external/relative
// links), scroll sync both directions (20 random positions), cursor-follow, progress indicator.
// Run: node bench/verify/ux/03-preview.mjs
import { launch, open, loadText, lineText, cursor, placeCursor, step, expect, check, measure, finish, sleep, getFailures, BASE } from './lib.mjs';

const { browser, context, page, errors } = await launch();
await context.route('https://example.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>ext</title>ok' }));
await open(page, '?mode=split');

const filler = Array.from({ length: 150 }, (_, i) => `填充段落 ${i + 1}：这是一段用来撑开文档高度的文字，让第二节离顶部足够远。Paragraph ${i + 1}.`).join('\n\n');
const DOC = `# 顶部标题\n\n段落一 with [外部链接](https://example.com/x) and [相对链接](./other.md) and [跳到第二节](#第二节) and [Anchor Two](#anchor-two).\n\n- [ ] 任务甲\n- [x] 任务乙\n\n${filler}\n\n## 第二节\n\n段落二 second section.\n\n## Anchor Two\n\n段落三 third.\n`;
await loadText(page, DOC, 'inter.md');
const lineOf = (needle) => page.evaluate((n) => { const d = window.__mdr.app.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text.startsWith(n)) return i; return -1; }, needle);

// ---------------------------------------------------------------- task checkbox from preview
await step('Clicking a preview checkbox toggles the source line and re-renders checked', async () => {
  const boxes = await page.locator('.mdr-preview input[type=checkbox]');
  expect((await boxes.count()) === 2, `found ${await boxes.count()} checkboxes`);
  expect(!(await boxes.nth(0).isChecked()) && (await boxes.nth(1).isChecked()), 'initial checked state wrong');
  await boxes.nth(0).click();
  await sleep(50);
  expect((await lineText(page, 5)) === '- [x] 任务甲', `line 5 "${await lineText(page, 5)}"`);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(150);
  expect(await page.locator('.mdr-preview input[type=checkbox]').nth(0).isChecked(), 'checkbox not checked after re-render');
  await page.locator('.mdr-preview input[type=checkbox]').nth(1).click();
  await sleep(50);
  expect((await lineText(page, 6)) === '- [ ] 任务乙', `line 6 "${await lineText(page, 6)}"`);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(150);
  expect(!(await page.locator('.mdr-preview input[type=checkbox]').nth(1).isChecked()), 'checkbox still checked after re-render');
});
await step('Checkbox toggle from preview does not steal the cursor position in the editor', async () => {
  await placeCursor(page, 3, 4);
  await page.locator('.mdr-preview input[type=checkbox]').nth(0).click();
  await sleep(100);
  const c = await cursor(page);
  expect(c.line === 3 && c.col === 4, `cursor moved to ${JSON.stringify(c)}`);
  expect((await lineText(page, 5)) === '- [ ] 任务甲', 'toggle failed');
});
await step('Task toggled from the editor (Mod-Shift-x) updates the preview checkbox', async () => {
  await placeCursor(page, 5, 2);
  await page.keyboard.press('Meta+Shift+x');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(150);
  expect(await page.locator('.mdr-preview input[type=checkbox]').nth(0).isChecked(), 'preview not updated');
  await page.keyboard.press('Meta+Shift+x');
});

// ---------------------------------------------------------------- Alt+click
await step('Alt+click on a preview paragraph moves the editor cursor to that line', async () => {
  await placeCursor(page, 1, 0);
  const target = await lineOf('填充段落 3：');
  const p = page.locator('.mdr-preview p', { hasText: '填充段落 3：' });
  await p.click({ modifiers: ['Alt'], position: { x: 10, y: 5 } });
  await sleep(200);
  const c = await cursor(page);
  expect(c.line === target, `cursor line ${c.line}, expected ${target}`);
});
await step('Alt+click far down (after preview scroll) moves cursor and scrolls the editor to it', async () => {
  await page.mouse.move(1000, 500);
  await page.mouse.wheel(0, 3000);
  await sleep(400);
  const target = await page.evaluate(() => {
    const sc = document.querySelector('.mdr-preview');
    const r = sc.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + 120)?.closest('p');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { text: el.textContent.slice(0, 8), x: b.left + 10, y: b.top + 6 };
  });
  expect(target, 'no paragraph at preview point');
  await page.keyboard.down('Alt');
  await page.mouse.click(target.x, target.y);
  await page.keyboard.up('Alt');
  await sleep(300);
  const c = await cursor(page);
  const lt = await lineText(page, c.line);
  expect(lt.startsWith(target.text), `cursor at line ${c.line} "${lt.slice(0, 12)}", expected "${target.text}"`);
  const visible = await page.evaluate((line) => {
    const v = window.__mdr.app.editor.view;
    const b = v.lineBlockAt(v.state.doc.line(line).from);
    const st = v.scrollDOM.scrollTop, h = v.scrollDOM.clientHeight;
    return b.top >= st - 2 && b.bottom <= st + h + 2;
  }, c.line);
  expect(visible, 'editor did not scroll the target line into view');
});

// ---------------------------------------------------------------- links
await step('#anchor link navigates both panes to the heading', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(100);
  const target = await lineOf('## 第二节');
  const hrefAttr = await page.locator('.mdr-preview a', { hasText: '跳到第二节' }).getAttribute('href');
  await page.locator('.mdr-preview a', { hasText: '跳到第二节' }).click();
  await sleep(400);
  const c = await cursor(page);
  expect(c.line === target, `editor cursor line ${c.line}, expected ${target}`);
  const pv = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  const at = await page.evaluate(() => {
    const sc = document.querySelector('.mdr-preview');
    const r = sc.getBoundingClientRect();
    const h = [...sc.querySelectorAll('h2')].find((e) => e.textContent === '第二节');
    return {
      h2Top: h ? h.getBoundingClientRect().top - r.top : null,
      // Lead decision 1: the preview's scroll-past-end region is max(48px, 20vh) instead of 100vh, so a
      // heading inside the document's last screen cannot be lifted to the top edge — the pane runs out of
      // scroll range. Then the requirement is that it got as far as it can and the heading is on screen.
      atMax: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 2,
      clientHeight: sc.clientHeight,
    };
  });
  const h2Top = at.h2Top;
  expect(Math.abs(pv.line - target) <= 1 || at.atMax, `preview top line ${pv.line}, expected ${target} (atMax ${at.atMax})`);
  expect(h2Top !== null && h2Top > -5 && (h2Top < 60 || (at.atMax && h2Top < at.clientHeight)), `h2 offset from preview top: ${h2Top}px`);
  return `href="${hrefAttr}" h2 offset ${h2Top?.toFixed(0)}px`;
});
await step('#anchor with ASCII slug (anchor-two) resolves', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(100);
  const target = await lineOf('## Anchor Two');
  await page.locator('.mdr-preview a[href="#anchor-two"]').click();
  await sleep(400);
  const c = await cursor(page);
  expect(c.line === target, `editor cursor line ${c.line}, expected ${target}`);
});
await step('External link has target=_blank rel=noopener and opens a new tab', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(100);
  const a = page.locator('.mdr-preview a[href="https://example.com/x"]');
  const attrs = await a.evaluate((e) => ({ target: e.target, rel: e.rel }));
  expect(attrs.target === '_blank' && /noopener/.test(attrs.rel), JSON.stringify(attrs));
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 4000 }), a.click()]);
  await popup.waitForLoadState().catch(() => {});
  expect(popup.url().startsWith('https://example.com/x'), `popup url ${popup.url()}`);
  expect(page.url().startsWith(BASE), `main page navigated away: ${page.url()}`);
  await popup.close();
});
await step('Relative link shows the zh-CN toast and does not navigate', async () => {
  await page.locator('.mdr-preview a[href="./other.md"]').click();
  await sleep(100);
  const toast = await page.evaluate(() => document.querySelector('.mdr-toast__text')?.textContent);
  expect(toast === '暂不支持打开相对链接', `toast "${toast}"`);
  expect(page.url().startsWith(BASE), `navigated: ${page.url()}`);
});

// ---------------------------------------------------------------- scroll sync
await open(page, '?doc=/test-data/medium.md&mode=split');
await page.evaluate(() => window.__mdr.waitIdle());
const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

async function syncError() {
  return page.evaluate(() => {
    const ed = window.__mdr.app.editor.topVisible();
    const pv = window.__mdr.app.preview.topVisible();
    const pvBlock = window.__mdr.app.preview.blockAtLine(pv.line);
    const edBlock = window.__mdr.app.preview.blockAtLine(ed.line);
    // DOM ground truth for the preview: the block wrapper actually at the top edge of the scroller
    const sc = document.querySelector('.mdr-preview');
    const r = sc.getBoundingClientRect();
    let domBlock = null;
    for (const b of sc.querySelectorAll('.md-block')) {
      const br = b.getBoundingClientRect();
      if (br.bottom > r.top + 1) { domBlock = Number(b.dataset.id); break; }
    }
    return { edLine: ed.line, pvLine: pv.line, edBlock: edBlock.index, pvBlock: pvBlock.index, modelTopBlockId: pvBlock.id, domTopBlockId: domBlock, lineErr: Math.abs(ed.line - pv.line), blockErr: Math.abs(edBlock.index - pvBlock.index) };
  });
}

const total = await page.evaluate(() => window.__mdr.app.editor.view.scrollDOM.scrollHeight);
const edToPv = [];
await step('Editor → preview sync at 20 random positions (wheel-elected master, then scroll)', async () => {
  const edBox = await page.locator('.mdr-pane--editor').boundingBox();
  for (let i = 0; i < 20; i++) {
    const top = Math.floor(rnd() * (total - 900));
    await page.mouse.move(edBox.x + edBox.width / 2, edBox.y + 300);
    await page.mouse.wheel(0, 1);
    await page.evaluate((t) => { window.__mdr.app.editor.view.scrollDOM.scrollTop = t; }, top);
    await sleep(350);
    const e = await syncError();
    edToPv.push(e);
  }
  const lineErrs = edToPv.map((e) => e.lineErr);
  const blockErrs = edToPv.map((e) => e.blockErr);
  const domMismatch = edToPv.filter((e) => e.modelTopBlockId !== e.domTopBlockId).length;
  measure('editor→preview line error max', Math.max(...lineErrs), '≤ block size (≤1 block)', Math.max(...blockErrs) <= 1);
  measure('editor→preview block error max', Math.max(...blockErrs), '≤ 1', Math.max(...blockErrs) <= 1);
  measure('editor→preview block error mean', (blockErrs.reduce((a, b) => a + b, 0) / 20).toFixed(2), '≤ 1', true);
  measure('preview model-vs-DOM top block mismatches', domMismatch, '0 (of 20)', domMismatch === 0);
  return edToPv.map((e) => `${e.edLine}/${e.pvLine}(${e.blockErr})`).join(' ');
});
const pvToEd = [];
await step('Preview → editor sync at 20 random positions', async () => {
  const pvBox = await page.locator('.mdr-pane--preview').boundingBox();
  const pvTotal = await page.evaluate(() => document.querySelector('.mdr-preview').scrollHeight);
  for (let i = 0; i < 20; i++) {
    const top = Math.floor(rnd() * (pvTotal - 900));
    await page.mouse.move(pvBox.x + pvBox.width / 2, pvBox.y + 300);
    await page.mouse.wheel(0, 1);
    await page.evaluate((t) => { document.querySelector('.mdr-preview').scrollTop = t; }, top);
    await sleep(350);
    const e = await syncError();
    pvToEd.push(e);
  }
  const blockErrs = pvToEd.map((e) => e.blockErr);
  const lineErrs = pvToEd.map((e) => e.lineErr);
  measure('preview→editor block error max', Math.max(...blockErrs), '≤ 1', Math.max(...blockErrs) <= 1);
  measure('preview→editor line error max', Math.max(...lineErrs), 'informational', true);
  return pvToEd.map((e) => `${e.pvLine}/${e.edLine}(${e.blockErr})`).join(' ');
});
await step('Real wheel scrolling on the editor (20 screens) keeps preview following', async () => {
  const edBox = await page.locator('.mdr-pane--editor').boundingBox();
  await page.evaluate(() => { window.__mdr.app.editor.view.scrollDOM.scrollTop = 0; });
  await page.mouse.move(edBox.x + edBox.width / 2, edBox.y + 300);
  await page.mouse.wheel(0, 1);
  await sleep(200);
  const errs = [];
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 800);
    await sleep(120);
    errs.push((await syncError()).blockErr);
  }
  await sleep(300);
  const final = await syncError();
  measure('wheel-scroll editor: preview block error after settle', final.blockErr, '≤ 1', final.blockErr <= 1);
  return `during: ${errs.join(',')} final ${final.blockErr}`;
});
await step('Real wheel scrolling on the preview keeps editor following', async () => {
  const pvBox = await page.locator('.mdr-pane--preview').boundingBox();
  await page.mouse.move(pvBox.x + pvBox.width / 2, pvBox.y + 300);
  await page.mouse.wheel(0, 1);
  await sleep(200);
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 900); await sleep(120); }
  await sleep(300);
  const final = await syncError();
  measure('wheel-scroll preview: editor block error after settle', final.blockErr, '≤ 1', final.blockErr <= 1);
  return JSON.stringify(final);
});
await step('Editor PageDown ×30 keeps preview in sync', async () => {
  await placeCursor(page, 1, 0);
  await page.evaluate(() => { window.__mdr.app.editor.view.scrollDOM.scrollTop = 0; });
  await sleep(100);
  for (let i = 0; i < 30; i++) { await page.keyboard.press('PageDown'); await sleep(60); }
  await sleep(400);
  const e = await syncError();
  measure('PageDown×30: block error', e.blockErr, '≤ 1', e.blockErr <= 1);
  return JSON.stringify(e);
});

// ---------------------------------------------------------------- cursor follow
await step('Typing off-screen (preview scrolled away) brings the preview back to the cursor line', async () => {
  await placeCursor(page, 40, 0);
  await sleep(100);
  const pvBox = await page.locator('.mdr-pane--preview').boundingBox();
  await page.mouse.move(pvBox.x + pvBox.width / 2, pvBox.y + 300);
  await page.mouse.wheel(0, 1);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 20000; });
  await sleep(400);
  const before = await page.evaluate(() => window.__mdr.app.preview.isLineVisible(40));
  expect(!before, 'line 40 still visible after scrolling preview away');
  // typing must happen in the editor: click a spot in the editor pane (the cursor is at line 40 which is on screen)
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  await page.keyboard.type('追加');
  await sleep(900);
  const after = await page.evaluate(() => window.__mdr.app.preview.isLineVisible(40));
  expect(after, 'preview did not follow the cursor after typing');
  await page.keyboard.press('Meta+z');
});
await step('Typing at the end of a long document (editor scrolled there) — preview follows without jumping back', async () => {
  const last = await page.evaluate(() => window.__mdr.app.editor.lineCount());
  await placeCursor(page, last, 0);
  await page.keyboard.press('End');
  await sleep(300);
  await page.keyboard.type('尾部');
  await sleep(700);
  const vis = await page.evaluate((l) => window.__mdr.app.preview.isLineVisible(l), last);
  expect(vis, 'preview does not show the last line while typing there');
  await page.keyboard.press('Meta+z');
});

// ---------------------------------------------------------------- progress indicator
await step('Progress indicator (渲染中 N%) shows while a large file renders, then hides', async () => {
  await page.evaluate(() => { window.__progress = []; const el = document.querySelector('[data-stat="progress"]'); new MutationObserver(() => { if (!el.hidden) window.__progress.push(el.textContent); }).observe(el, { attributes: true, childList: true, characterData: true, subtree: true }); });
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  const seen = await page.evaluate(() => window.__progress);
  const hidden = await page.evaluate(() => document.querySelector('[data-stat="progress"]').hidden);
  expect(seen.length > 0 && seen.every((t) => /^渲染中 \d+%$/.test(t)), `progress texts: ${JSON.stringify(seen.slice(0, 5))}`);
  expect(hidden, 'progress not hidden after idle');
  return `${seen.length} updates, e.g. ${seen[0]} … ${seen[seen.length - 1]}`;
});
await step('Status bar stats for large.md are plausible (字数/字符/约 N 分钟)', async () => {
  const s = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.mdr-statusbar__item')].map((e) => [e.dataset.stat, e.hidden ? null : e.textContent])));
  const words = Number(/\d+/.exec(s.words)[0]);
  const chars = Number(/\d+/.exec(s.chars)[0]);
  const mins = Number(/\d+/.exec(s.reading)[0]);
  const len = (await page.evaluate(() => window.__mdr.app.getText())).length;
  expect(chars === len, `chars ${chars} vs text length ${len}`);
  expect(words > 100000 && mins > 100, `words ${words} mins ${mins}`);
  return JSON.stringify(s);
});

finish('03-preview', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
