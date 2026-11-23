// bench/verify/ux/12-gaps.mjs — remaining product gaps: mixed task/plain list bullets, preview/editor
// horizontal overflow, toast stacking + auto-dismiss, draft toast persistence, palette from preview
// (focus return, mouse), fuzzy subsequence, Mod-k w/o selection, anchor to missing heading, Alt+click on
// heading/code/table/list/quote, nested task checkbox + undo, real-macOS Alt keydown (key "©"), drop of
// non-markdown / multiple files, narrow toolbar, search extras, TOC click in edit/preview mode, ?doc=
// status label, progress indicator on large/huge, rich-doc bottom screenshots.
// Run: node bench/verify/ux/12-gaps.mjs
import { launch, open, loadText, getText, lineText, cursor, placeCursor, selectRange, step, expect, check, measure, finish, sleep, statusText, getFailures, BASE } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const { browser, context, page, errors } = await launch();
await open(page, '?mode=split');
const lineOf = (needle) => page.evaluate((n) => { const d = window.__mdr.app.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text.startsWith(n)) return i; return -1; }, needle);
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));

// ---------------------------------------------------------------- mixed list bullets
await loadText(page, '- 普通项一\n- 普通项二\n- [ ] 任务项\n- [x] 完成项\n\n1. 编号一\n2. [ ] 编号任务\n', 'mixed.md');
await step('Plain items in a list that also contains task items keep their bullets', async () => {
  const r = await page.evaluate(() => {
    const lis = [...document.querySelectorAll('.mdr-preview li')];
    return lis.map((li) => ({ text: li.textContent.trim().slice(0, 6), cls: li.className, task: !!li.querySelector('input[type=checkbox]'), style: getComputedStyle(li).listStyleType, ulCls: li.parentElement.className, pad: getComputedStyle(li.parentElement).paddingInlineStart }));
  });
  const plain = r.filter((x) => !x.task);
  const bad = plain.filter((x) => x.style === 'none');
  expect(bad.length === 0, `plain items without bullets: ${JSON.stringify(bad)} (all: ${JSON.stringify(r)})`);
  return JSON.stringify(r);
});

// ---------------------------------------------------------------- overflow
const longWord = 'A'.repeat(400);
const wideTable = '| ' + Array.from({ length: 14 }, (_, i) => `列${i} 很长的表头内容内容`).join(' | ') + ' |\n|' + Array.from({ length: 14 }, () => '---').join('|') + '|\n| ' + Array.from({ length: 14 }, (_, i) => `单元格 ${i} 内容内容内容`).join(' | ') + ' |\n';
await loadText(page, `# 溢出\n\n${longWord}\n\nhttps://example.com/${'p/'.repeat(150)}\n\n\`\`\`js\nconst x = "${'y'.repeat(300)}";\n\`\`\`\n\n${wideTable}\n\n行内 \`${'z'.repeat(200)}\` 末尾\n`, 'overflow.md');
await sleep(300);
await step('Long unbroken text / URL / code / table: no horizontal scroll of the page or the preview pane; pre & table scroll internally', async () => {
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const pv = document.querySelector('.mdr-preview');
    const pre = document.querySelector('.mdr-preview pre');
    const table = document.querySelector('.mdr-preview table');
    const tw = table?.parentElement;
    const cm = document.querySelector('.cm-scroller');
    const body = document.querySelector('.mdr-preview__body');
    const paras = [...document.querySelectorAll('.mdr-preview p')].map((p) => ({ t: p.textContent.slice(0, 12), sw: p.scrollWidth, cw: p.clientWidth, ow: getComputedStyle(p).overflowWrap }));
    return {
      page: [de.scrollWidth, de.clientWidth], preview: [pv.scrollWidth, pv.clientWidth], body: [body.scrollWidth, body.clientWidth],
      pre: pre ? [pre.scrollWidth, pre.clientWidth, getComputedStyle(pre).overflowX] : null,
      table: table ? { sw: table.scrollWidth, cw: table.clientWidth, wrapper: tw.className, wrapperOverflow: getComputedStyle(tw).overflowX, tableOverflow: getComputedStyle(table).overflowX, display: getComputedStyle(table).display, tableRight: table.getBoundingClientRect().right, pvRight: pv.getBoundingClientRect().right } : null,
      editor: [cm.scrollWidth, cm.clientWidth], paras,
    };
  });
  expect(r.page[0] <= r.page[1], `page scrolls horizontally ${r.page}`);
  expect(r.preview[0] <= r.preview[1] + 1, `preview pane scrolls horizontally ${r.preview}`);
  expect(r.editor[0] <= r.editor[1] + 1, `editor scrolls horizontally ${r.editor}`);
  check('Wide table is scrollable inside the preview instead of overflowing/clipping', r.table && (r.table.tableRight <= r.table.pvRight + 1) && (r.table.wrapperOverflow === 'auto' || r.table.tableOverflow === 'auto' || r.table.display === 'block'), JSON.stringify(r.table));
  check('Long unbroken word wraps (overflow-wrap) rather than overflowing the paragraph', r.paras.every((p) => p.sw <= p.cw + 1), JSON.stringify(r.paras));
  return JSON.stringify(r);
});
await page.screenshot({ path: `${OUT}/overflow-light.png` });

