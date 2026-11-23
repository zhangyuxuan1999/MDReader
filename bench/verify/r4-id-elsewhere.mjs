// bench/verify/r4-id-elsewhere.mjs — fix-session-d (round 4, item 2: CHA-2, P-F amended, P-G). A click waits for its
// block (a giant paragraph whose HTML mounts only after the giant settle at natural timing; or, with MDR_DELAY, a small
// document with the slow-worker hook of v3-ses-preview.mjs after a session wrote X); during the wait the user goes
// elsewhere and types QQ there. Ways: a click into the editor pane, ⌘F and typing in the search field, an outline
// entry, a toolbar button, a click on another preview block, a click on empty preview space, a document replaced by a
// drop, a modal question (⌘N on a dirty document); and Tab, which is a key for the preview (U4 queues it: the wait
// stays wanted). Checks: the focus stays where the user put it; nothing typed there reaches the waiting block; the
// toast 预览尚未更新完，刚才的输入没有写入 appears exactly when queued text was discarded (`-pre`: Z typed right after
// the click, before going elsewhere).
// Run: MDR_PORT=5466 [MDR_DELAY=900] node bench/verify/r4-id-elsewhere.mjs [case-prefix ...]
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, pointOf, waitSession, load } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const DELAY = Number(process.env.MDR_DELAY ?? 0);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 400_000), B.close);
const { page } = B;
const TOAST = '预览尚未更新完，刚才的输入没有写入';
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}
const N = 400;
const GIANT = 'MARKER start ' + Array.from({ length: N }, (_, i) => `$a_{${i}}$ and`).join(' ') + ' end.';
const SMALL = 'MARKER start words here end.';
const BODY = DELAY ? SMALL : GIANT;
const DOC = '# Head one\n\nTop para.\n\n' + BODY + '\n\nEnd para.\n\n## Head two\n\nLast para.\n';
const markerLine = (src) => src.split('\n').find((l) => l.startsWith('MARK')) ?? '';
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return 'none';
  if (a.closest('.cm-search, .cm-panel')) return 'search';
  if (a.closest('.cm-editor')) return 'editor';
  if (a.closest('[aria-modal="true"], dialog')) return 'dialog';
  if (a.classList.contains('mdr-preview__edit-capture')) return 'capture';
  if (a.closest('.mdr-preview .is-editing')) return 'session';
  if (a.closest('.mdr-toc')) return 'toc';
  if (a.closest('.mdr-toolbar')) return 'toolbar';
  return a.tagName.toLowerCase();
});

