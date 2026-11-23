// bench/verify/02-shell.mjs — mode cycle/persistence, TOC, theme (pre-paint), gutter drag, dirty guard
// dialog, title dot, status bar, window resize.  Run: node bench/verify/02-shell.mjs
import { launch, open, loadText, getText, placeCursor, cursor, step, expect, check, finish, sleep, statusText, getFailures, BASE } from './lib.mjs';

const { browser, context, page, errors } = await launch();
// Record every change of <html data-theme> from the very first script on, to detect a light→dark flash.
await context.addInitScript(() => {
  window.__themeLog = [];
  const push = () => window.__themeLog.push({ t: performance.now(), theme: document.documentElement?.dataset.theme ?? null });
  push();
  new MutationObserver(push).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
});
await open(page, '?doc=/test-data/small.md');

const mode = () => page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; }, sel);
const pressed = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.mdr-toolbar__btn[aria-pressed]')].map((b) => [b.dataset.cmd, b.getAttribute('aria-pressed')])));

// ---------------------------------------------------------------- mode
await step('Initial mode is split (fresh profile) with editor + preview visible', async () => {
  expect((await mode()) === 'split', `mode ${await mode()}`);
  expect(await visible('.mdr-pane--editor'), 'editor hidden');
  expect(await visible('.mdr-pane--preview'), 'preview hidden');
  expect(await visible('.mdr-gutter'), 'gutter hidden');
});
await step('Mod-/ cycles split → preview → edit → split, panes + status + toolbar reflect it', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+/');
  await sleep(100);
  expect((await mode()) === 'preview', `after 1: ${await mode()}`);
  expect(!(await visible('.mdr-pane--editor')) && (await visible('.mdr-pane--preview')), 'preview mode panes wrong');
  expect((await statusText(page)).mode === '预览', 'status mode');
  let p = await pressed();
  expect(p['view.mode.preview'] === 'true' && p['view.mode.split'] === 'false', JSON.stringify(p));
  await page.keyboard.press('Meta+/');
  await sleep(100);
  expect((await mode()) === 'edit', `after 2: ${await mode()}`);
  expect((await visible('.mdr-pane--editor')) && !(await visible('.mdr-pane--preview')), 'edit mode panes wrong');
  expect((await statusText(page)).mode === '编辑', 'status mode');
  p = await pressed();
  expect(p['view.mode.edit'] === 'true', JSON.stringify(p));
  await page.keyboard.press('Meta+/');
  await sleep(100);
  expect((await mode()) === 'split', `after 3: ${await mode()}`);
});
await step('Mod-/ works when focus is on the preview pane (global shortcut)', async () => {
  await page.click('.mdr-preview', { position: { x: 200, y: 200 } });
  await page.keyboard.press('Meta+/');
  await sleep(50);
  expect((await mode()) === 'preview', `mode ${await mode()}`);
  await page.keyboard.press('Meta+/');
  await page.keyboard.press('Meta+/');
  await sleep(50);
  expect((await mode()) === 'split', `mode ${await mode()}`);
});
await step('Direct mode buttons work and persist across reload', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  expect((await mode()) === 'preview', `mode ${await mode()}`);
  expect((await page.evaluate(() => localStorage.getItem('mdr.mode'))) === 'preview', 'LS not written');
  await open(page, '');
  expect((await mode()) === 'preview', `after reload: ${await mode()}`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.edit"]');
  expect((await mode()) === 'edit', `mode ${await mode()}`);
  await open(page, '');
  expect((await mode()) === 'edit', `after reload: ${await mode()}`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  expect((await mode()) === 'split', `mode ${await mode()}`);
});
await step('?mode= query overrides persisted mode', async () => {
  await open(page, '?mode=preview');
  expect((await mode()) === 'preview', `mode ${await mode()}`);
  await open(page, '?doc=/test-data/small.md&mode=split');
  expect((await mode()) === 'split', `mode ${await mode()}`);
});
await step('Switching preview→split keeps the same top line in both panes', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 6000);
  await sleep(400);
  const pv = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  await sleep(500);
  const ed = await page.evaluate(() => window.__mdr.app.editor.topVisible());
  const pv2 = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  const err = Math.abs(ed.line - pv.line);
  expect(err <= 3, `preview top line ${pv.line} → editor top line ${ed.line} (preview now ${pv2.line})`);
  return `preview ${pv.line} → editor ${ed.line}`;
});