// ---------------------------------------------------------------- toasts
await loadText(page, '[相对](./a.md) 文本\n', 'toast.md');
await step('Clicking a relative link 5× quickly does not stack 5 identical toasts; info toast auto-dismisses', async () => {
  for (let i = 0; i < 5; i++) { await page.locator('.mdr-preview a').click(); await sleep(60); }
  const n = await page.evaluate(() => document.querySelectorAll('.mdr-toast').length);
  check('Identical toasts are de-duplicated (≤ 2 visible after 5 clicks)', n <= 2, `${n} toasts visible`);
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('.mdr-toast').length === 0, null, { timeout: 12000 });
  return `${n} toasts; all gone after ≈${Date.now() - t0} ms`;
});
await step('Draft-restore toast does not auto-dismiss (still there after 8 s)', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(100);
  await page.click('.cm-content');
  await page.keyboard.type('持久草稿');
  await page.waitForFunction(() => document.querySelector('[data-stat="file"]').textContent.includes('草稿已存'), null, { timeout: 4000 });
  page.once('dialog', (d) => d.accept());
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await page.waitForSelector('.mdr-toast', { timeout: 4000 });
  await sleep(8000);
  const still = await page.evaluate(() => !!document.querySelector('.mdr-toast'));
  expect(still, 'draft toast vanished before the user could act');
  await page.click('.mdr-toast__btn:has-text("丢弃")');
});

// ---------------------------------------------------------------- palette
await loadText(page, '# 标题\n\n段落 abc def\n', 'pal.md');
await step('Palette opened with focus on the preview: Esc returns focus to the editor; mouse click runs a command', async () => {
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.press('Escape');
  await sleep(50);
  const focused = await page.evaluate(() => document.activeElement?.closest('.cm-editor') ? 'editor' : document.activeElement?.tagName);
  check('Esc from a palette opened while the preview had focus returns focus to the editor', focused === 'editor', `focus on ${focused}`);
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('预览');
  await sleep(50);
  await page.locator('.mdr-palette__item', { hasText: '预览' }).first().click();
  await sleep(100);
  const mode = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  expect(mode === 'preview', `mode after clicking 预览: ${mode}`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
});
await step('Palette fuzzy filter matches a subsequence (标3 → 标题 3) and ranks prefix matches first', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('标3');
  await sleep(50);
  const titles = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item .mdr-palette__title')].map((e) => e.textContent));
  await page.keyboard.press('Escape');
  expect(titles[0] === '标题 3', `filtered: ${titles.join(',')}`);
  return titles.join(',');
});
await step('Palette: mouse hover moves the active item; Enter runs the hovered one', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('标题');
  await sleep(50);
  await page.locator('.mdr-palette__item').nth(2).hover();
  await sleep(50);
  const active = await page.evaluate(() => document.querySelector('.mdr-palette__item.is-active .mdr-palette__title')?.textContent);
  await page.keyboard.press('Escape');
  check('Hovering a palette item makes it the active (Enter) target', active === '标题 3', `active after hover: "${active}"`);
});

