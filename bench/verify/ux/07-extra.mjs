// bench/verify/ux/07-extra.mjs — gaps: Backspace marker semantics, Mod-f from the preview pane, legacy
// Mod-o via <input type=file>, recent menu, 全部渲染, TOC-click heading offset, progress indicator range,
// CJK #anchor with percent-encoded href, dialog Enter semantics, scroll-sync outlier re-measure.
// Run: node bench/verify/ux/07-extra.mjs
import { launch, open, loadText, getText, lineText, cursor, placeCursor, step, expect, check, measure, finish, sleep, statusText, getFailures, BASE } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const { browser, context, page, errors } = await launch();
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await open(page, '?mode=split');

// ---------------------------------------------------------------- Backspace on list markers
await loadText(page, '- 甲\n- 乙\n- [ ] \n', 'bs.md');
await step('Backspace right after "- " on a list item: what remains', async () => {
  await placeCursor(page, 2, 2);
  await page.keyboard.press('Backspace');
  const t1 = await lineText(page, 2);
  await page.keyboard.press('Backspace');
  const t2 = await lineText(page, 2);
  check('Backspace after list marker removes the marker (no leftover indentation)', t1 === '乙', `1st Backspace → "${t1}", 2nd → "${t2}"`);
  return `"${t1}" then "${t2}"`;
});
await step('Backspace on an empty task item "- [ ] "', async () => {
  // the previous step's second Backspace joined line 2 into line 1 (correct): reload the 3-line fixture
  await loadText(page, '- 甲\n- 乙\n- [ ] \n', 'bs.md');
  await placeCursor(page, 3, 6);
  await page.keyboard.press('Backspace');
  const t1 = await lineText(page, 3);
  await page.keyboard.press('Backspace');
  const t2 = await lineText(page, 3);
  check('Backspace on empty task item leaves an empty line (not invisible spaces)', t1 === '' || t1 === '- ', `1st → "${t1}" (len ${t1.length}), 2nd → "${t2}" (len ${t2.length})`);
  return `"${t1}" then "${t2}"`;
});

// ---------------------------------------------------------------- Mod-f from the preview pane
await loadText(page, '# 一\n\n段落 findme\n', 'f.md');
await step('Mod-f with focus in the preview pane opens the editor search panel (SPEC §13)', async () => {
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  const focusedIn = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
  await page.keyboard.press('Meta+f');
  const open = await page.waitForSelector('.cm-search', { timeout: 1500 }).then(() => true).catch(() => false);
  expect(open, `search panel did not open (focus was on "${focusedIn}")`);
  await page.keyboard.press('Escape');
});

// ---------------------------------------------------------------- Mod-o (legacy) via file input
await step('Mod-o opens a file chooser (legacy backend) and setInputFiles loads the file', async () => {
  const tmp = '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/picked.md';
  writeFileSync(tmp, '# 选中的文件\n\npicked body\n');
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }), page.keyboard.press('Meta+o')]);
  await chooser.setFiles(tmp);
  await page.waitForFunction(() => window.__mdr.app.getText().includes('picked body'), null, { timeout: 4000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(80);
  const s = await statusText(page);
  expect(s.file === 'picked.md · 已保存', `status "${s.file}"`);
  expect((await page.title()) === 'picked.md', `title "${await page.title()}"`);
});
await step('Recent-files menu (legacy): opens on click with 打开文件… and lists entries', async () => {
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent', { timeout: 1500 });
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-recent li')].map((l) => l.textContent));
  expect(items[0] === '打开文件…', `items ${items}`);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 500);
  await sleep(50);
  const gone = await page.evaluate(() => !document.querySelector('.mdr-recent'));
  expect(gone, 'menu did not close on outside click / Esc');
  return items.join(' | ');
});

// ---------------------------------------------------------------- 全部渲染 via palette
await open(page, '?doc=/test-data/medium.md&mode=split');
await step('Palette → 全部渲染 mounts every block', async () => {
  const before = await page.evaluate(() => document.querySelectorAll('.md-block:not(.is-pending)').length);
  const total = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('全部渲染');
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) => document.querySelectorAll('.md-block:not(.is-pending)').length >= t, total, { timeout: 30000 });
  const after = await page.evaluate(() => document.querySelectorAll('.md-block:not(.is-pending)').length);
  return `mounted ${before} → ${after} of ${total}`;
});

// ---------------------------------------------------------------- TOC click: heading offset from preview top
await open(page, '?doc=/test-data/small.md&mode=split');
await step('TOC click lands the heading at the preview top (offset measured for 6 items)', async () => {
  const offs = [];
  for (const i of [3, 8, 12, 20, 33, 50]) {
    const t = await page.evaluate((i) => { const a = document.querySelectorAll('.mdr-toc__item')[i]; return { line: Number(a.dataset.line), text: a.textContent.trim() }; }, i);
    await page.locator('.mdr-toc__item').nth(i).click();
    await sleep(500);
    const r = await page.evaluate((t) => {
      const sc = document.querySelector('.mdr-preview'); const sr = sc.getBoundingClientRect();
      const hs = [...sc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.textContent.trim() === t.text);
      const h = hs[0];
      const blk = h?.closest('.md-block');
      const pv = window.__mdr.app.preview.topVisible();
      return h ? { found: true, off: +(h.getBoundingClientRect().top - sr.top).toFixed(1), blockOff: +(blk.getBoundingClientRect().top - sr.top).toFixed(1), pvLine: pv.line, target: t.line, pending: blk.classList.contains('is-pending') } : { found: false, pvLine: pv.line, target: t.line };
    }, t);
    offs.push(`#${i} L${t.line}: ${JSON.stringify(r)}`);
    check(`TOC item #${i} heading visible at top after click (offset within [-4, 80] px)`, r.found && r.off >= -4 && r.off <= 80, JSON.stringify(r));
  }
  return offs.join('\n    ');
});

