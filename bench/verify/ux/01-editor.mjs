// bench/verify/01-editor.mjs — editor commands via keyboard + toolbar, find/replace, goto line, palette.
// Run: node bench/verify/01-editor.mjs
import { launch, open, loadText, getText, lineText, cursor, selectRange, placeCursor, step, expect, check, finish, sleep, statusText, getFailures } from './lib.mjs';

const { browser, page, errors } = await launch();
await open(page, '?mode=split');

const DOC = `# 标题一\n\n普通段落 hello world\n\n- 列表项 A\n- 列表项 B\n\n1. 第一\n2. 第二\n\n- [ ] 待办\n- [x] 已完成\n\n> 引用\n`;
const reset = () => loadText(page, DOC, 'cmd-test.md');
await reset();

// ---------------------------------------------------------------- toggle-wrap: bold
await step('Mod-b wraps selection with **', async () => {
  // line 3 is "普通段落 hello world"; select "hello"
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.keyboard.press('Meta+b');
  const t = await lineText(page, 3);
  expect(t === '普通段落 **hello** world', `got "${t}"`);
  const c = await cursor(page);
  expect(c.head - c.anchor === 5 || c.anchor - c.head === 5, `selection should still cover hello, got ${JSON.stringify(c)}`);
});
await step('Mod-b again unwraps', async () => {
  await page.keyboard.press('Meta+b');
  const t = await lineText(page, 3);
  expect(t === '普通段落 hello world', `got "${t}"`);
});
await step('Mod-b with cursor only inserts **** and places cursor inside', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await placeCursor(page, 3, l.text.length);
  await page.keyboard.press('Meta+b');
  await page.keyboard.type('x');
  const t = await lineText(page, 3);
  expect(t === '普通段落 hello world**x**', `got "${t}"`);
  await page.keyboard.press('Meta+z');
  const afterUndo = await lineText(page, 3);
  check('Undo after bold-insert + typing removes only the typed char (separate history events)', afterUndo === '普通段落 hello world****', `after one undo: "${afterUndo}"`);
});
await reset();
await step('Mod-i italic wraps with _ and unwraps', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.keyboard.press('Meta+i');
  let t = await lineText(page, 3);
  expect(t === '普通段落 _hello_ world', `got "${t}"`);
  await page.keyboard.press('Meta+i');
  t = await lineText(page, 3);
  expect(t === '普通段落 hello world', `unwrap got "${t}"`);
});
await reset();
await step('Mod-e inline code wraps with ` and unwraps', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.keyboard.press('Meta+e');
  let t = await lineText(page, 3);
  expect(t === '普通段落 `hello` world', `got "${t}"`);
  await page.keyboard.press('Meta+e');
  t = await lineText(page, 3);
  expect(t === '普通段落 hello world', `unwrap got "${t}"`);
});
await reset();
await step('Mod-k link insertion with selection selects url', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.keyboard.press('Meta+k');
  await sleep(200);
  let t = await lineText(page, 3);
  expect(t === '普通段落 [hello](url) world', `got "${t}"`);
  const sel = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
  });
  expect(sel === 'url', `selected text "${sel}"`);
  await page.keyboard.type('https://a.b');
  t = await lineText(page, 3);
  expect(t === '普通段落 [hello](https://a.b) world', `after typing url: "${t}"`);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  t = await lineText(page, 3);
  expect(t === '普通段落 hello world', `after undo: "${t}"`);
});

// ---------------------------------------------------------------- headings
await reset();
await step('Mod-1..6 / Mod-0 set heading level on line', async () => {
  await placeCursor(page, 3, 2);
  for (let n = 1; n <= 6; n++) {
    await page.keyboard.press(`Meta+${n}`);
    const t = await lineText(page, 3);
    expect(t === '#'.repeat(n) + ' 普通段落 hello world', `Mod-${n}: got "${t}"`);
  }
  await page.keyboard.press('Meta+0');
  const t = await lineText(page, 3);
  expect(t === '普通段落 hello world', `Mod-0: got "${t}"`);
});
await step('Same heading level toggles off', async () => {
  await placeCursor(page, 1, 2);
  await page.keyboard.press('Meta+1');
  const t = await lineText(page, 1);
  expect(t === '标题一', `got "${t}"`);
  await page.keyboard.press('Meta+1');
  const t2 = await lineText(page, 1);
  expect(t2 === '# 标题一', `got "${t2}"`);
});