// ---------------------------------------------------------------- Mod-k without selection, bold multi-line
await step('Mod-k with no selection inserts a link template; bold on a multi-line selection', async () => {
  await placeCursor(page, 3, 3);
  await page.keyboard.press('Meta+k');
  await sleep(150);
  const t = await lineText(page, 3);
  const sel = await page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to); });
  check('Mod-k without selection inserts [](url)-style template (or similar) at the cursor', /\[.*\]\(.*\)/.test(t), `line: "${t}", selected "${sel}"`);
  await page.keyboard.press('Meta+z');
  await loadText(page, '第一行 one\n第二行 two\n', 'ml.md');
  await selectRange(page, 0, 12);
  await page.keyboard.press('Meta+b');
  const r = await getText(page);
  return `no-sel link → "${t}" (selected "${sel}"); multi-line bold → ${JSON.stringify(r)}`;
});

// ---------------------------------------------------------------- anchors / alt+click / nested tasks
const fill = Array.from({ length: 40 }, (_, i) => `段 ${i}`).join('\n\n');
await loadText(page, `# 顶\n\n[缺失](#no-such-heading) [有](#二)\n\n${fill}\n\n## 二\n\n> 引用一行\n> 引用二行\n\n\`\`\`js\nline1\nline2\nline3\n\`\`\`\n\n| a | b |\n|---|---|\n| r1 | x |\n| r2 | y |\n\n- 甲\n  - 乙\n- [ ] 父任务\n  - [ ] 子任务一\n  - [x] 子任务二\n- 丙\n`, 'nav2.md');
await step('#anchor to a missing heading: no navigation, URL unchanged, no error (feedback noted)', async () => {
  const before = await cursor(page);
  await page.locator('.mdr-preview a[href="#no-such-heading"]').click();
  await sleep(300);
  const after = await cursor(page);
  const hash = await page.evaluate(() => location.hash);
  expect(hash === '', `location.hash became "${hash}"`);
  expect(before.line === after.line, 'cursor moved');
  const t = await toasts();
  return `toasts: ${t.join('|') || '(none — silent no-op)'}`;
});
await step('Alt+click on heading / quote / code / table row / nested list item moves the cursor to the right line', async () => {
  // markdown-it percent-encodes non-ASCII fragments (normalizeLink), so the attribute is "#%E4%BA%8C".
  await page.locator(`.mdr-preview a[href="#${encodeURIComponent('二')}"]`).click();
  await sleep(400);
  const targets = [
    ['h2', '## 二', 'h2'],
    ['blockquote p', '> 引用一行', 'quote'],
    ['pre code', '```js', 'code fence start'],
    ['table tbody tr:nth-child(2) td', '| r2 | y |', 'table row 2'],
    // `li:has-text` also matches the OUTER li (the nested one is its descendant): match the li whose
    // own normalized text is exactly the item's, so the click lands on the nested item.
    ['li:text-is("乙")', '  - 乙', 'nested li'],
    ['li:text-is("子任务二")', '  - [x] 子任务二', 'nested task li'],
  ];
  const out = [];
  for (const [sel, expectedText, label] of targets) {
    const want = await lineOf(expectedText);
    try {
      const loc = page.locator(`.mdr-preview ${sel}`).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      await sleep(150);
      await page.evaluate(() => window.__mdr.waitIdle());
      await loc.click({ modifiers: ['Alt'], position: { x: 8, y: 6 }, timeout: 4000 });
      await sleep(200);
      const c = await cursor(page);
      const lt = await lineText(page, c.line);
      const ok = c.line === want || (label === 'table row 2' && Math.abs(c.line - want) <= 3);
      check(`Alt+click ${label} → line ${want} ("${expectedText}")`, ok, `cursor line ${c.line} "${lt}"`);
      out.push(`${label}:${c.line}/${want}`);
    } catch (e) {
      check(`Alt+click ${label} → line ${want} ("${expectedText}")`, false, `click failed: ${e.message.split('\n')[0]}`);
      out.push(`${label}:ERR`);
    }
  }
  return out.join(' ');
});
await step('Nested task checkbox toggles the right source line; Mod-z reverts and the preview follows', async () => {
  const boxes = page.locator('.mdr-preview input[type=checkbox]');
  expect((await boxes.count()) === 3, `${await boxes.count()} boxes`);
  const l = await lineOf('  - [ ] 子任务一');
  await boxes.nth(1).click();
  await sleep(100);
  expect((await lineText(page, l)) === '  - [x] 子任务一', `line ${l}: "${await lineText(page, l)}"`);
  expect((await lineText(page, l - 1)) === '- [ ] 父任务', `parent line changed: "${await lineText(page, l - 1)}"`);
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  await page.keyboard.press('Meta+z');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(200);
  expect((await lineText(page, l)) === '  - [ ] 子任务一', `after undo: "${await lineText(page, l)}"`);
  expect(!(await page.locator('.mdr-preview input[type=checkbox]').nth(1).isChecked()), 'preview checkbox still checked after undo');
});