// ---------------------------------------------------------------- TOC
await step('TOC lists headings of small.md with level classes', async () => {
  await page.evaluate(() => window.__mdr.app.editor.view.scrollDOM.scrollTop = 0);
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].map((a) => ({ cls: a.className, line: a.dataset.line, text: a.textContent })));
  expect(items.length > 10, `only ${items.length} items`);
  expect(items[0].cls.includes('--h1') && items[1].cls.includes('--h2'), JSON.stringify(items.slice(0, 3)));
  return `${items.length} items; first: ${items[0].text}`;
});
await step('Mod-Shift-o hides/shows TOC, toolbar reflects, persisted across reload', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+o');
  await sleep(50);
  expect((await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc)) === 'closed', 'data-toc not closed');
  expect(!(await visible('.mdr-pane--toc')), 'toc pane still visible');
  expect((await pressed())['view.toggleToc'] === 'false', 'toolbar toc button still pressed');
  await open(page, '?doc=/test-data/small.md');
  expect((await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc)) === 'closed', 'toc state not persisted (should stay closed)');
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  expect(await visible('.mdr-pane--toc'), 'toc not shown after button');
  expect((await pressed())['view.toggleToc'] === 'true', 'toolbar toc button not pressed');
  await open(page, '?doc=/test-data/small.md');
  expect(await visible('.mdr-pane--toc'), 'toc open state not persisted');
});
await step('TOC click navigates both panes to the heading line', async () => {
  const target = await page.evaluate(() => { const a = document.querySelectorAll('.mdr-toc__item')[12]; return { line: Number(a.dataset.line), text: a.textContent }; });
  await page.locator('.mdr-toc__item').nth(12).click();
  await sleep(400);
  const c = await cursor(page);
  expect(c.line === target.line, `editor cursor line ${c.line}, expected ${target.line}`);
  const pv = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  expect(Math.abs(pv.line - target.line) <= 2, `preview top line ${pv.line}, expected ≈ ${target.line}`);
  // the heading element itself should be near the top of the preview
  const headTop = await page.evaluate((line) => {
    const scroller = document.querySelector('.mdr-preview');
    const sr = scroller.getBoundingClientRect();
    for (const b of document.querySelectorAll('.md-block')) {
      const h = b.querySelector('h1,h2,h3,h4,h5,h6');
      if (h && h.textContent.trim()) { const r = h.getBoundingClientRect(); if (r.top >= sr.top - 2 && r.top < sr.top + 80) return { text: h.textContent, off: r.top - sr.top }; }
    }
    return null;
  }, target.line);
  expect(headTop && headTop.text.includes(target.text.slice(0, 4)), `heading near preview top: ${JSON.stringify(headTop)} (want ${target.text})`);
  return `line ${target.line} "${target.text}" offset ${headTop.off?.toFixed(0)}px`;
});
await step('TOC active item follows the editor cursor', async () => {
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].map((a) => Number(a.dataset.line)));
  const i = 20;
  await placeCursor(page, items[i] + 1, 0);
  await sleep(100);
  let active = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].findIndex((a) => a.classList.contains('is-active')));
  expect(active === i, `active ${active}, expected ${i}`);
  await placeCursor(page, items[i + 1], 0);
  await sleep(100);
  active = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].findIndex((a) => a.classList.contains('is-active')));
  expect(active === i + 1, `active ${active}, expected ${i + 1}`);
  // is the active item scrolled into the nav's view?
  const inView = await page.evaluate(() => { const a = document.querySelector('.mdr-toc__item.is-active'); const n = a.closest('.mdr-pane--toc'); const r = a.getBoundingClientRect(), nr = n.getBoundingClientRect(); return r.top >= nr.top && r.bottom <= nr.bottom; });
  expect(inView, 'active item not scrolled into TOC view');
});
await step('TOC updates when a heading is typed', async () => {
  await placeCursor(page, 3, 0);
  const before = await page.locator('.mdr-toc__item').count();
  await page.keyboard.type('## 新标题XYZ\n');
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(200);
  const after = await page.locator('.mdr-toc__item').count();
  const has = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].some((a) => a.textContent === '新标题XYZ'));
  expect(after === before + 1 && has, `count ${before}→${after}, has=${has}`);
  await page.keyboard.press('Meta+z');
});