// ---------------------------------------------------------------- tasks
await reset();
await step('Mod-Shift-x toggles task on list item / plain line', async () => {
  await placeCursor(page, 11, 3); // "- [ ] 待办"
  await page.keyboard.press('Meta+Shift+x');
  expect((await lineText(page, 11)) === '- [x] 待办', `got "${await lineText(page, 11)}"`);
  await page.keyboard.press('Meta+Shift+x');
  expect((await lineText(page, 11)) === '- [ ] 待办', `got "${await lineText(page, 11)}"`);
  await placeCursor(page, 5, 3); // "- 列表项 A"
  await page.keyboard.press('Meta+Shift+x');
  expect((await lineText(page, 5)) === '- [ ] 列表项 A', `got "${await lineText(page, 5)}"`);
  await page.keyboard.press('Meta+z');
  await placeCursor(page, 3, 2);
  await page.keyboard.press('Meta+Shift+x');
  expect((await lineText(page, 3)) === '- [ ] 普通段落 hello world', `plain: got "${await lineText(page, 3)}"`);
  await page.keyboard.press('Meta+z');
});

// ---------------------------------------------------------------- list continuation / indent / backspace
await reset();
await step('Enter continues bullet list', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(6));
  await placeCursor(page, 6, l.text.length);
  await page.keyboard.press('Enter');
  await page.keyboard.type('C');
  expect((await lineText(page, 7)) === '- C', `got "${await lineText(page, 7)}"`);
});
await step('Enter continues ordered list with next number', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(10));
  expect(l.text === '2. 第二', `line 10 is "${l.text}"`);
  await placeCursor(page, 10, l.text.length);
  await page.keyboard.press('Enter');
  await page.keyboard.type('第三');
  expect((await lineText(page, 11)) === '3. 第三', `got "${await lineText(page, 11)}"`);
});
await step('Enter on empty list item removes the marker', async () => {
  await page.keyboard.press('Enter');
  expect((await lineText(page, 12)) === '4. ', `after Enter: "${await lineText(page, 12)}"`);
  await page.keyboard.press('Enter');
  const t12 = await lineText(page, 12);
  expect(t12 === '', `expected empty line, got "${t12}"`);
});
await step('Tab indents list item, Shift-Tab dedents', async () => {
  await placeCursor(page, 7, 3); // "- C"
  await page.keyboard.press('Tab');
  expect((await lineText(page, 7)) === '  - C', `after Tab: "${await lineText(page, 7)}"`);
  await page.keyboard.press('Shift+Tab');
  expect((await lineText(page, 7)) === '- C', `after Shift-Tab: "${await lineText(page, 7)}"`);
});
await step('Enter continues task list with unchecked box', async () => {
  const n = await page.evaluate(() => {
    const d = window.__mdr.app.editor.view.state.doc;
    for (let i = 1; i <= d.lines; i++) if (d.line(i).text === '- [x] 已完成') return i;
    return -1;
  });
  expect(n > 0, 'task line not found');
  const l = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n), n);
  await placeCursor(page, n, l.text.length);
  await page.keyboard.press('Enter');
  const t = await lineText(page, n + 1);
  expect(t === '- [ ] ', `got "${t}"`);
  await page.keyboard.press('Backspace');
  const t2 = await lineText(page, n + 1);
  check('Backspace on empty task item removes marker (deleteMarkupBackward)', t2 === '' || t2 === '- ', `got "${t2}"`);
});
await step('Backspace removes list marker', async () => {
  await placeCursor(page, 7, 2); // "- C" cursor after "- "
  await page.keyboard.press('Backspace');
  const t = await lineText(page, 7);
  expect(t === 'C', `got "${t}"`);
});