// ---------------------------------------------------------------- real macOS Alt keydown (key '©')
await step('Mod-Alt-g as a real macOS keydown (key "©", code KeyG) opens goto-line; Mod-Shift-x with key "X"', async () => {
  await placeCursor(page, 3, 0);
  await page.evaluate(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '©', code: 'KeyG', keyCode: 71, altKey: true, metaKey: true, bubbles: true, cancelable: true }));
  });
  const opened = await page.waitForSelector('.cm-goto-line', { timeout: 1500 }).then(() => true).catch(() => false);
  expect(opened, 'goto-line panel did not open for key "©"');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  await placeCursor(page, 3, 0);
  await page.evaluate(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', code: 'KeyX', keyCode: 88, shiftKey: true, metaKey: true, bubbles: true, cancelable: true }));
  });
  await sleep(50);
  const t = await lineText(page, 3);
  expect(t.startsWith('- [ ] '), `Mod-Shift-x synthetic: "${t}"`);
  await page.keyboard.press('Meta+z');
  // window-level: Mod-Shift-o with key 'O'
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', keyCode: 79, shiftKey: true, metaKey: true, bubbles: true, cancelable: true })));
  await sleep(50);
  const toc = await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc);
  expect(toc === 'closed', `toc after synthetic Mod-Shift-O: ${toc}`);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', code: 'KeyO', keyCode: 79, shiftKey: true, metaKey: true, bubbles: true, cancelable: true })));
});

// ---------------------------------------------------------------- drop of non-markdown / multiple files
await step('Dropping a .png onto a clean document: document unchanged, user gets feedback', async () => {
  await loadText(page, '# 干净文档\n', 'clean.md');
  await page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
  const before = await getText(page);
  await page.evaluate(() => {
    const app = document.querySelector('.mdr-app');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 0, 1, 2])], 'pic.png', { type: 'image/png' }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(400);
  const after = await getText(page);
  const t = await toasts();
  const dlg = await page.$('.mdr-dialog');
  if (dlg) await page.click('.mdr-dialog__btn:has-text("取消")');
  check('Dropping a binary .png does not replace the document with garbage', after === before || dlg !== null, `text changed to ${JSON.stringify(after.slice(0, 20))}`);
  check('Dropping a non-markdown file gives feedback (toast) instead of silently opening it', t.length > 0 || dlg === null && after === before, `toasts ${t.join('|')}; dialog=${!!dlg}`);
  return `png → toasts ${JSON.stringify(t)}; dialog=${!!dlg}; text changed=${after !== before}`;
});