/** [name, go elsewhere (returns nothing), what to check] — want(v, ctx): { ok, detail }. */
const WAYS = [
  ['editor-click', async () => {
    const e = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(0); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
    await page.mouse.click(e.x, e.y);
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: 0 } }); });
  }, (v, c) => ({ ok: v.src.startsWith('QQ') && c.act === 'editor', where: 'editor' })],
  // the search field, opened in the editor pane before the gesture (see `setup`), clicked into during the wait
  ['search-field', async () => {
    const p = await page.evaluate(() => { const i = document.querySelector('.cm-search input, .cm-panel input'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; });
    if (!p) throw new Error('no search field');
    await page.mouse.click(p.x, p.y);
  }, (v, c) => ({ ok: c.act === 'search' && c.searchValue.includes('QQ') && !v.src.includes('QQ') && !v.editing, where: 'search' }), 'search'],
  // ⌘F while the preview holds the focus (a session, or the capture element of a wait) opens no search: App routes no
  // shortcut from a text field, and in a session ⌘F is editor-only — so it is no way of going elsewhere; the wait
  // stays wanted and the keys after it are written at the click, as in a session
  ['cmd-f-wanted', async () => { await page.keyboard.press('Meta+f'); await sleep(150); },
    (v, c) => ({ ok: markerLine(v.src).startsWith(c.pre ? 'MARKZQQER' : 'MARKQQER'), where: c.act, wanted: true })],
  ['outline', async () => {
    const p = await page.evaluate(() => { const a = Array.from(document.querySelectorAll('.mdr-toc__item')).find((x) => x.textContent.includes('Head two')); if (!a) return null; const r = a.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
    if (!p) throw new Error('no outline entry on screen');
    await page.mouse.click(p.x, p.y);
  }, (v, c) => ({ ok: !v.editing && markerLine(v.src) === c.marker0 && c.act !== 'capture', where: c.act + (v.src.includes('QQ') ? ' (QQ in the source where the focus went)' : '') })],
  ['toolbar', async () => {
    const p = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-toolbar__btn')).find((x) => /加粗|Bold/i.test(x.title) && x.getBoundingClientRect().width > 0); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (!p) throw new Error('no toolbar bold button');
    await page.mouse.click(p.x, p.y);
  }, (v, c) => ({ ok: !v.editing && c.act === 'editor' && v.src.includes('**QQ**') && !markerLine(v.src).startsWith('MARKQQ') && !markerLine(v.src).startsWith('MARKZ'), where: c.act })],
  ['other-block', async () => { const p = await pointOf(page, 'End para', 1); await page.mouse.click(p.x, p.y); await waitSession(page); },
    (v, c) => ({ ok: v.src.includes('\nEQQnd para.') && markerLine(v.src) === c.marker0, where: c.act })],
  ['empty-space', async () => {
    const p = await page.evaluate(() => { const r = document.querySelector('.mdr-preview').getBoundingClientRect(); return { x: r.right - 30, y: r.bottom - 12 }; });
    await page.mouse.click(p.x, p.y);
  }, (v, c) => ({ ok: !v.src.includes('QQ') && !v.editing, where: c.act })],
  ['drop', async () => {
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['Dropped doc\n'], 'dropped.md', { type: 'text/markdown' }));
      const t = document.querySelector('.mdr-preview');
      for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await sleep(500);
  }, (v, c) => ({ ok: !v.editing && !(v.src.includes('QQ') && v.src.includes('MARK')), where: c.act + ' src=' + J(v.src.slice(0, 20)) })],
  ['tab-wanted', async () => { await page.keyboard.press('Tab'); },
    (v, c) => ({ ok: markerLine(v.src).startsWith(c.pre ? 'MARKZQQER' : 'MARKQQER'), where: c.act, wanted: true })],
];
let bad = 0;
try {
  await B.boot('mode=split');
  await page.evaluate(() => { window.__r4idToasts = []; window.__mdr.app.bus.on('toast', (t) => window.__r4idToasts.push(t.text)); });
  for (const [name, go, want] of WAYS) {
    for (const pre of [false, true]) {
      const nm = `${name}${pre ? '-pre' : ''}${DELAY ? '-d' + DELAY : ''}`;
      if (only.length && !only.some((o) => nm.startsWith(o))) continue;
      try {
        await slowWorker(0);
        await page.evaluate(() => { for (const d of document.querySelectorAll('[aria-modal="true"] button')) if (/取消|Cancel/.test(d.textContent)) d.click(); });
        await load(B, DOC);
        await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); window.__mdr.app.registry.run('edit.find'); const i = document.querySelector('.cm-search input, .cm-panel input'); if (i) i.value = ''; });
        await sleep(100);
        if (!DELAY) await sleep(1500);
        let p = await pointOf(page, 'MARKER', 2); await page.mouse.click(p.x, p.y); await sleep(DELAY ? 200 : 800);
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no first session');
        if (DELAY) { await slowWorker(DELAY); await page.keyboard.press('End'); await page.keyboard.type('X'); await sleep(40); }
        await page.keyboard.press('Escape');
        await sleep(30);
        const marker0 = markerLine(await B.source());
        await page.evaluate(() => { window.__r4idToasts.length = 0; });
        p = await pointOf(page, 'MARKER', 4); await page.mouse.click(p.x, p.y);
        if (pre) { await sleep(20); await page.keyboard.type('Z'); }
        await sleep(80);
        const waiting = await page.evaluate(() => document.activeElement?.classList.contains('mdr-preview__edit-capture') ?? false);
        await go();
        await sleep(60);
        for (const ch of 'QQ') { await page.keyboard.type(ch); await sleep(120); }
        await sleep(DELAY + 2500);
        await slowWorker(0);
        await B.settle(300);
        const v = await view(page);
        const act = await active();
        const searchValue = await page.evaluate(() => document.querySelector('.cm-search input, .cm-panel input')?.value ?? '');
        const toasts = await page.evaluate((t) => window.__r4idToasts.filter((x) => x === t).length, TOAST);
        const r = want(v, { act, searchValue, marker0, toasts, pre });
        const toastOk = r.wanted ? toasts === 0 : toasts === (pre ? 1 : 0);
        const ok = r.ok && toastOk && waiting;
        if (!check(nm, ok, `where=${r.where} toasts=${toasts} (want ${r.wanted ? 0 : pre ? 1 : 0}) waited=${waiting} marker=${J(markerLine(v.src).slice(0, 22))} head=${J(v.src.slice(0, 14))} editing=${J(v.editing && v.editing.text.slice(0, 16))}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
      try {
        await slowWorker(0);
        await page.keyboard.press('Escape');
        await page.evaluate(() => { for (const d of document.querySelectorAll('[aria-modal="true"] button')) if (/取消|Cancel|不保存/.test(d.textContent)) { d.click(); break; } });
        await B.settle(60);
      } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
