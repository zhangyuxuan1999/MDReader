// bench/verify/r5-pl-noload.mjs — proto-lazy (0.2.0 stage 2f, rule L6): with 预览可编辑 OFF a whole session of daily use
// never requests the editing chunk (src/preview/inlineEdit.ts and what only it needs), and no listener, timer or element
// of the editing code exists. Also prints the event-listener counts of window, document, the preview's pane and its
// scroller (CDP DOMDebugger.getEventListeners), so the same run on 0.1.1 and on the last candidate shows what the
// editing code used to add.
//   MDR_URL=http://localhost:5472/ node bench/verify/r5-pl-noload.mjs [--user] [--stored 0|1|none]
//     default: ?perf=1 (test hooks), stored mdr.previewEdit = '0'; --user: no ?perf=1, nothing stored (a real user;
//     driven through the DOM and the keyboard only). Works on the dev server too (MDR_URL=http://localhost:5462/).
// Daily use: type a document into the editor, the three modes (toolbar and ⌘/), clicks / double click / drag in the
// preview, a task box ticked in the preview, keys in the preview, copy, find (⌘F), the outline (⌘⇧O and a click on an
// entry), the theme, print (media print + beforeprint / afterprint), a second document, scrolling.
// Editing requests: production /assets/inlineEdit-*.js; dev /src/preview/{inlineEdit,serialize,fidelity}.ts, turndown.
// Exit 0: no editing request and no editing element; 1 otherwise; 3 global timeout (100 s). Writes nothing.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const user = args.includes('--user');
const storedArg = args.includes('--stored') ? args[args.indexOf('--stored') + 1] : (user ? 'none' : '0');
const base = process.env.MDR_URL || `http://localhost:${process.env.MDR_PORT || '5472'}/`;
const url = base + (user ? '' : '?perf=1');
const EDIT_RE = /\/assets\/inlineEdit-[^/]*\.js|\/src\/preview\/(inlineEdit|serialize|fidelity)\.ts|\/deps\/turndown/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const NL = String.fromCharCode(10);
const DOC = [
  '# Daily use', '', 'First paragraph with **bold** words and a [link](https://example.com/x).', '',
  '## Tasks', '', '- [ ] alpha task', '- [ ] beta task', '- [x] gamma task', '',
  '> A quote paragraph.', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Inline $x^2$ math.', '',
  '```js', 'const a = 1;', '```', '', '## Last heading', '', ...Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i} with some words.` + NL),
].join(NL);

const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, 100_000);
const browser = await chromium.launch({ headless: true });
let code = 2;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((v) => {
    try { if (v === 'none') localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } catch {}
  }, storedArg);
  const page = await ctx.newPage();
  const editReqs = [], errors = [];
  page.on('request', (r) => { if (EDIT_RE.test(r.url())) editReqs.push(r.url().replace(/^[a-z]+:\/\/[^/]+/, '')); });
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  const steps = [];
  const step = async (name, fn) => { const n0 = editReqs.length; await fn(); await sleep(150); steps.push(`${name}:${editReqs.length - n0}`); };
  await page.goto(url);
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  await sleep(800);
  await step('type-doc', async () => {
    await page.click('.cm-content');
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.insertText(DOC);
    await sleep(1200);
  });
  const btn = (cmd) => page.click(`[data-cmd="${cmd}"]`);
  await step('mode-preview', () => btn('view.mode.preview'));
  await step('mode-split', () => btn('view.mode.split'));
  await step('click-para', async () => {
    const p = page.locator('.mdr-preview .md-block p').first();
    await p.click({ position: { x: 30, y: 8 } });
  });
  await step('dblclick-word', () => page.locator('.mdr-preview .md-block p').first().dblclick({ position: { x: 40, y: 8 } }));
  await step('drag-select', async () => {
    const bs = await page.locator('.mdr-preview .md-block').evaluateAll((els) => els.slice(0, 3).map((e) => { const r = e.getBoundingClientRect(); return [r.left + 20, r.top + 10]; }));
    await page.mouse.move(bs[0][0], bs[0][1]); await page.mouse.down(); await page.mouse.move(bs[2][0], bs[2][1], { steps: 5 }); await page.mouse.up();
  });
  await step('copy', () => page.keyboard.press(`${mod}+c`));
  if (process.env.R5PL_DEBUG) console.log('DEBUG', await page.evaluate(() => ({ boxes: document.querySelectorAll('.mdr-preview input[type="checkbox"]').length, blocks: document.querySelectorAll('.mdr-preview .md-block').length, text: document.querySelector('.cm-content').innerText.slice(0, 200) })));
  await step('tick-task', async () => {
    const box = page.locator('.mdr-preview input[type="checkbox"]').first();
    await box.click({ timeout: 8000 });
    await sleep(500);
    await page.locator('.mdr-preview input[type="checkbox"]').nth(1).click({ timeout: 8000 });
    await sleep(500);
  });
  await step('keys-in-preview', async () => {
    await page.locator('.mdr-preview .md-block p').nth(1).click({ position: { x: 20, y: 8 } });
    for (const k of ['ArrowDown', 'End', 'a', 'Backspace', 'Enter', `${mod}+z`, `${mod}+Shift+z`, 'Escape', 'Home', 'PageDown', 'PageUp']) await page.keyboard.press(k);
  });
  await step('cycle-mode', async () => { await page.keyboard.press(`${mod}+/`); await sleep(300); await page.keyboard.press(`${mod}+/`); await sleep(300); await page.keyboard.press(`${mod}+/`); });
  await step('mode-edit', () => btn('view.mode.edit'));
  await step('mode-split2', () => btn('view.mode.split'));
  await step('find', async () => {
    await page.click('.cm-content');
    await page.keyboard.press(`${mod}+f`);
    await sleep(200);
    await page.keyboard.type('Filler');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  });
  await step('outline', async () => {
    await page.keyboard.press(`${mod}+Shift+o`);
    await sleep(400);
    const e = page.locator('.mdr-toc a, .mdr-toc [role="treeitem"], .mdr-toc li').nth(1);
    if (await e.count()) await e.click({ timeout: 3000 }).catch(() => e.evaluate((x) => x.click()));
    await sleep(300);
    await page.keyboard.press(`${mod}+Shift+o`);
  });
  await step('theme', async () => { await page.keyboard.press(`${mod}+Shift+l`); await sleep(200); await page.keyboard.press(`${mod}+Shift+l`); });
  await step('print', async () => {
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => { window.dispatchEvent(new Event('beforeprint')); window.dispatchEvent(new Event('afterprint')); });
    await page.emulateMedia({ media: 'screen' });
  });
  await step('scroll', async () => {
    const box = await page.locator('.mdr-preview').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 600); await sleep(60); }
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -600); await sleep(60); }
  });
  await step('second-doc', async () => {
    const hooks = await page.evaluate(() => !!(window.__mdr && window.__mdr.app));
    if (hooks) await page.evaluate((t) => window.__mdr.app.loadText(t, 'second.md'), DOC.replace('Daily use', 'Second document'));
    else { await page.click('.cm-content'); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(DOC.replace('Daily use', 'Second document')); }
    await sleep(1000);
  });
  await step('type-editor', async () => { await page.click('.cm-content'); await page.keyboard.type('more text'); await sleep(500); });
  await sleep(1500);
  // listeners (CDP) and editing leftovers
  const cdp = await ctx.newCDPSession(page);
  const count = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    if (!result.objectId) return null;
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
    return listeners.length;
  };
  const listeners = {
    window: await count('window'),
    document: await count('document'),
    pane: await count('document.querySelector(".mdr-preview").parentElement'),
    scroller: await count('document.querySelector(".mdr-preview")'),
  };
  const dom = await page.evaluate((re) => {
    const root = document.querySelector('.mdr-preview');
    return {
      hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
      capture: document.querySelectorAll('.mdr-preview__edit-capture').length,
      ce: root.querySelectorAll('[contenteditable]').length,
      editing: root.querySelectorAll('.is-editing').length,
      pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null,
      stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'throws'; } })(),
      resources: performance.getEntriesByType('resource').filter((e) => new RegExp(re).test(e.name)).length,
    };
  }, EDIT_RE.source);
  const ok = editReqs.length === 0 && dom.hint === 0 && dom.capture === 0 && dom.ce === 0 && dom.editing === 0 && dom.resources === 0;
  console.log(JSON.stringify({ url, stored: storedArg, ok, editReqs: editReqs.length, editFirst: editReqs.slice(0, 3), steps: steps.join(' '), listeners, dom, errors }));
  code = ok ? 0 : 1;
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack.split(NL).slice(0, 4).join(' | ') : String(err));
  code = 2;
} finally {
  clearTimeout(wd);
  await browser.close();
}
process.exit(code);