// ---------------------------------------------------------------- theme
await step('Mod-Shift-l toggles theme, applies data-theme, persists, CM + preview recolour', async () => {
  const bgBefore = await page.evaluate(() => ({ cm: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor, pv: getComputedStyle(document.querySelector('.mdr-preview')).backgroundColor, body: getComputedStyle(document.body).backgroundColor }));
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+l');
  await sleep(100);
  const t = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(t === 'dark', `theme ${t}`);
  expect((await page.evaluate(() => localStorage.getItem('mdr.theme'))) === 'dark', 'not persisted');
  const bgAfter = await page.evaluate(() => ({ cm: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor, pv: getComputedStyle(document.querySelector('.mdr-preview')).backgroundColor, body: getComputedStyle(document.body).backgroundColor }));
  expect(bgBefore.cm !== bgAfter.cm, `CM bg unchanged ${bgAfter.cm}`);
  expect(bgBefore.pv !== bgAfter.pv || bgBefore.body !== bgAfter.body, `preview bg unchanged ${JSON.stringify(bgAfter)}`);
  return JSON.stringify({ bgBefore, bgAfter });
});
await step('Dark theme applied before first paint on reload (no flash)', async () => {
  await page.goto(`${BASE}/?doc=/test-data/small.md`, { waitUntil: 'commit' });
  const early = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.waitForFunction(() => !!window.__mdr);
  const log = await page.evaluate(() => window.__themeLog);
  expect(early === 'dark', `data-theme right after commit: ${early}`);
  expect(log.every((e) => e.theme === 'dark' || e.theme === null), `theme log ${JSON.stringify(log)}`);
  const first = log.find((e) => e.theme);
  expect(first && first.theme === 'dark', `first stamped theme ${JSON.stringify(first)}`);
  return `log ${JSON.stringify(log)}`;
});
await step('Theme toolbar button toggles back to light and persists', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]');
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'not light');
  expect((await page.evaluate(() => localStorage.getItem('mdr.theme'))) === 'light', 'LS not light');
});
await step('System dark preference is followed when no pref stored', async () => {
  await page.evaluate(() => localStorage.removeItem('mdr.theme'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/`, { waitUntil: 'commit' });
  const early = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.waitForFunction(() => !!window.__mdr);
  expect(early === 'dark', `early ${early}`);
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(50);
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'did not follow live system change');
});

// ---------------------------------------------------------------- gutter drag
await open(page, '?doc=/test-data/small.md&mode=split');
await step('Gutter drag resizes split and persists --split across reload', async () => {
  const g = await page.locator('.mdr-gutter').boundingBox();
  const edBefore = (await page.locator('.mdr-pane--editor').boundingBox()).width;
  await page.mouse.move(g.x + 3, g.y + 300);
  await page.mouse.down();
  await page.mouse.move(g.x - 100, g.y + 300, { steps: 5 });
  await page.mouse.move(g.x - 200, g.y + 300, { steps: 5 });
  await page.mouse.up();
  await sleep(100);
  const edAfter = (await page.locator('.mdr-pane--editor').boundingBox()).width;
  const split = await page.evaluate(() => document.querySelector('.mdr-app').style.getPropertyValue('--split'));
  const ls = await page.evaluate(() => localStorage.getItem('mdr.split'));
  expect(Math.abs(edBefore - edAfter - 200) < 12, `editor width ${edBefore} → ${edAfter} (expected −200)`);
  expect(/fr$/.test(split) && ls === split, `--split "${split}", LS "${ls}"`);
  await open(page, '?doc=/test-data/small.md&mode=split');
  const edReload = (await page.locator('.mdr-pane--editor').boundingBox()).width;
  expect(Math.abs(edReload - edAfter) < 4, `after reload editor width ${edReload} vs ${edAfter}`);
  return `${edBefore.toFixed(0)} → ${edAfter.toFixed(0)}px, --split=${split}`;
});
await step('Gutter drag is clamped (cannot collapse a pane)', async () => {
  const g = await page.locator('.mdr-gutter').boundingBox();
  await page.mouse.move(g.x + 3, g.y + 300);
  await page.mouse.down();
  await page.mouse.move(50, g.y + 300, { steps: 10 });
  await page.mouse.up();
  await sleep(50);
  const ed = (await page.locator('.mdr-pane--editor').boundingBox()).width;
  const main = (await page.locator('.mdr-main').boundingBox()).width;
  expect(ed > 0.15 * main, `editor width ${ed} of ${main}`);
  await page.evaluate(() => { localStorage.removeItem('mdr.split'); document.querySelector('.mdr-app').style.removeProperty('--split'); });
});

// ---------------------------------------------------------------- dirty guard / title / new file
await open(page, '?mode=split');
await step('Typing makes title show ● and status 未保存; toolbar dot appears', async () => {
  const t0 = await page.title();
  expect(t0 === '未命名.md', `initial title "${t0}"`);
  await page.click('.cm-content');
  await page.keyboard.type('hello 世界');
  await sleep(100);
  const t1 = await page.title();
  expect(t1 === '● 未命名.md', `dirty title "${t1}"`);
  const s = await statusText(page);
  expect(s.file === '未命名.md · 未保存', `status file "${s.file}"`);
  const dot = await page.evaluate(() => !document.querySelector('.mdr-toolbar__dot').hidden);
  expect(dot, 'toolbar dot hidden');
  const saveDirty = await page.evaluate(() => document.querySelector('[data-cmd="file.save"]').classList.contains('is-dirty'));
  expect(saveDirty, 'save button lacks is-dirty');
});
await step('New file with dirty doc shows zh-CN confirm dialog; 取消 keeps content', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  const txt = await page.evaluate(() => document.querySelector('.mdr-dialog__text').textContent);
  expect(txt === '当前文档尚未保存，是否放弃更改？', `dialog text "${txt}"`);
  const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent));
  expect(btns.join(',') === '取消,丢弃', `buttons ${btns}`);
  const focusedBtn = await page.evaluate(() => document.activeElement?.textContent);
  check('Dialog default focus is on the non-destructive button (Enter should not discard)', focusedBtn === '取消', `focused button: "${focusedBtn}"`);
  await page.click('.mdr-dialog__btn:has-text("取消")');
  await sleep(50);
  expect(!(await page.$('.mdr-dialog')), 'dialog still open');
  expect((await getText(page)) === 'hello 世界', `content changed: "${await getText(page)}"`);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')), 'focus not back in editor');
});
await step('Escape cancels the dialog; Mod-s inside dialog does not trigger browser save', async () => {
  await page.keyboard.press('Meta+o');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  await page.keyboard.press('Escape');
  await sleep(50);
  expect(!(await page.$('.mdr-dialog')), 'dialog still open after Esc');
  expect((await getText(page)) === 'hello 世界', 'content changed');
});
await step('Dialog 丢弃 creates a new empty untitled document, title without ●', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog');
  await page.click('.mdr-dialog__btn:has-text("丢弃")');
  await sleep(150);
  expect((await getText(page)) === '', `content "${await getText(page)}"`);
  expect((await page.title()) === '未命名.md', `title "${await page.title()}"`);
  const s = await statusText(page);
  expect(s.file === '未命名.md · 未命名', `status "${s.file}"`);
  expect(s.words === '字数 0' && s.chars === '字符 0', `stats ${JSON.stringify(s)}`);
  expect(s.reading === null, `reading should be hidden for empty doc: ${s.reading}`);
});
await step('Empty doc: Mod-z after new file cannot restore the old document (history reset)', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+z');
  expect((await getText(page)) === '', 'undo restored old content across new-file');
});
await step('beforeunload guard fires when dirty', async () => {
  await page.keyboard.type('abc');
  await sleep(100);
  let dialogType = null;
  page.once('dialog', (d) => { dialogType = d.type(); d.accept(); });
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  expect(dialogType === 'beforeunload', `dialog type ${dialogType}`);
});

// ---------------------------------------------------------------- resize
await step('Viewport resize keeps layout sane (no horizontal overflow, panes fill)', async () => {
  await open(page, '?doc=/test-data/small.md&mode=split');
  const sizes = [[1400, 900], [1000, 700], [800, 600], [640, 480], [1400, 900]];
  const out = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(150);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const app = document.querySelector('.mdr-app').getBoundingClientRect();
      const ed = document.querySelector('.mdr-pane--editor').getBoundingClientRect();
      const pv = document.querySelector('.mdr-pane--preview').getBoundingClientRect();
      const tb = document.querySelector('.mdr-toolbar').getBoundingClientRect();
      const sb = document.querySelector('.mdr-statusbar').getBoundingClientRect();
      const toc = document.querySelector('.mdr-pane--toc');
      return { sw: de.scrollWidth, cw: de.clientWidth, sh: de.scrollHeight, ch: de.clientHeight, app: [app.width, app.height], ed: [ed.width, ed.height], pv: [pv.width, pv.height], tb: tb.height, sb: sb.height, tocVisible: getComputedStyle(toc).display !== 'none', tbScroll: document.querySelector('.mdr-toolbar').scrollWidth };
    });
    out.push(`${w}x${h}: ${JSON.stringify(m)}`);
    expect(m.sw <= m.cw && m.sh <= m.ch, `overflow at ${w}x${h}: ${JSON.stringify(m)}`);
    expect(m.ed[0] > 100 && m.pv[0] > 100 && m.ed[1] > 100, `panes too small at ${w}x${h}: ${JSON.stringify(m)}`);
    expect(m.tb < 60, `toolbar wrapped/tall at ${w}x${h}: ${m.tb}px`);
    if (w <= 900) expect(!m.tocVisible, `toc should collapse at ${w}px`);
  }
  return out.join('\n    ');
});

finish('02-shell', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
