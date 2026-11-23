// bench/verify/ux/13-recent-altclick.mjs — (a) recent-files dropdown clipped by the toolbar chip's
// overflow:hidden (legacy backend, no fakes: the menu always contains at least 打开文件…); (b) Alt+click
// on heading / quote / code / table / nested list with the real (percent-encoded) anchor href;
// (c) palette focus return + hover; (d) theme button state; (e) external link attrs.
// Run: node bench/verify/ux/13-recent-altclick.mjs
import { launch, open, loadText, cursor, lineText, step, expect, check, finish, sleep, getFailures } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const { browser, context, page, errors } = await launch();
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await open(page, '?mode=split');
const lineOf = (needle) => page.evaluate((n) => { const d = window.__mdr.app.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text.startsWith(n)) return i; return -1; }, needle);

// ---------------------------------------------------------------- recent menu clipping
await step('Recent-files dropdown is actually visible and clickable (not clipped by .mdr-toolbar__file overflow:hidden)', async () => {
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent', { timeout: 2000 });
  await sleep(100);
  const info = await page.evaluate(() => {
    const ul = document.querySelector('.mdr-recent');
    const li = ul.querySelector('.mdr-recent__item');
    const r = li.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const chip = li.closest('.mdr-toolbar__file');
    const cr = chip.getBoundingClientRect();
    return {
      liRect: [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(0)),
      chipRect: [cr.x, cr.y, cr.width, cr.height].map((n) => +n.toFixed(0)),
      chipOverflow: getComputedStyle(chip).overflow,
      hitTarget: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : null,
      hitIsMenu: !!hit?.closest('.mdr-recent'),
      checkVisibility: li.checkVisibility?.({ visibilityProperty: true, contentVisibilityAuto: true }),
    };
  });
  await page.screenshot({ path: `${OUT}/recent-menu-legacy-open.png`, clip: { x: 900, y: 0, width: 500, height: 140 } });
  // Real mouse click attempt with a short timeout
  let clicked = 'ok';
  try {
    await page.click('.mdr-recent__item', { timeout: 2500 });
  } catch (e) {
    clicked = e.message.split('\n')[0];
  }
  expect(info.hitIsMenu, `elementFromPoint at the menu item centre is ${info.hitTarget}; li rect ${info.liRect}, chip rect ${info.chipRect} (overflow ${info.chipOverflow}); click: ${clicked}`);
  return JSON.stringify(info);
});
await page.keyboard.press('Escape');
await page.mouse.click(600, 400);

// ---------------------------------------------------------------- Alt+click precision
const DOC = `# 一\n\n[去二](#二)\n\n${Array.from({ length: 120 }, (_, i) => `段落 ${i}`).join('\n\n')}\n\n## 二\n\n> 引用一行\n> 引用二行\n\n\`\`\`js\nlet a = 1;\nlet b = 2;\n\`\`\`\n\n| h | v |\n|---|---|\n| r1 | x |\n| r2 | y |\n\n- 甲\n  - 乙\n- [ ] 父任务\n  - [ ] 子任务一\n  - [x] 子任务二\n\n尾段。\n`;
await loadText(page, DOC, 'alt.md');
await step('Alt+click on heading / quote / code / table row / nested list item moves the cursor to the right line', async () => {
  const href = await page.evaluate(() => document.querySelector('.mdr-preview a[href^="#"]').getAttribute('href'));
  await page.locator(`.mdr-preview a[href="${href}"]`).click();
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
    ['p:has-text("尾段")', '尾段。', 'last paragraph'],
  ];
  const out = [];
  for (const [sel, expectedText, label] of targets) {
    const want = await lineOf(expectedText);
    try {
      const loc = page.locator(`.mdr-preview ${sel}`).last();
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

// ---------------------------------------------------------------- palette focus return / hover
await step('Palette opened via toolbar button (focus on button) → Esc returns focus somewhere useful', async () => {
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  const before = await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.press('Escape');
  await sleep(50);
  const after = await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className);
  const inEditor = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
  check('Esc from a palette opened with focus on the preview (body) returns focus to the editor', inEditor, `before ${before} → after ${after}`);
  // subsequent Mod-b should hit the editor now if focus went there
  return `before ${before} → after ${after}`;
});
await step('Palette: hovering an item makes it the active target (mouse + keyboard consistency)', async () => {
  await page.evaluate(() => window.__mdr.app.editor.view.focus());
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('标题');
  const box = await page.locator('.mdr-palette__item').nth(3).boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await sleep(100);
  const active = await page.evaluate(() => document.querySelector('.mdr-palette__item.is-active .mdr-palette__title')?.textContent);
  const hovered = await page.evaluate(() => document.querySelectorAll('.mdr-palette__item')[3].querySelector('.mdr-palette__title').textContent);
  await page.keyboard.press('Escape');
  check('Hovered palette item becomes is-active', active === hovered, `active "${active}", hovered "${hovered}"`);
});

// ---------------------------------------------------------------- theme button reflects state
await step('Theme toolbar button reflects the current theme (aria-pressed / icon change)', async () => {
  const before = await page.evaluate(() => { const b = document.querySelector('[data-cmd="view.toggleTheme"]'); return { pressed: b.getAttribute('aria-pressed'), title: b.title, svg: b.querySelector('svg')?.outerHTML.length }; });
  await page.click('[data-cmd="view.toggleTheme"]');
  await sleep(60);
  const after = await page.evaluate(() => { const b = document.querySelector('[data-cmd="view.toggleTheme"]'); return { pressed: b.getAttribute('aria-pressed'), title: b.title, svg: b.querySelector('svg')?.outerHTML.length, theme: document.documentElement.dataset.theme }; });
  await page.click('[data-cmd="view.toggleTheme"]');
  check('Theme button changes state (aria-pressed or icon) when theme flips', before.pressed !== after.pressed || before.svg !== after.svg, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  return `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
});

// ---------------------------------------------------------------- external link attrs + relative toast
await loadText(page, '[外](https://example.com/a) [相对](./b.md) [邮件](mailto:a@b.c)\n', 'links.md');
await step('External links have target=_blank rel=noopener; relative link shows toast; mailto not blocked', async () => {
  const attrs = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  const ext = attrs[0];
  expect(ext.target === '_blank' && /noopener/.test(ext.rel), JSON.stringify(attrs));
  await page.locator('.mdr-preview a[href="./b.md"]').click();
  await sleep(100);
  const t = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
  expect(t.includes('暂不支持打开相对链接'), `toasts ${t}`);
  return JSON.stringify(attrs);
});

finish('13-recent-altclick', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
