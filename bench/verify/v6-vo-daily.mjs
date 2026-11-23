// bench/verify/v6-vo-daily.mjs — verify-off (0.2.0 stage 2f, round 5, rule L6): a REAL USER's day with 预览可编辑 OFF on a
// production build (no ?perf=1, no test hooks; DOM, mouse and keyboard only). Every step records whether the editing
// chunk (/assets/inlineEdit-*.js) was requested, what the source holds (read from CodeMirror's DOM tile), toasts,
// dialogs, the mode, and editing elements in the preview. Run it on the candidate and on 0.1.1 and compare the JSON.
//   node bench/verify/v6-vo-daily.mjs <port> [none|0] [outfile.json]
// Steps: type a document; tick boxes (also right after an edit); the three modes (toolbar and ⌘/); find and replace
// (CodeMirror's panel, replace all); the outline (⇧⌘O, a click on an entry); the theme (⇧⌘L); print (media print +
// beforeprint / afterprint); the palette (open, type, Esc); clicks / double click / drag / keys in the preview; drop a
// second file (answer 丢弃); open a third document through 打开 (⌘O, the picker returns an OPFS file); type, wait for
// the draft, reload, answer the draft question; scroll; a link click (popups counted).
// Exit 0 when the chunk was never requested and no editing element appeared; 1 otherwise; 3 global timeout (115 s).
// Writes only the outfile (give a path outside the tree).
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const port = process.argv[2] || '5480';
const storedArg = process.argv[3] || 'none';
const outFile = process.argv[4] || '';
const URL0 = `http://localhost:${port}/`;
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK_RE = /\/assets\/inlineEdit-[^/]*\.js/;
const DOC = [
  '# Daily use', '', 'First paragraph with **bold** words and a [link](https://example.com/x).', '',
  '## Tasks', '', '- [ ] alpha task', '- [ ] beta task', '- [x] gamma task', '',
  '> A quote paragraph.', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Inline $x^2$ math and $$y$$ more.', '',
  '```js', 'const a = 1;', '```', '', '## Last heading', '',
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i} with some words.` + NL),
].join(NL);
const SECOND = ['# Second doc', '', '- [ ] one', '- [ ] two', '', 'Second paragraph.', ''].join(NL);
const THIRD = ['# Third doc', '', 'Third text here.', '', '- [x] done', ''].join(NL);

const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
let code = 2;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((v) => {
    try { if (!sessionStorage.getItem('vo.init')) { sessionStorage.setItem('vo.init', '1'); if (v === 'none') localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } } catch {}
  }, storedArg);
  const page = await ctx.newPage();
  const chunkReqs = [], errors = [], popups = [];
  page.on('request', (r) => { if (CHUNK_RE.test(r.url())) chunkReqs.push(r.url().replace(/^[a-z]+:\/\/[^/]+/, '')); });
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  page.on('popup', (p) => { popups.push(p.url()); p.close().catch(() => {}); });
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
  const obs = () => page.evaluate(() => {
    const c = document.querySelector('.cm-content');
    const v = c && ((c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.rootView && c.cmView.rootView.view));
    const root = document.querySelector('#app')?.firstElementChild;
    return {
      src: v ? v.state.doc.toString() : null,
      mode: root ? [...root.classList].filter((k) => /mode|toc|theme|dark|light/.test(k)).join(' ') : null,
      theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className,
      toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
      dialogs: [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent),
      pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'absent',
      busy: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-busy') ?? null,
      ce: document.querySelectorAll('.mdr-preview [contenteditable]').length,
      editing: document.querySelectorAll('.mdr-preview .is-editing, .mdr-preview__edit-hint').length,
      checks: [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((x) => x.checked ? 1 : 0).join(''),
      sel: String(getSelection()).slice(0, 80),
      active: document.activeElement ? document.activeElement.nodeName + '.' + (document.activeElement.className || '').toString().split(' ')[0] : null,
      tags: [...document.querySelectorAll('script[src], link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')).filter((h) => /inlineEdit/.test(h)),
      res: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /inlineEdit/.test(n)).length,
      ls: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } })(),
    };
  });
  const steps = [];
  const step = async (name, fn, wait = 250) => {
    const n0 = chunkReqs.length;
    let err = null;
    try { await fn(); } catch (e) { err = String(e.message).slice(0, 120); }
    await sleep(wait);
    const o = await obs();
    steps.push({ name, chunk: chunkReqs.length - n0, err, ...o, src: o.src == null ? null : o.src.length + ':' + [...o.src].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7), srcTail: o.src == null ? null : o.src.slice(0, 40).replace(/\n/g, '⏎') });
  };
  const cmd = (c) => page.click(`[data-cmd="${c}"]`);
  const clickText = async (sel, text) => {
    const h = await page.evaluateHandle(([s, t]) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)) || null, [sel, text]);
    const el = h.asElement(); if (!el) throw new Error('no ' + sel + ' ' + text);
    await el.scrollIntoViewIfNeeded(); const bb = await el.boundingBox();
    await page.mouse.click(bb.x + Math.min(20, bb.width / 2), bb.y + bb.height / 2);
  };
  const drop = async (name, text) => {
    const dt = await page.evaluateHandle(([n, t]) => { const d = new DataTransfer(); d.items.add(new File([t], n, { type: 'text/markdown' })); return d; }, [name, text]);
    await page.dispatchEvent('.mdr-preview', 'dragenter', { dataTransfer: dt });
    await page.dispatchEvent('.mdr-preview', 'dragover', { dataTransfer: dt });
    await page.dispatchEvent('.mdr-preview', 'drop', { dataTransfer: dt });
  };
  const answer = async (label) => {
    for (let i = 0; i < 20; i++) {
      const ok = await page.evaluate((l) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l); if (b) b.click(); return !!b; }, label);
      if (ok) return true; await sleep(100);
    }
    return false;
  };

  await page.goto(URL0);
  await page.waitForSelector('.cm-content', { timeout: 30000 });
  await sleep(800);
  await step('boot', async () => {});
  await step('type-doc', async () => { await page.click('.cm-content'); await page.keyboard.press('Meta+A'); await page.keyboard.insertText(DOC); }, 900);
  await step('tick-alpha', async () => { await page.click('.mdr-preview input[type=checkbox] >> nth=0'); }, 500);
  await step('edit-then-tick', async () => {
    await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('x');
    await sleep(60); await page.click('.mdr-preview input[type=checkbox] >> nth=1');
  }, 600);
  await step('tick-again-200', async () => { await page.keyboard.type('y'); await sleep(200); await page.click('.mdr-preview input[type=checkbox] >> nth=1'); }, 600);
  await step('mode-edit', () => cmd('view.mode.edit'));
  await step('mode-preview', () => cmd('view.mode.preview'));
  await step('mode-split', () => cmd('view.mode.split'));
  await step('mode-key-x2', async () => { await page.click('.cm-content'); await page.keyboard.press('Meta+/'); await sleep(200); await page.keyboard.press('Meta+/'); await sleep(200); await page.keyboard.press('Meta+/'); }, 400);
  await step('find-replace', async () => {
    await page.click('.cm-content'); await page.keyboard.press('Meta+f'); await sleep(200);
    await page.fill('.cm-search input[name=search]', 'Filler');
    await page.fill('.cm-search input[name=replace]', 'Stuffing');
    await page.click('.cm-search button[name=replaceAll]');
    await sleep(100); await page.keyboard.press('Escape');
  }, 500);
  await step('outline-toggle', async () => { await page.keyboard.press('Meta+Shift+O'); await sleep(200); await page.keyboard.press('Meta+Shift+O'); }, 400);
  await step('outline-click', async () => { await clickText('.mdr-toc a, .mdr-toc li, .mdr-toc [data-line]', 'Last heading'); }, 500);
  await step('theme', async () => { await page.keyboard.press('Meta+Shift+L'); }, 300);
  await step('theme-back', () => cmd('view.toggleTheme'), 300);
  await step('print', async () => {
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => { dispatchEvent(new Event('beforeprint')); }); await sleep(200);
    await page.evaluate(() => { dispatchEvent(new Event('afterprint')); }); await page.emulateMedia({ media: 'screen' });
  }, 300);
  await step('palette', async () => { await page.keyboard.press('Meta+Shift+P'); await sleep(200); await page.keyboard.type('主题'); await sleep(150); await page.keyboard.press('Escape'); }, 300);
  await step('preview-click-para', () => clickText('.mdr-preview p', 'First paragraph'));
  await step('preview-dblclick', async () => { const el = page.locator('.mdr-preview p', { hasText: 'Stuffing paragraph 3 ' }).first(); await el.scrollIntoViewIfNeeded(); await el.dblclick({ position: { x: 10, y: 8 } }); });
  await step('preview-tripleclick', async () => { const el = page.locator('.mdr-preview blockquote p').first(); await el.click({ clickCount: 3 }); });
  await step('preview-drag', async () => {
    const a = await page.locator('.mdr-preview p', { hasText: 'Stuffing paragraph 1 ' }).first().boundingBox();
    const b = await page.locator('.mdr-preview p', { hasText: 'Stuffing paragraph 4 ' }).first().boundingBox();
    if (!a || !b) throw new Error('no para');
    await page.mouse.move(a.x + 5, a.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 40, b.y + 6, { steps: 6 }); await page.mouse.up();
  });
  await step('preview-keys', async () => { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.type('Q'); await page.keyboard.press('Backspace'); await page.keyboard.press('Meta+C'); });
  await step('preview-selall-type', async () => { await clickText('.mdr-preview p', 'Stuffing paragraph 9'); await page.keyboard.press('Meta+A'); await page.keyboard.type('Z'); await page.keyboard.press('Enter'); });
  await step('link-click', async () => { await clickText('.mdr-preview a', 'link'); }, 600);
  await step('scroll-end', async () => { await page.mouse.move(900, 400); await page.mouse.wheel(0, 4000); }, 500);
  await step('drop-second', async () => { await drop('second.md', SECOND); await sleep(300); await answer('丢弃'); }, 900);
  await step('tick-second', async () => { await page.click('.mdr-preview input[type=checkbox] >> nth=1'); }, 500);
  await step('open-third', async () => {
    await page.evaluate(async (t) => {
      const root = await navigator.storage.getDirectory(); const h = await root.getFileHandle('third.md', { create: true });
      const w = await h.createWritable(); await w.write(t); await w.close();
      window.showOpenFilePicker = async () => [h];
    }, THIRD);
    await page.click('.cm-content'); await page.keyboard.press('Meta+O'); await sleep(400); await answer('丢弃');
  }, 900);
  await step('type-third', async () => { await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('Draft words.'); }, 2500);
  await step('reload', async () => { await page.reload({ timeout: 15000 }); await page.waitForSelector('.cm-content', { timeout: 20000 }); }, 1500);
  await step('draft-answer', async () => { await answer('恢复'); }, 800);
  await step('new-doc', async () => { await cmd('file.new'); await sleep(300); await answer('丢弃'); }, 600);
  await step('type-new', async () => { await page.click('.cm-content'); await page.keyboard.type('# New' + NL + NL + '- [ ] t' + NL); }, 700);
  await step('tick-new', async () => { await page.click('.mdr-preview input[type=checkbox] >> nth=0'); }, 500);
  await step('idle-3s', async () => { await sleep(3000); }, 200);
  const anyChunk = chunkReqs.length > 0 || steps.some((s) => s.ce > 0 || s.editing > 0 || s.tags.length || s.res);
  for (const s of steps) console.log(`${s.name.padEnd(20)} chunk=${s.chunk} src=${s.src} pressed=${s.pressed} ls=${s.ls} ce=${s.ce} ed=${s.editing} checks=${s.checks} toasts=${JSON.stringify(s.toasts)} dialogs=${JSON.stringify(s.dialogs)}${s.err ? ' ERR=' + s.err : ''}`);
  console.log(`chunkReqs=${JSON.stringify(chunkReqs)} errors=${JSON.stringify(errors)} popups=${popups.length}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ port, storedArg, steps, chunkReqs, errors, popups }, null, 1));
  console.log(anyChunk ? 'FAIL editing code touched' : 'PASS no editing chunk, no editing element');
  code = anyChunk ? 1 : 0;
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  clearTimeout(wd);
  await browser.close();
  process.exit(code);
}