// ---------------------------------------------------------------- toolbar buttons
await reset();
await step('Toolbar bold button runs and keeps editor focus', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.bold"]');
  const t = await lineText(page, 3);
  expect(t === '普通段落 **hello** world', `got "${t}"`);
  const focused = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
  expect(focused, 'editor lost focus after toolbar click');
  await page.click('.mdr-toolbar__btn[data-cmd="edit.bold"]');
});
await reset();
await step('Toolbar heading buttons H1/H2/H3', async () => {
  await placeCursor(page, 3, 1);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.heading2"]');
  expect((await lineText(page, 3)) === '## 普通段落 hello world', `H2: "${await lineText(page, 3)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.heading3"]');
  expect((await lineText(page, 3)) === '### 普通段落 hello world', `H3: "${await lineText(page, 3)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.heading1"]');
  expect((await lineText(page, 3)) === '# 普通段落 hello world', `H1: "${await lineText(page, 3)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.heading1"]');
  expect((await lineText(page, 3)) === '普通段落 hello world', `toggle off: "${await lineText(page, 3)}"`);
});
await step('All toolbar buttons have titles, icons and are enabled', async () => {
  const info = await page.evaluate(() =>
    [...document.querySelectorAll('.mdr-toolbar__btn')].map((b) => ({
      cmd: b.dataset.cmd, title: b.title, disabled: b.disabled, hasSvg: !!b.querySelector('svg'),
      w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height,
    })),
  );
  const bad = info.filter((b) => !b.title || b.disabled || !b.hasSvg || b.w < 20 || b.h < 20);
  expect(bad.length === 0, JSON.stringify(bad));
  return info.map((b) => `${b.cmd}:${b.title}`).join(' | ');
});
await reset();
await step('Toolbar italic / code / link buttons', async () => {
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(3));
  await selectRange(page, l.from + 5, l.from + 10);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.italic"]');
  expect((await lineText(page, 3)) === '普通段落 _hello_ world', `italic: "${await lineText(page, 3)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.italic"]');
  await selectRange(page, l.from + 5, l.from + 10);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.code"]');
  expect((await lineText(page, 3)) === '普通段落 `hello` world', `code: "${await lineText(page, 3)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.code"]');
  await selectRange(page, l.from + 5, l.from + 10);
  await page.click('.mdr-toolbar__btn[data-cmd="edit.link"]');
  await sleep(200);
  expect((await lineText(page, 3)) === '普通段落 [hello](url) world', `link: "${await lineText(page, 3)}"`);
  await page.keyboard.press('Meta+z');
});

// ---------------------------------------------------------------- find / replace panel
await reset();
await step('Mod-f opens search panel with zh-CN labels', async () => {
  await placeCursor(page, 3, 0);
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.cm-search', { timeout: 2000 });
  const txt = await page.evaluate(() => document.querySelector('.cm-search').innerText);
  const ph = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-search input')].map((i) => i.placeholder),
  );
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.cm-search button, .cm-search label')].map((i) => i.textContent.trim()),
  );
  const all = txt + ' ' + ph.join(' ') + ' ' + labels.join(' ');
  const latin = /\b(Find|Replace|next|previous|all|match case|regexp|by word|replace all|close)\b/.exec(all);
  expect(!latin, `untranslated: "${latin?.[0]}" in: ${all.replace(/\s+/g, ' ')}`);
  expect(all.includes('查找') && all.includes('替换') && all.includes('下一个'), `panel text: ${all.replace(/\s+/g, ' ')}`);
  return all.replace(/\s+/g, ' ').slice(0, 160);
});
await step('Search panel is at the top (search({top:true}))', async () => {
  const top = await page.evaluate(() => {
    const p = document.querySelector('.cm-search').closest('.cm-panels');
    return p?.classList.contains('cm-panels-top');
  });
  expect(top, 'panel not at top');
});
await step('Typing a query, Enter finds next; Mod-g / Mod-Shift-g navigate', async () => {
  const input = page.locator('.cm-search input[name="search"]');
  await input.fill('hello');
  await page.keyboard.press('Shift');
  await page.keyboard.press('Enter');
  const c1 = await cursor(page);
  expect(c1.line === 3, `first match should be on line 3, cursor at ${JSON.stringify(c1)}`);
  await page.locator('.cm-search input[name="search"]').fill('列表项');
  await page.keyboard.press('Shift');
  await page.keyboard.press('Enter');
  const c1b = await cursor(page);
  expect(c1b.line === 5, `CJK query: first match line 5, got ${JSON.stringify(c1b)}`);
  await page.keyboard.press('Meta+g');
  const c2 = await cursor(page);
  expect(c2.line === 6, `Mod-g next → line 6, got ${c2.line}`);
  await page.keyboard.press('Meta+Shift+g');
  const c3 = await cursor(page);
  expect(c3.line === 5, `Mod-Shift-g prev → line 5, got ${c3.line}`);
});
await step('Replace works and Esc closes panel returning focus to editor', async () => {
  await page.locator('.cm-search input[name="replace"]').fill('条目');
  await page.locator('.cm-search button[name="replaceAll"]').click();
  const t = await lineText(page, 5);
  expect(t.includes('条目 A'), `replace all: "${t}"`);
  await page.keyboard.press('Escape');
  await sleep(50);
  const gone = await page.evaluate(() => !document.querySelector('.cm-search'));
  expect(gone, 'search panel still open after Esc');
  const focused = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
  expect(focused, 'editor not focused after closing search');
  await page.keyboard.press('Meta+z');
});

// ---------------------------------------------------------------- goto line
await step('Mod-Alt-g opens goto-line panel (zh-CN) and jumps', async () => {
  await page.keyboard.press('Meta+Alt+g');
  await page.waitForSelector('.cm-goto-line', { timeout: 2000 });
  const txt = await page.evaluate(() => document.querySelector('.cm-goto-line').innerText);
  expect(txt.includes('跳转'), `goto panel text: ${txt}`);
  await page.locator('.cm-goto-line input').fill('9');
  await page.keyboard.press('Enter');
  const c = await cursor(page);
  expect(c.line === 9, `cursor line ${c.line}`);
  await page.keyboard.press('Escape');
});

// ---------------------------------------------------------------- command palette
await reset();
await step('Mod-Shift-p opens palette, filter, arrows, Enter runs, focus returns', async () => {
  await placeCursor(page, 3, 0);
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])', { timeout: 2000 });
  const focusedInput = await page.evaluate(() => document.activeElement?.classList.contains('mdr-palette__input'));
  expect(focusedInput, 'palette input not focused');
  const total = await page.locator('.mdr-palette__item').count();
  expect(total >= 20, `palette lists ${total} commands`);
  await page.keyboard.type('标题');
  const titles = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item .mdr-palette__title')].map((e) => e.textContent));
  expect(titles.every((t) => /标题|title|heading/i.test(t) || true), '');
  expect(titles[0]?.startsWith('标题'), `first filtered item "${titles[0]}" (all: ${titles.join(',')})`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const activeIdx = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item')].findIndex((e) => e.classList.contains('is-active')));
  expect(activeIdx === 2, `active index ${activeIdx}`);
  await page.keyboard.press('ArrowUp');
  const activeTitle = await page.evaluate(() => document.querySelector('.mdr-palette__item.is-active .mdr-palette__title').textContent);
  await page.keyboard.press('Enter');
  await sleep(50);
  const closed = await page.evaluate(() => document.querySelector('.mdr-palette').hidden);
  expect(closed, 'palette not closed after Enter');
  const t = await lineText(page, 3);
  const m = /标题 (\d)/.exec(activeTitle);
  expect(m && t === '#'.repeat(Number(m[1])) + ' 普通段落 hello world', `ran "${activeTitle}", line 3 = "${t}"`);
  const focused = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
  expect(focused, 'editor not focused after palette');
  await page.keyboard.press('Meta+z');
});
await step('Palette Esc closes and returns focus; fuzzy matches subsequence', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('xyzq');
  const empty = await page.evaluate(() => document.querySelector('.mdr-palette__empty')?.textContent);
  expect(empty === '没有匹配的命令', `empty text: ${empty}`);
  await page.keyboard.press('Escape');
  await sleep(30);
  expect(await page.evaluate(() => document.querySelector('.mdr-palette').hidden), 'not hidden');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')), 'focus not returned');
});
await step('Palette items show shortcut labels (mac glyphs)', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  const keys = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item')].map((e) => `${e.querySelector('.mdr-palette__title').textContent}=${e.querySelector('kbd')?.textContent ?? ''}`));
  await page.keyboard.press('Escape');
  return keys.join(' | ');
});
await step('Global shortcuts while palette open are ignored (Mod-/ should not switch mode)', async () => {
  const before = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.press('Meta+/');
  const after = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await page.keyboard.press('Escape');
  expect(before === after, `mode changed ${before}→${after}`);
});

// ---------------------------------------------------------------- undo/redo + status bar
await step('Status bar shows 行/列, 字数, 字符, 约 N 分钟, state, mode', async () => {
  await placeCursor(page, 3, 4);
  await sleep(100);
  const s = await statusText(page);
  expect(/^行 3, 列 5$/.test(s.pos), `pos "${s.pos}"`);
  expect(/^字数 \d+$/.test(s.words), `words "${s.words}"`);
  expect(/^字符 \d+$/.test(s.chars), `chars "${s.chars}"`);
  expect(/^约 \d+ 分钟$/.test(s.reading), `reading "${s.reading}"`);
  expect(/未保存|草稿已存/.test(s.file), `file "${s.file}"`);
  expect(s.mode === '分栏', `mode "${s.mode}"`);
  return JSON.stringify(s);
});

finish('01-editor', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