// ---------------------------------------------------------------- progress indicator range
await step('Progress indicator reaches a meaningful percentage while large.md renders', async () => {
  await page.evaluate(() => { window.__progress = []; const el = document.querySelector('[data-stat="progress"]'); new MutationObserver(() => { if (!el.hidden) window.__progress.push(el.textContent); }).observe(el, { attributes: true, childList: true, characterData: true, subtree: true }); });
  const t0 = Date.now();
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  const dur = Date.now() - t0;
  const seen = await page.evaluate(() => window.__progress);
  const pcts = seen.map((s) => Number(/\d+/.exec(s)[0]));
  const max = Math.max(...pcts);
  measure('progress indicator max % before idle (large.md)', max, '≈100 (monotone 0→100)', max >= 90);
  return `render→idle ${dur} ms; ${seen.length} updates: ${[...new Set(seen)].join(' ')}`;
});

// ---------------------------------------------------------------- CJK anchor with percent-encoded href
await open(page, '?mode=split');
await loadText(page, '# 顶\n\n[去 第二节](#第二节) · [去 中文 标题](#中文-标题)\n\n' + Array.from({ length: 80 }, (_, i) => `段 ${i}`).join('\n\n') + '\n\n## 第二节\n\nx\n\n## 中文 标题\n\ny\n', 'anc.md');
await step('CJK #anchor links (href percent-encoded by markdown-it) resolve in both panes', async () => {
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview a')].map((a) => a.getAttribute('href')));
  await page.locator('.mdr-preview a', { hasText: '去 第二节' }).click();
  await sleep(400);
  const c1 = await cursor(page);
  expect((await lineText(page, c1.line)) === '## 第二节', `cursor line ${c1.line} "${await lineText(page, c1.line)}"`);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(100);
  await page.locator('.mdr-preview a', { hasText: '去 中文 标题' }).click();
  await sleep(400);
  const c2 = await cursor(page);
  expect((await lineText(page, c2.line)) === '## 中文 标题', `cursor line ${c2.line} "${await lineText(page, c2.line)}"`);
  return `hrefs ${hrefs.join(' ')}`;
});

// ---------------------------------------------------------------- dialog Enter semantics
await step('Dirty-guard dialog: pressing Enter immediately', async () => {
  await page.click('.cm-content');
  await page.keyboard.type('重要内容');
  await sleep(50);
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog');
  const focused = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('Enter');
  await sleep(150);
  const text = await getText(page);
  check('Enter in the dirty-guard dialog does NOT discard the document (default should be 取消)', text.includes('重要内容'), `focused button "${focused}", after Enter text = "${text}"`);
});

// ---------------------------------------------------------------- scroll-sync outlier re-measure (1 s settle)
await open(page, '?doc=/test-data/medium.md&mode=split');
await page.evaluate(() => window.__mdr.waitIdle());
await step('Editor→preview sync: 20 positions, 1 s settle, block error', async () => {
  const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const total = await page.evaluate(() => window.__mdr.app.editor.view.scrollDOM.scrollHeight);
  const edBox = await page.locator('.mdr-pane--editor').boundingBox();
  const out = [];
  for (let i = 0; i < 20; i++) {
    const top = Math.floor(rnd() * (total - 900));
    await page.mouse.move(edBox.x + edBox.width / 2, edBox.y + 300);
    await page.mouse.wheel(0, 1);
    await page.evaluate((t) => { window.__mdr.app.editor.view.scrollDOM.scrollTop = t; }, top);
    await sleep(1000);
    out.push(await page.evaluate(() => { const ed = window.__mdr.app.editor.topVisible(); const pv = window.__mdr.app.preview.topVisible(); const a = window.__mdr.app.preview.blockAtLine(ed.line).index, b = window.__mdr.app.preview.blockAtLine(pv.line).index; return { ed: ed.line, pv: pv.line, blockErr: Math.abs(a - b), lineErr: Math.abs(ed.line - pv.line) }; }));
  }
  const maxB = Math.max(...out.map((o) => o.blockErr)), maxL = Math.max(...out.map((o) => o.lineErr));
  measure('editor→preview block error max (1 s settle, 20 pos)', maxB, '≤ 1 (P10)', maxB <= 1);
  measure('editor→preview line error max (1 s settle, 20 pos)', maxL, 'informational', true);
  return out.map((o) => `${o.ed}/${o.pv}(${o.blockErr})`).join(' ');
});

finish('07-extra', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