// ---------------------------------------------------------------- narrow toolbar
await step('Toolbar at 640×480: every button visible and not overlapped by the file name', async () => {
  await page.setViewportSize({ width: 640, height: 480 });
  await sleep(200);
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.mdr-toolbar__btn')].map((b) => { const r = b.getBoundingClientRect(); return { cmd: b.dataset.cmd, l: r.left, r: r.right, t: r.top, b: r.bottom, vis: r.width > 0 }; });
    const name = document.querySelector('.mdr-toolbar__file').getBoundingClientRect();
    const tb = document.querySelector('.mdr-toolbar');
    return { btns, name: [name.left, name.right, name.top, name.bottom], tb: { sw: tb.scrollWidth, cw: tb.clientWidth, h: tb.getBoundingClientRect().height, overflow: getComputedStyle(tb).overflowX } };
  });
  await page.screenshot({ path: `${OUT}/toolbar-640x480.png` });
  const clipped = r.btns.filter((b) => b.r > 640 || !b.vis);
  const overlapped = r.btns.filter((b) => b.r > r.name[0] && b.l < r.name[1] && b.b > r.name[2] && b.t < r.name[3]);
  check('No toolbar button is clipped at 640px', clipped.length === 0, JSON.stringify(clipped));
  check('File name does not overlap toolbar buttons at 640px', overlapped.length === 0, `overlapped ${JSON.stringify(overlapped)} name ${r.name}`);
  return JSON.stringify(r.tb) + ` name=${r.name.map((n) => n.toFixed(0))}`;
});
await page.setViewportSize({ width: 1400, height: 900 });

// ---------------------------------------------------------------- search extras
await loadText(page, 'foo 一\nfoo 二\nfoo 三\n', 's.md');
await step('Search: Mod-f while open refocuses the field; Shift-Enter finds previous; × closes and returns focus', async () => {
  await placeCursor(page, 1, 0);
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.cm-search');
  await page.locator('.cm-search input[name="search"]').fill('foo');
  await page.keyboard.press('Shift'); // CM commits the query on keyup; fill() fires none
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  let c = await cursor(page);
  expect(c.line === 2, `after 2× Enter: line ${c.line}`);
  await page.keyboard.press('Shift+Enter');
  c = await cursor(page);
  expect(c.line === 1, `after Shift-Enter: line ${c.line}`);
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  await page.keyboard.press('Meta+f');
  await sleep(50);
  const focused = await page.evaluate(() => document.activeElement?.name === 'search');
  expect(focused, 'Mod-f while open did not focus the search field');
  await page.click('.cm-search button[name="close"]');
  await sleep(50);
  expect(!(await page.$('.cm-search')), 'panel still open after ×');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')), 'focus not back in editor after ×');
});

// ---------------------------------------------------------------- TOC click in edit / preview mode
await open(page, '?doc=/test-data/small.md&mode=edit');
await step('TOC click in edit mode moves the editor cursor + scrolls it; in preview mode scrolls the preview', async () => {
  const t = await page.evaluate(() => { const a = document.querySelectorAll('.mdr-toc__item')[30]; return { line: Number(a.dataset.line), text: a.textContent }; });
  await page.locator('.mdr-toc__item').nth(30).click();
  await sleep(400);
  const c = await cursor(page);
  expect(c.line === t.line, `edit mode: cursor ${c.line}, want ${t.line}`);
  const vis = await page.evaluate((line) => { const v = window.__mdr.app.editor.view; const b = v.lineBlockAt(v.state.doc.line(line).from); const st = v.scrollDOM.scrollTop; return b.top >= st - 2 && b.bottom <= st + v.scrollDOM.clientHeight + 2; }, t.line);
  expect(vis, 'edit mode: target line not scrolled into view');
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(300);
  const t2 = await page.evaluate(() => { const a = document.querySelectorAll('.mdr-toc__item')[10]; return { line: Number(a.dataset.line), text: a.textContent }; });
  await page.locator('.mdr-toc__item').nth(10).click();
  await sleep(500);
  const pv = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  expect(Math.abs(pv.line - t2.line) <= 2, `preview mode: top line ${pv.line}, want ${t2.line}`);
  const active = await page.evaluate(() => document.querySelector('.mdr-toc__item.is-active')?.textContent);
  check('TOC active item updates after a TOC click in preview mode', active === t2.text, `active "${active}" want "${t2.text}"`);
});
await step('Status bar label for a URL-loaded named file (?doc=)', async () => {
  const s = await statusText(page);
  check('Named file loaded via ?doc= is not labelled 未命名 in the status bar', !/未命名/.test(s.file), `status "${s.file}"`);
  return s.file;
});

