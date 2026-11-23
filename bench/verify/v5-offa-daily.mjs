// bench/verify/v5-offa-daily.mjs — verify-off-app JOB 3: daily use around the preview, switch OFF, candidate
// production build vs 0.1.1, same gestures. Every shortcut of the README's table pressed from the editor (a word
// selected on line 5 of medium.md) and from the body; the palette's command list; the toolbar; the outline of
// large.md (click entries, collapse); the status bar; persistence across a reload; a narrow window; IME in the editor.
//   MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-offa-daily.mjs [case|prefix* ...] [--list]
// SAME / DIFF per case with both observations. Global timeout 115 s: run it by prefix.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, runCases } from './v5-offa-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const MED = fs.readFileSync(path.join(ROOT, 'test-data/medium.md'), 'utf8');
const LARGE = fs.readFileSync(path.join(ROOT, 'test-data/large.md'), 'utf8');
const SMALL = fs.readFileSync(path.join(ROOT, 'test-data/small.md'), 'utf8');

const OBS = () => {
  const v = window.__mdr.app.editor.view;
  const s = v.state.selection.main;
  const t = v.state.doc.toString();
  const ae = document.activeElement;
  const root = document.querySelector('#app')?.firstElementChild;
  const toc = document.querySelector('.mdr-toc');
  return {
    len: t.length,
    hash: [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
    sel: [s.anchor, s.head],
    active: ae ? ae.tagName.toLowerCase() + '.' + String(ae.className).split(' ').filter((c) => c && !/focus/.test(c)).slice(0, 2).join('.') : null,
    root: root ? root.className : null,
    theme: document.documentElement.dataset.theme,
    toc: toc ? getComputedStyle(toc).display : null,
    palette: !!document.querySelector('.mdr-palette:not([hidden]), .mdr-palette.is-open'),
    search: !!document.querySelector('.cm-search, .cm-panel'),
    dialogs: [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent),
    toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent).filter((x) => !/预览可编辑/.test(x)),
    title: document.title,
    status: [...document.querySelectorAll('.mdr-statusbar__item')].map((e) => e.textContent).join(' | '),
    edTop: Math.round(document.querySelector('.cm-scroller')?.scrollTop ?? -1),
    pvTop: Math.round(document.querySelector('.mdr-preview')?.scrollTop ?? -1),
    sw: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
};
const load = async (page, text, name = 'daily.md') => { await page.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]); await sleep(900); };
const selectWord = (page) => page.evaluate(() => {
  const v = window.__mdr.app.editor.view; v.focus();
  const L = v.state.doc.line(5); v.dispatch({ selection: { anchor: L.from + 2, head: Math.min(L.to, L.from + 6) } });
});
const KEYS = ['Meta+s', 'Meta+Shift+s', 'Meta+/', 'Meta+Shift+p', 'Meta+Shift+o', 'Meta+Shift+l', 'Meta+b', 'Meta+i', 'Meta+e', 'Meta+k', 'Meta+1', 'Meta+3', 'Meta+6', 'Meta+0', 'Meta+Shift+x', 'Meta+f', 'Meta+g', 'Meta+Shift+g', 'Meta+Alt+g', 'Meta+z', 'Meta+Shift+z', 'Meta+a', 'Escape', 'F1', 'Alt+ArrowUp', 'Alt+Shift+ArrowDown', 'Meta+d', 'Meta+Enter', 'Tab', 'Shift+Tab', 'Meta+]', 'Meta+['];
const C = {};
for (const k of KEYS) {
  for (const from of ['editor', 'body']) {
    C[`key-${from}-${k}`] = async (page) => {
      await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('x', 'AbortError'); }; });
      await load(page, MED);
      await selectWord(page);
      if (from === 'editor') { await page.keyboard.type('Q'); await selectWord(page); }
      if (from === 'body') { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await sleep(100); }
      await page.keyboard.press(k);
      await sleep(500);
      const o1 = await page.evaluate(OBS);
      await page.keyboard.press('Escape');
      await sleep(250);
      return { o1, o2: await page.evaluate(OBS) };
    };
  }
}
for (const k of ['Meta+f', 'Meta+b', 'Meta+Shift+x', 'Meta+Alt+g', 'Meta+1', 'Meta+k', 'Meta+s', 'Meta+a', 'Space', 'End', 'PageDown', 'Meta+ArrowDown', 'Meta+/', 'Meta+Shift+p']) {
  C[`keypv-${k}`] = async (page) => {
    await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('x', 'AbortError'); }; });
    await load(page, MED);
    await page.evaluate(() => window.__mdr.app.registry.run('view.mode.preview'));
    await sleep(500);
    const pt = await page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')][3]; const r = p.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 6 }; });
    await page.mouse.click(pt.x, pt.y); await sleep(400);
    await page.keyboard.press(k);
    await sleep(600);
    const o1 = await page.evaluate(OBS);
    await page.keyboard.press('Escape'); await sleep(250);
    return { o1, o2: await page.evaluate(OBS) };
  };
}
C['palette-list'] = async (page) => {
  await page.keyboard.press('Meta+Shift+p'); await sleep(400);
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette li, .mdr-palette [role="option"]')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  return { items: items.filter((x) => !/预览可编辑/.test(x)), n: items.length };
};
C['toolbar-list'] = async (page) => ({ btns: await page.evaluate(() => [...document.querySelectorAll('.mdr-toolbar button, .mdr-toolbar [role="button"]')].map((b) => (b.dataset.cmd || '') + '|' + (b.title || b.textContent.trim()) + '|' + (b.getAttribute('aria-pressed') ?? '')).filter((x) => !/togglePreviewEdit/.test(x))) });
for (const cmd of ['view.cycleMode', 'view.toggleToc', 'view.toggleTheme', 'view.mode.edit', 'view.mode.preview', 'view.mode.split', 'file.exportHtml']) {
  C[`toolbar-click-${cmd}`] = async (page) => {
    await load(page, MED);
    const dl = page.waitForEvent('download', { timeout: 2500 }).then((d) => d.suggestedFilename()).catch(() => null);
    const ok = await page.evaluate((c) => { const b = document.querySelector(`.mdr-toolbar [data-cmd="${c}"]`); if (b) b.click(); return !!b; }, cmd);
    if (!ok) await page.evaluate((c) => window.__mdr.app.registry.run(c), cmd);
    await sleep(800);
    return { ok, o: await page.evaluate(OBS), dl: cmd === 'file.exportHtml' ? await dl : undefined };
  };
}
C['toc-large'] = async (page) => {
  await load(page, LARGE, 'large.md');
  await sleep(800);
  const n = await page.evaluate(() => document.querySelectorAll('.mdr-toc a, .mdr-toc li').length);
  const out = [];
  for (const k of [3, 40, 120, 7]) {
    const t = await page.evaluate((i) => { const a = [...document.querySelectorAll('.mdr-toc a, .mdr-toc li > *:first-child')][i]; if (!a) return null; a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2, t: a.textContent.slice(0, 30) }; }, k);
    if (!t) { out.push(null); continue; }
    await page.mouse.click(t.x, t.y); await sleep(1300);
    const o = await page.evaluate(OBS);
    out.push({ t: t.t, line: await page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; }), edTop: o.edTop, pvTop: o.pvTop, active: o.active });
  }
  return { n, out };
};
C['toc-collapse'] = async (page) => {
  await load(page, MED);
  const r = await page.evaluate(() => { const t = document.querySelector('.mdr-toc [aria-expanded], .mdr-toc .mdr-toc__toggle, .mdr-toc button'); if (!t) return null; t.click(); return { exp: t.getAttribute('aria-expanded'), vis: [...document.querySelectorAll('.mdr-toc a')].filter((a) => a.offsetParent).length }; });
  await sleep(300);
  return { r, vis: await page.evaluate(() => [...document.querySelectorAll('.mdr-toc a, .mdr-toc li')].filter((a) => a.offsetParent).length) };
};
C['status-numbers'] = async (page) => {
  await load(page, MED);
  const out = [];
  for (const [l, c] of [[1, 0], [40, 3], [200, 0]]) {
    await page.evaluate(([L, C2]) => { const v = window.__mdr.app.editor.view; v.focus(); const ln = v.state.doc.line(Math.min(L, v.state.doc.lines)); v.dispatch({ selection: { anchor: ln.from + Math.min(C2, ln.length) }, scrollIntoView: true }); }, [l, c]);
    await sleep(400);
    out.push((await page.evaluate(OBS)).status);
  }
  await page.keyboard.type('中文字'); await sleep(500);
  out.push((await page.evaluate(OBS)).status);
  return { out };
};
C['persist-reload'] = async (page) => {
  await load(page, SMALL);
  await page.keyboard.press('Meta+Shift+l'); await sleep(200);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press('Meta+Shift+o'); await sleep(200);
  await page.keyboard.press('Meta+/'); await sleep(300);
  const g = await page.evaluate(() => { const e = document.querySelector('.mdr-gutter'); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 100 }; });
  if (g) { await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x + 150, g.y, { steps: 6 }); await page.mouse.up(); await sleep(300); }
  const before = await page.evaluate(OBS);
  const ls = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k !== 'mdr.previewEdit').sort().map((k) => [k, localStorage.getItem(k)])));
  await page.reload();
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
  await sleep(1200);
  const after = await page.evaluate(OBS);
  return { ls, before: { root: before.root, theme: before.theme, toc: before.toc }, after: { root: after.root, theme: after.theme, toc: after.toc, split: await page.evaluate(() => document.querySelector('#app')?.firstElementChild?.style.getPropertyValue('--split')) } };
};
C['narrow'] = async (page) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await load(page, MED);
  await sleep(500);
  const o = await page.evaluate(OBS);
  const widths = await page.evaluate(() => [...document.querySelectorAll('.mdr-toolbar, .mdr-statusbar, .mdr-preview, .cm-editor, .mdr-toc')].map((e) => e.className.split(' ')[0] + ':' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  await page.keyboard.press('Meta+/'); await sleep(400);
  const o2 = await page.evaluate(OBS);
  return { o, widths, o2 };
};
C['ime-editor'] = async (page) => {
  await load(page, '# IME\n\n段落一\n');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await sleep(150);
  await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
  await sleep(150);
  await cdp.send('Input.insertText', { text: '中文' });
  await sleep(600);
  await cdp.detach();
  const o = await page.evaluate(OBS);
  return { text: await page.evaluate(() => window.__mdr.app.getText()), title: o.title, preview: await page.evaluate(() => document.querySelector('.mdr-preview').innerText.slice(0, 80)) };
};
C['multicursor-type'] = async (page) => {
  await load(page, 'a1\na2\na3\n');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press('Meta+Home');
  await page.keyboard.down('Alt'); await page.mouse.click(0, 0).catch(() => {}); await page.keyboard.up('Alt');
  await page.keyboard.press('Meta+Alt+ArrowDown').catch(() => {});
  await page.keyboard.press('Meta+Alt+ArrowDown').catch(() => {});
  await page.keyboard.type('X');
  await sleep(500);
  return { text: await page.evaluate(() => window.__mdr.app.getText()) };
};
C['goto-line'] = async (page) => {
  await load(page, LARGE, 'large.md');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press('Meta+Alt+g'); await sleep(300);
  await page.keyboard.type('1234'); await page.keyboard.press('Enter'); await sleep(1500);
  const o = await page.evaluate(OBS);
  return { line: await page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; }), edTop: o.edTop, pvTop: o.pvTop, active: o.active };
};
for (const [k, t] of Object.entries({ small: SMALL, medium: MED, tasks: '# T\n\n- [ ] a\n- [x] b\n\n<div class="note"><input type="checkbox"> raw</div>\n\n$x^2$ and $$y$$\n' })) {
  C[`export-${k}`] = async (page) => {
    await load(page, t, k + '.md');
    await sleep(500);
    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'));
    const d = await dl;
    const p = await d.path();
    const html = fs.readFileSync(p, 'utf8');
    const body = html.slice(html.indexOf('<body'));
    return { name: d.suggestedFilename(), len: html.length, bodyLen: body.length, bodyHash: [...body].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7), attrs: [...new Set(body.match(/ (data-[\w-]+|contenteditable|spellcheck|class="[^"]*(edit|mdr)[^"]*")/g) || [])].sort(), styleLen: (html.match(/<style[\s\S]*?<\/style>/g) || []).join('').length };
  };
}
// Every registered command (the palette's list) run once, from the editor with a word selected, then from the
// preview (a click on text): one observation per command. Pickers are stubbed to refuse.
for (const from of ['editor', 'preview']) {
  for (const half of [0, 1]) {
    C[`cmds-${from}-${half}`] = async (page) => {
      await page.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('x', 'AbortError'); }; window.showOpenFilePicker = async () => { throw new DOMException('x', 'AbortError'); }; });
      const ids = (await page.evaluate(() => window.__mdr.app.registry.list().map((c) => c.id))).filter((id) => !/togglePreviewEdit|file\.new|file\.open|exportHtml|mountAll/.test(id)).sort();
      const mine = ids.filter((_, i) => i % 2 === half);
      const out = {};
      for (const id of mine) {
        await load(page, MED);
        if (from === 'editor') await selectWord(page);
        else {
          const pt = await page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')][2]; if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 6 }; });
          if (pt) await page.mouse.click(pt.x, pt.y);
          await sleep(300);
        }
        await page.evaluate((c) => { void window.__mdr.app.registry.run(c); }, id);
        await sleep(450);
        const o = await page.evaluate(OBS);
        out[id] = { hash: o.hash, sel: o.sel, active: o.active, root: o.root, theme: o.theme, toc: o.toc, palette: o.palette, search: o.search, dialogs: o.dialogs, toasts: o.toasts, edTop: o.edTop, pvTop: o.pvTop };
        await page.keyboard.press('Escape'); await sleep(150);
        await page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-dialog__btn')) { if (/取消/.test(b.textContent)) b.click(); } });
        await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme; });
      }
      return out;
    };
  }
}
// The storage quota of the origin set to almost nothing (CDP): drafts cannot be written. What does the user see?
C['idb-quota'] = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  const origin = new URL(page.url()).origin;
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 2048 }).catch((e) => null);
  await load(page, SMALL);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('字'.repeat(40) + ' quota test');
  await sleep(2500);
  const o = await page.evaluate(OBS);
  await cdp.detach().catch(() => {});
  return { status: o.status, toasts: o.toasts, title: o.title, len: o.len };
};
C['unload-guard'] = async (page) => {
  await load(page, SMALL);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('dirty');
  await sleep(300);
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
  await page.close({ runBeforeUnload: true });
  await sleep(800);
  return { dialogs, closed: page.isClosed() };
};
C['print-media'] = async (page) => {
  await load(page, MED);
  await page.emulateMedia({ media: 'print' });
  await sleep(400);
  const r = await page.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); return cs.display + '/' + cs.visibility + '/' + Math.round(e.getBoundingClientRect().width); };
    return { toolbar: vis('.mdr-toolbar'), status: vis('.mdr-statusbar'), editor: vis('.cm-editor'), preview: vis('.mdr-preview'), toc: vis('.mdr-toc'), hint: vis('.mdr-preview__edit-hint'), firstBlock: document.querySelector('.mdr-preview .md-block')?.innerText.slice(0, 40) };
  });
  await page.emulateMedia({ media: 'screen' });
  return r;
};
C['system-dark'] = async (page) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
  await sleep(800);
  const t1 = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.mdr-preview')).color]);
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(500);
  const t2 = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
  return { t1, t2 };
};
const bad = await runCases(C, { timeoutMs: 115_000 });
process.exit(bad ? 1 : 0);
