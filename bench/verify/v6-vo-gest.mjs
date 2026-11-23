// bench/verify/v6-vo-gest.mjs — verify-off (0.2.0 stage 2f, round 5): daily gestures in the preview of a REAL USER (no
// ?perf=1, no hooks), 预览可编辑 OFF (nothing stored), on one production build. The document arrives by a dropped file
// (the user's path). After every gesture: the source (CodeMirror's DOM tile), CodeMirror's selection, the window's
// selection, the focused element, both scroll positions, toasts, popups, the boxes' states, editing elements, and —
// after a copy — what the (headless, in-memory) clipboard holds as text/plain and text/html, byte for byte.
//   node bench/verify/v6-vo-gest.mjs <port> <outfile.json> [group ...]      groups: A B C D E F (default all)
//   node bench/verify/v6-vo-gest.mjs cmp <cand.json> <base.json>             prints SAME / DIFF per gesture
// Global timeout 115 s. Starts no server. Writes only the outfile.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === 'cmp') {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const IGN = new Set(['t']);
  let same = 0, diff = 0;
  for (const g of Object.keys(a.res)) {
    const x = a.res[g], y = b.res[g];
    if (!y) { console.log(`MISSING ${g}`); continue; }
    const norm = (v) => JSON.stringify(v)?.replace(/localhost:[0-9]+/g, 'localhost:PORT');
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !IGN.has(k) && norm(x[k]) !== norm(y[k]));
    if (!keys.length) { same++; continue; }
    diff++;
    console.log(`DIFF ${g}: ` + keys.map((k) => `${k}: cand=${JSON.stringify(x[k])?.slice(0, 200)} base=${JSON.stringify(y[k])?.slice(0, 200)}`).join(' | '));
  }
  console.log(`same=${same} diff=${diff}; errors cand=${JSON.stringify(a.errors)} base=${JSON.stringify(b.errors)}; chunk cand=${JSON.stringify(a.chunk)} base=${JSON.stringify(b.chunk)}`);
  process.exit(diff ? 1 : 0);
}
const port = process.argv[2];
const outFile = process.argv[3];
const groups = process.argv.slice(4).length ? process.argv.slice(4) : ['A', 'B', 'C', 'D', 'E', 'F'];
const DOC = [
  '# Gesture doc', '', 'First paragraph with **bold** words, `code` and a [link](https://example.com/x) here.', '',
  'Second paragraph that is long enough to wrap across the preview pane at least once or twice for the selection gestures.', '',
  '## Tasks', '', '- [ ] alpha task', '- [ ] beta task', '  - [ ] nested task', '- [x] gamma task', '',
  '1. one', '2. two', '', '> A quote paragraph with words.', '', '| a | b |', '|---|---|', '| cell one | cell two |', '',
  'Inline $x^2$ math and more.', '', '$$', 'E=mc^2', '$$', '', '```js', 'const a = 1;', 'const b = 2;', '```', '',
  '![img](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)', '', '## Last heading', '',
  ...Array.from({ length: 24 }, (_, i) => `Filler paragraph ${i} with some words.` + NL),
].join(NL);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const res = {}, errors = [], chunk = [];
try {
  const fresh = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
    await ctx.addInitScript(() => { try { localStorage.removeItem('mdr.previewEdit'); } catch {} });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    page.on('request', (r) => { if (/inlineEdit-/.test(r.url())) chunk.push(r.url()); });
    page.__popups = 0;
    page.on('popup', (p) => { page.__popups++; p.close().catch(() => {}); });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('.cm-content', { timeout: 30000 });
    await sleep(600);
    const dt = await page.evaluateHandle((t) => { const d = new DataTransfer(); d.items.add(new File([t], 'gest.md', { type: 'text/markdown' })); return d; }, DOC);
    for (const ev of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent('.mdr-preview', ev, { dataTransfer: dt });
    await page.waitForFunction(() => /Last heading/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 });
    await sleep(700);
    // clipboard sentinel, so a copy that writes nothing shows as the sentinel
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL')).catch(() => {});
    return { ctx, page };
  };
  const obs = async (page, clip) => {
    const o = await page.evaluate(() => {
      const c = document.querySelector('.cm-content');
      const v = c && ((c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.rootView && c.cmView.rootView.view));
      const ae = document.activeElement;
      const sc = document.querySelector('.mdr-preview')?.closest('[class*=scroll]') || document.querySelector('.mdr-preview')?.parentElement;
      return {
        src: v ? v.state.doc.toString() : null,
        cmSel: v ? v.state.selection.ranges.map((r) => r.from + '-' + r.to).join(',') : null,
        cmFocus: v ? v.hasFocus : null,
        sel: String(getSelection()).slice(0, 120),
        active: ae ? ae.nodeName + (ae.className && typeof ae.className === 'string' ? '.' + ae.className.split(' ')[0] : '') : null,
        pTop: Math.round((sc && sc.scrollTop) || 0),
        eTop: Math.round(document.querySelector('.cm-scroller')?.scrollTop || 0),
        toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
        checks: [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((x) => (x.checked ? 1 : 0)).join(''),
        ce: document.querySelectorAll('.mdr-preview [contenteditable=true], .mdr-preview [contenteditable=""]').length,
        menus: [...document.querySelectorAll('.mdr-menu, .mdr-popover, [role=menu], .mdr-palette')].filter((e) => e.offsetParent).length,
        mode: [...(document.querySelector('#app')?.firstElementChild?.classList || [])].filter((k) => /mode/.test(k)).join(' '),
      };
    });
    if (clip) {
      await sleep(100);
      o.clip = await page.evaluate(async () => {
        try {
          const items = await navigator.clipboard.read();
          const out = {};
          for (const it of items) for (const t of it.types) out[t] = await (await it.getType(t)).text();
          return out;
        } catch (e) { return { err: String(e.message).slice(0, 80) }; }
      });
      await page.evaluate(() => navigator.clipboard.writeText('SENTINEL')).catch(() => {});
    }
    o.popups = page.__popups;
    return o;
  };
  const box = async (page, sel, text, nth = 0) => {
    const loc = text ? page.locator(sel, { hasText: text }).nth(nth) : page.locator(sel).nth(nth);
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    const b = await loc.boundingBox();
    if (!b) throw new Error('no box ' + sel + ' ' + text);
    return b;
  };
  const at = async (page, sel, text, dx = 8, dy = null, opts = {}) => { const b = await box(page, sel, text); await page.mouse.click(b.x + dx, b.y + (dy ?? Math.min(10, b.height / 2)), opts); };
  const range = (page, a, b) => page.evaluate(([sa, ta, sb, tb]) => {
    const pick = (s, t) => [...document.querySelectorAll(s)].find((e) => !t || e.textContent.includes(t));
    const x = pick(sa, ta), y = pick(sb, tb); if (!x || !y) return false;
    const r = document.createRange(); r.setStart(x.firstChild || x, 0); r.setEnd(y.lastChild || y, (y.lastChild || y).nodeType === 3 ? (y.lastChild || y).length : (y.lastChild || y).childNodes.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  }, [a[0], a[1], b[0], b[1]]);
  const edType = async (page, s) => { await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type(s); };
  const lineEnd = async (page, text) => { // caret at the end of the editor line holding text
    await page.evaluate((t) => {
      const c = document.querySelector('.cm-content');
      const v = (c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.rootView && c.cmView.rootView.view);
      const i = v.state.doc.toString().indexOf(t); const ln = v.state.doc.lineAt(i);
      v.focus(); v.dispatch({ selection: { anchor: ln.to }, scrollIntoView: true });
    }, text);
  };
  const G = {
    A: {
      'click-para-start': (p) => at(p, '.mdr-preview p', 'First paragraph', 2),
      'click-mid-word': (p) => at(p, '.mdr-preview p', 'Second paragraph', 60),
      'dblclick-word': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); },
      'triple-para': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.click(b.x + 30, b.y + 8, { clickCount: 3 }); },
      'triple-li': async (p) => { const b = await box(p, '.mdr-preview li', 'one'); await p.mouse.click(b.x + 10, b.y + 6, { clickCount: 3 }); },
      'shift-click': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 20); await at(p, '.mdr-preview p', 'Second paragraph', 80, null, { modifiers: ['Shift'] }); },
      'drag-two-paras': async (p) => { const a = await box(p, '.mdr-preview p', 'First paragraph'); const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.move(a.x + 30, a.y + 8); await p.mouse.down(); await p.mouse.move(b.x + 90, b.y + 8, { steps: 8 }); await p.mouse.up(); },
      'drag-into-code': async (p) => { const a = await box(p, '.mdr-preview p', 'Inline'); const b = await box(p, '.mdr-preview pre', 'const a'); await p.mouse.move(a.x + 5, a.y + 6); await p.mouse.down(); await p.mouse.move(b.x + 40, b.y + 10, { steps: 8 }); await p.mouse.up(); },
      'code-selall': async (p) => { await at(p, '.mdr-preview pre', 'const a', 20); await p.keyboard.press('Meta+A'); },
      'arrows': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 40); await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Shift+ArrowRight'); },
      'pgdown-end-home': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 40); await p.keyboard.press('PageDown'); await sleep(150); await p.keyboard.press('End'); await sleep(150); await p.keyboard.press('Home'); },
      'tab': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 40); await p.keyboard.press('Tab'); },
      'shift-tab': async (p) => { await p.keyboard.press('Shift+Tab'); },
      'space': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Space'); },
      'type-in-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.type('zq'); },
      'enter-bs-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Enter'); await p.keyboard.press('Backspace'); },
    },
    B: {
      'copy-dbl': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); await p.keyboard.press('Meta+C'); },
      'copy-triple': async (p) => { const b = await box(p, '.mdr-preview p', 'First paragraph'); await p.mouse.click(b.x + 30, b.y + 8, { clickCount: 3 }); await p.keyboard.press('Meta+C'); },
      'copy-list-table': async (p) => { await range(p, ['.mdr-preview li', 'alpha'], ['.mdr-preview td', 'cell two']); await p.keyboard.press('Meta+C'); },
      'copy-math': async (p) => { await range(p, ['.mdr-preview p', 'Inline'], ['.mdr-preview pre', 'const a']); await p.keyboard.press('Meta+C'); },
      'copy-code': async (p) => { await range(p, ['.mdr-preview pre', 'const a'], ['.mdr-preview pre', 'const a']); await p.keyboard.press('Meta+C'); },
      'copy-selall-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+A'); await p.keyboard.press('Meta+C'); },
      'copy-editor-all': async (p) => { await p.click('.cm-content'); await p.keyboard.press('Meta+A'); await p.keyboard.press('Meta+C'); },
      'copy-editor-line-blur': async (p) => { await lineEnd(p, 'Second paragraph'); await p.keyboard.press('Shift+Home'); await p.evaluate(() => document.activeElement.blur()); await p.keyboard.press('Meta+C'); },
      'copy-across-panes': async (p) => { await range(p, ['.mdr-preview p', 'First paragraph'], ['.cm-line', 'Second paragraph']); await p.keyboard.press('Meta+C'); },
      'copy-preview-after-editor-focus': async (p) => { await range(p, ['.mdr-preview p', 'First paragraph'], ['.mdr-preview p', 'Second paragraph']); await p.evaluate(() => { const c = document.querySelector('.cm-content'); c.focus({ preventScroll: true }); }); await p.keyboard.press('Meta+C'); },
      'copy-preview-blurred': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await range(p, ['.mdr-preview li', 'alpha'], ['.mdr-preview li', 'gamma']); await p.evaluate(() => document.activeElement.blur()); await p.keyboard.press('Meta+C'); },
      'copy-editor-focused-preview-range': async (p) => { await p.click('.cm-content'); await range(p, ['.mdr-preview blockquote p', 'quote'], ['.mdr-preview td', 'cell one']); await p.keyboard.press('Meta+C'); },
      'cut-preview': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); await p.keyboard.press('Meta+X'); },
      'paste-preview': async (p) => { await p.evaluate(() => navigator.clipboard.writeText('PASTED')); await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+V'); },
      'copy-btn-code': async (p) => { const b = await box(p, '.mdr-preview pre', 'const a'); await p.mouse.move(b.x + b.width - 20, b.y + 10); await sleep(200); const btn = p.locator('.mdr-preview [data-mdr-ui]').first(); if (await btn.count()) await btn.click({ timeout: 2000 }).catch(() => {}); },
    },
    C: {
      'tick': (p) => p.click('.mdr-preview input[type=checkbox] >> nth=0'),
      'tick-after-type-0': async (p) => { await edType(p, 'a'); await p.click('.mdr-preview input[type=checkbox] >> nth=1'); },
      'tick-after-type-50': async (p) => { await edType(p, 'b'); await sleep(50); await p.click('.mdr-preview input[type=checkbox] >> nth=1'); },
      'tick-after-type-150': async (p) => { await edType(p, 'c'); await sleep(150); await p.click('.mdr-preview input[type=checkbox] >> nth=0'); },
      'tick-after-type-400': async (p) => { await edType(p, 'd'); await sleep(400); await p.click('.mdr-preview input[type=checkbox] >> nth=3'); },
      'tick-after-line-edit': async (p) => { await lineEnd(p, 'beta task'); await p.keyboard.type('X'); await sleep(30); await p.click('.mdr-preview input[type=checkbox] >> nth=1'); },
      'tick-after-enter-in-line': async (p) => { await lineEnd(p, 'alpha task'); await p.keyboard.press('Enter'); await p.keyboard.type('- [ ] new'); await sleep(20); await p.click('.mdr-preview input[type=checkbox] >> nth=0'); },
      'tick-after-delete-above': async (p) => { await lineEnd(p, 'Tasks'); await p.keyboard.press('Shift+Home'); await p.keyboard.press('Backspace'); await sleep(20); await p.click('.mdr-preview input[type=checkbox] >> nth=2'); },
      'tick-nested': (p) => p.click('.mdr-preview input[type=checkbox] >> nth=3'),
      'tab-space-box': async (p) => { await at(p, '.mdr-preview h2', 'Tasks', 4); await p.keyboard.press('Tab'); await p.keyboard.press('Space'); },
      'click-task-label': (p) => at(p, '.mdr-preview li', 'gamma task', 60),
      'dbl-box': async (p) => { const b = await box(p, '.mdr-preview input[type=checkbox]', null); await p.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2); },
      'tick-undo': async (p) => { await p.click('.mdr-preview input[type=checkbox] >> nth=0'); await sleep(200); await p.click('.cm-content'); await p.keyboard.press('Meta+Z'); },
    },
    D: {
      'link-click': (p) => at(p, '.mdr-preview a', 'link', 6),
      'link-meta-click': (p) => at(p, '.mdr-preview a', 'link', 6, null, { modifiers: ['Meta'] }),
      'link-middle': (p) => at(p, '.mdr-preview a', 'link', 6, null, { button: 'middle' }),
      'ctx-para': (p) => at(p, '.mdr-preview p', 'Second paragraph', 40, null, { button: 'right' }),
      'ctx-link': (p) => at(p, '.mdr-preview a', 'link', 6, null, { button: 'right' }),
      'ctx-img': async (p) => { const b = await box(p, '.mdr-preview img', null); await p.mouse.click(b.x + 1, b.y + 1, { button: 'right' }); },
      'drag-sel-to-editor': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); const e = await box(p, '.cm-line', 'Last heading'); await p.mouse.move(b.x + 30, b.y + 8); await p.mouse.down(); await p.mouse.move(e.x + 40, e.y + 6, { steps: 10 }); await p.mouse.up(); },
      'drag-link-to-editor': async (p) => { const b = await box(p, '.mdr-preview a', 'link'); const e = await box(p, '.cm-line', 'Last heading'); await p.mouse.move(b.x + 6, b.y + 5); await p.mouse.down(); await p.mouse.move(e.x + 40, e.y + 6, { steps: 10 }); await p.mouse.up(); },
      'click-heading': (p) => at(p, '.mdr-preview h2', 'Last heading', 20),
      'click-math': async (p) => { const b = await box(p, '.mdr-preview .md-math, .mdr-preview .katex', null); await p.mouse.click(b.x + 3, b.y + 5); },
      'dbl-math': async (p) => { const b = await box(p, '.mdr-preview .md-math, .mdr-preview .katex', null); await p.mouse.dblclick(b.x + 3, b.y + 5); },
      'triple-cell': async (p) => { const b = await box(p, '.mdr-preview td', 'cell one'); await p.mouse.click(b.x + 10, b.y + 6, { clickCount: 3 }); },
      'click-img': async (p) => { const b = await box(p, '.mdr-preview img', null); await p.mouse.click(b.x + 1, b.y + 1); },
    },
    E: {
      'type-then-click-preview': async (p) => { await edType(p, 'w'); await at(p, '.mdr-preview p', 'Second paragraph', 40); },
      'click-preview-then-undo': async (p) => { await edType(p, 'u'); await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+Z'); },
      'find-from-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+F'); },
      'esc-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Escape'); },
      'mode-key-from-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+/'); },
      'wheel-then-click': async (p) => { await p.mouse.move(900, 400); await p.mouse.wheel(0, 900); await sleep(400); await p.mouse.click(900, 400); },
      'bold-from-preview': async (p) => { const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); await p.keyboard.press('Meta+B'); },
      'heading-key-from-preview': async (p) => { await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.press('Meta+2'); },
      'backspace-preview': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 40); await p.keyboard.press('Backspace'); await p.keyboard.press('Delete'); },
      'selall-type': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 40); await p.keyboard.press('Meta+A'); await p.keyboard.type('Z'); },
      'toc-click': async (p) => { await p.keyboard.press('Meta+Shift+O'); await sleep(300); const t = p.locator('.mdr-toc a, .mdr-toc li', { hasText: 'Last heading' }).first(); if (await t.count()) await t.click({ timeout: 2000 }); },
    },
    F: {
      'preview-mode-click': async (p) => { await p.click('[data-cmd="view.mode.preview"]'); await sleep(300); await at(p, '.mdr-preview p', 'Second paragraph', 40); },
      'preview-mode-type': async (p) => { await p.click('[data-cmd="view.mode.preview"]'); await sleep(300); await at(p, '.mdr-preview p', 'Second paragraph', 40); await p.keyboard.type('k'); },
      'preview-mode-tick': async (p) => { await p.click('[data-cmd="view.mode.preview"]'); await sleep(300); await p.click('.mdr-preview input[type=checkbox] >> nth=1'); },
      'preview-mode-dbl-copy': async (p) => { await p.click('[data-cmd="view.mode.preview"]'); await sleep(300); const b = await box(p, '.mdr-preview p', 'Second paragraph'); await p.mouse.dblclick(b.x + 30, b.y + 8); await p.keyboard.press('Meta+C'); },
      'edit-mode-back-split-click': async (p) => { await p.click('[data-cmd="view.mode.edit"]'); await sleep(300); await p.click('[data-cmd="view.mode.split"]'); await sleep(400); await at(p, '.mdr-preview p', 'First paragraph', 30); },
      'toggle-key-off-state': async (p) => { await at(p, '.mdr-preview p', 'First paragraph', 30); await p.keyboard.press('Escape'); },
    },
  };
  for (const g of groups) {
    let cur = await fresh();
    for (const [name, fn] of Object.entries(G[g])) {
      if (g !== 'C' && g !== 'F' && Object.keys(res).length && /^(copy|cut|paste|drag|link|ctx|type|enter|backspace|selall|bold|heading|click-preview|find|mode|toc|preview)/.test(name)) { await cur.ctx.close(); cur = await fresh(); }
      if (g === 'F') { await cur.ctx.close(); cur = await fresh(); }
      let err = null;
      try { await fn(cur.page); } catch (e) { err = String(e.message).split(NL)[0].slice(0, 100); }
      await sleep(450);
      const clip = /copy|cut/.test(name);
      const o = await obs(cur.page, clip);
      o.err = err;
      res[g + ':' + name] = o;
      await cur.page.keyboard.press('Escape').catch(() => {});
    }
    await cur.ctx.close();
  }
  fs.writeFileSync(outFile, JSON.stringify({ port, res, errors, chunk }, null, 1));
  console.log(`done ${Object.keys(res).length} gestures; errors=${errors.length}; chunk=${chunk.length}; gesture errors=${Object.entries(res).filter(([, o]) => o.err).map(([k, o]) => k + ':' + o.err).join(' ; ')}`);
} finally {
  clearTimeout(KILL);
  await browser.close();
}