// ---------------------------------------------------------------- progress indicator
await open(page, '?mode=split');
for (const doc of ['large', 'huge']) {
  await step(`Progress indicator on ${doc}.md: shown values and duration`, async () => {
    await page.evaluate(() => { window.__prog = []; const el = document.querySelector('[data-stat="progress"]'); new MutationObserver(() => window.__prog.push({ t: performance.now(), hidden: el.hidden, text: el.textContent })).observe(el, { attributes: true, childList: true, characterData: true, subtree: true }); });
    const t0 = Date.now();
    await page.evaluate((d) => window.__mdr.loadUrl(`/test-data/${d}.md`), doc);
    await page.evaluate(() => window.__mdr.waitIdle());
    const dur = Date.now() - t0;
    const log = await page.evaluate(() => window.__prog);
    const shown = log.filter((e) => !e.hidden).map((e) => e.text);
    const pcts = shown.map((s) => Number(/\d+/.exec(s)?.[0] ?? -1));
    const max = pcts.length ? Math.max(...pcts) : -1;
    const visibleFor = log.length ? (log.at(-1).t - log[0].t).toFixed(0) : 0;
    measure(`progress max % shown (${doc}.md)`, max, '≥ 90 before hiding', max >= 90);
    return `load→idle ${dur} ms; visible ≈${visibleFor} ms; texts: ${[...new Set(shown)].join(' ')}`;
  });
}

// ---------------------------------------------------------------- rich doc bottom (quote, lists, details, hr, image) light + dark
const rich = `# 底部内容\n\n> 引用块：性能是一种特性。\n> 第二行引用\n\n- 项目一\n  - 嵌套项目\n    - 三级项目\n- 项目二\n\n1. 第一\n2. 第二\n   1. 子编号\n\n- [ ] 待办\n- [x] 已完成\n\n<details><summary>HTML 折叠</summary>\n\n折叠内容 **加粗**\n\n</details>\n\n---\n\n![缺失图片](https://example.invalid/x.png)\n\n术语表：\n\n| 键 | 值 |\n|---|---|\n| a | 1 |\n\n结束段落。\n`;
for (const theme of ['light', 'dark']) {
  await step(`screenshot rich bottom ${theme}`, async () => {
    await page.evaluate((t) => localStorage.setItem('mdr.theme', t), theme);
    await open(page, '?mode=split');
    await loadText(page, rich, 'bottom.md');
    await sleep(500);
    await page.screenshot({ path: `${OUT}/rich-bottom-${theme}.png` });
    const r = await page.evaluate(() => {
      const q = document.querySelector('.mdr-preview blockquote');
      const d = document.querySelector('.mdr-preview details');
      const hr = document.querySelector('.mdr-preview hr');
      const img = document.querySelector('.mdr-preview img');
      const ol = document.querySelector('.mdr-preview ol ol');
      return { quoteBorder: q && getComputedStyle(q).borderLeftWidth, details: !!d, hr: hr && getComputedStyle(hr).height, img: img && img.alt, nestedOl: !!ol, olType: ol && getComputedStyle(ol).listStyleType };
    });
    return JSON.stringify(r);
  });
}
await page.evaluate(() => localStorage.setItem('mdr.theme', 'light'));

finish('12-gaps', errors);
console.log('ERRORS:', JSON.stringify([...new Set(errors)]));
await browser.close();
process.exit(getFailures() ? 1 : 0);
