// bench/electron/v5-offk-menu.mjs — verify-off-desktop (0.2.0 r4 verification): the menus and the preview pane of
// the desktop window with the switch OFF (nothing stored, production renderer, no hooks), one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-menu.mjs [case ...]
// Prints one OBS <case> <json> line per case: run both targets and compare with
//   node bench/electron/v5-offk-menu.mjs --compare <cand.log> <base.log>
// The system clipboard is saved inside the main process before the first copy and written back at the end; its
// content is never printed (only what this script wrote / copied from its own document, as a length and a prefix).
// Launch only through ./_electron.mjs (isolated profile under MDR_OFFK_TMP). No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--compare') {
  const read = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('OBS ')).map((l) => { const m = l.match(/^OBS (\S+) (.*)$/); return [m[1], m[2]]; }));
  const a = read(process.argv[3]), b = read(process.argv[4]);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) { console.log(`SAME ${k}`); continue; }
    const ja = JSON.parse(a[k] || '{}'), jb = JSON.parse(b[k] || '{}');
    const diffs = [];
    const walk = (x, y, p) => {
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      if (x && y && typeof x === 'object' && typeof y === 'object') { for (const kk of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[kk], y[kk], `${p}.${kk}`); return; }
      diffs.push(`${p}: cand=${JSON.stringify(x)} base=${JSON.stringify(y)}`);
    };
    walk(ja, jb, k);
    console.log(`DIFF ${k}\n  ${diffs.slice(0, 12).join('\n  ')}`);
  }
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.join(ROOT, 'release/staging-0.2.0.noindex');
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-menu-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await a.evaluate(async ({ clipboard }) => { const s = globalThis.__offkClip; if (!s) return; if (s.length) await clipboard.write(s); else clipboard.clear(); }); } catch { /* */ }
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);

const paras = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：这是一段用来滚动和点击的文字，编号 ${i + 1}。`);
const DOC = `# 菜单检查\n\n- [ ] 任务甲\n- [x] 任务乙\n- [ ] 任务丙\n\n${paras.join('\n\n')}\n`;
const FILE = path.join(TMP, 'offk-menu.md');

async function launch() {
  fs.writeFileSync(FILE, DOC, 'utf8');
  app = await electron.launch({ args: [DIR, FILE, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => /第 60 段/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  await app.evaluate(async ({ clipboard }) => { if (!globalThis.__offkClip) globalThis.__offkClip = await clipboard.read(); });
  await sleep(900);
}
const menuClick = (id) => app.evaluate(({ Menu }, i) => { const it = Menu.getApplicationMenu().getMenuItemById(i); if (!it) return false; it.click(); return true; }, id);
const wc = (fn) => app.evaluate(({ BrowserWindow }, f) => { const w = BrowserWindow.getAllWindows()[0].webContents; w[f](); return true; }, fn);
const clipText = () => app.evaluate(async ({ clipboard }) => { const t = String(await clipboard.readText()); return { len: t.length, head: t.slice(0, 40), tail: t.slice(-20) }; });
const setClip = (t) => app.evaluate(async ({ clipboard }, s) => { await clipboard.writeText(s); }, t);
async function snap() {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent);
    const ae = document.activeElement;
    const desc = (e) => !e ? null : e === document.body ? 'body' : e.closest('.cm-editor') ? 'editor' : e.closest('.mdr-preview') ? 'preview:' + e.tagName : e.tagName + '.' + (e.className || '').toString().split(' ')[0];
    const scrolls = {};
    for (const e of document.querySelectorAll('.cm-scroller, .mdr-preview, .mdr-preview-pane, [class*="scroll"]')) scrolls[(e.className || '').toString().split(' ')[0]] = Math.round(e.scrollTop);
    const fl = [...document.querySelectorAll('.mdr-preview [class*="focus"], .mdr-preview [data-focus], .cm-line[class*="focus"], .cm-activeLine')].map((e) => (e.className || '').toString() + ':' + (e.textContent || '').slice(0, 12));
    const sel = getSelection();
    const boxes = [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map((b) => (b.checked ? 1 : 0)).join('');
    return {
      src: lines.filter((l) => /ZZ|任务|第 1 段|第 60 段/.test(l)).join('|'), nLines: lines.length, focus: desc(ae), scrolls, fl: fl.slice(0, 4), boxes,
      sel: sel ? { len: sel.toString().length, head: sel.toString().slice(0, 16), anchor: desc(sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)) } : null,
      mode: document.querySelector('[data-mode]')?.getAttribute('data-mode') ?? null, title: document.title,
      toasts: [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()),
    };
  });
}
async function clickPreviewText(re, off = 3) {
  const pt = await page.evaluate(([src, o]) => {
    const r0 = new RegExp(src);
    const p = [...document.querySelectorAll('.mdr-preview p, .mdr-preview li, .mdr-preview h1')].find((x) => r0.test(x.textContent));
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() ? 1 : 3) }).nextNode();
    const r = document.createRange(); r.setStart(n, o); r.setEnd(n, o + 1);
    const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [re, off]);
  if (!pt) return false;
  await sleep(150);
  const pt2 = await page.evaluate(([src, o]) => { const p = [...document.querySelectorAll('.mdr-preview p, .mdr-preview li, .mdr-preview h1')].find((x) => new RegExp(src).test(x.textContent)); const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() ? 1 : 3) }).nextNode(); const r = document.createRange(); r.setStart(n, o); r.setEnd(n, o + 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, [re, off]);
  await page.mouse.click(pt2.x, pt2.y);
  await sleep(350);
  return true;
}
async function typeInEditorAtEnd(s) {
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(s);
  await sleep(500);
}
async function boxClick(i) {
  const pt = await page.evaluate((k) => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k]; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
  await sleep(200);
  const p2 = await page.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
  await page.mouse.click(p2.x, p2.y);
  await sleep(500);
  return pt;
}
const out = (k, o) => console.log(`OBS ${k} ${JSON.stringify(o)}`);

const CASES = {
  async 'menu-tree'() {
    const t = await app.evaluate(({ Menu }) => {
      const walk = (m) => m.items.map((i) => ({ l: i.label, a: i.accelerator || '', r: i.role || '', id: i.id && !/^\d+$/.test(i.id) ? i.id : '', e: i.enabled, v: i.visible, ty: i.type, sub: i.submenu ? walk(i.submenu) : undefined }));
      return walk(Menu.getApplicationMenu());
    });
    const flat = [];
    const f = (items, p) => { for (const i of items) { const k = `${p}/${i.l}`; flat.push(`${k}|${i.a}|${i.r}|${i.id}|${i.e ? 'E' : 'd'}|${i.v ? 'V' : 'h'}|${i.ty}`); if (i.sub) f(i.sub, k); } };
    f(t, '');
    for (const l of flat) out('menu:' + l.split('|')[0].replace(/\s/g, '_'), l);
  },
  async 'undo-menu-preview'() {
    await typeInEditorAtEnd('ZZ');
    const a = await snap();
    await clickPreviewText('^第 2 段');
    const b = await snap();
    await menuClick('edit.undo');
    await sleep(900);
    const c = await snap();
    await menuClick('edit.redo');
    await sleep(900);
    const d = await snap();
    out('undo-menu-preview', { a, b, c, d });
  },
  async 'undo-key-preview'() {
    await typeInEditorAtEnd('ZZ');
    await clickPreviewText('^第 2 段');
    const b = await snap();
    await page.keyboard.press('Meta+z');
    await sleep(900);
    const c = await snap();
    await page.keyboard.press('Meta+Shift+z');
    await sleep(900);
    const d = await snap();
    out('undo-key-preview', { b, c, d });
  },
  async 'undo-menu-nowhere'() {
    await typeInEditorAtEnd('ZZ');
    await clickPreviewText('^第 2 段');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(200);
    const b = await snap();
    await menuClick('edit.undo');
    await sleep(900);
    const c = await snap();
    out('undo-menu-nowhere', { b, c });
  },
  async 'tick-then-undo-menu'() {
    await clickPreviewText('^第 2 段');
    await boxClick(0);
    const a = await snap();
    await menuClick('edit.undo');
    await sleep(900);
    const b = await snap();
    await boxClick(2);
    await page.keyboard.press('Meta+z');
    await sleep(900);
    const c = await snap();
    out('tick-then-undo-menu', { a, b, c });
  },
  async 'selectall-copy-preview'() {
    await clickPreviewText('^第 3 段');
    await setClip('<<offk>>');
    await wc('selectAll');
    await sleep(300);
    const a = await snap();
    await wc('copy');
    await sleep(500);
    const c1 = await clipText();
    // a selection inside one paragraph, copied by the role call
    await page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => /^第 4 段/.test(x.textContent)); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await setClip('<<offk>>');
    await wc('copy');
    await sleep(500);
    const c2 = await clipText();
    // cut in the read-only preview, then paste in the preview: nothing changes
    await wc('cut');
    await sleep(300);
    await setClip('PASTED');
    await clickPreviewText('^第 5 段');
    await wc('paste');
    await sleep(500);
    const d = await snap();
    out('selectall-copy-preview', { a, c1, c2, d });
  },
  async 'keys-preview'() {
    await page.evaluate(() => { const s = document.querySelector('.mdr-preview'); if (s) s.scrollTop = 0; });
    await clickPreviewText('^# ?菜单|菜单检查', 1);
    const r = {};
    for (const k of ['Space', 'Space', 'Shift+Space', 'End', 'Home', 'PageDown', 'ArrowDown', 'ArrowDown', 'PageUp']) { await page.keyboard.press(k); await sleep(400); const s = await snap(); r[k + '#' + Object.keys(r).length] = { scrolls: s.scrolls, focus: s.focus, src: s.src, sel: s.sel }; }
    await page.keyboard.type('qw');
    await sleep(400);
    r.typed = await snap();
    out('keys-preview', r);
  },
  async 'dblclick-tripleclick-preview'() {
    await clickPreviewText('^第 6 段', 6);
    const pt = await page.evaluate(() => { const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => /^第 6 段/.test(x.textContent)); const n = p.firstChild; const r = document.createRange(); r.setStart(n, 6); r.setEnd(n, 7); const b = r.getBoundingClientRect(); return { x: b.left + 2, y: b.top + b.height / 2 }; });
    await page.mouse.dblclick(pt.x, pt.y);
    await sleep(300);
    const a = await snap();
    await page.mouse.click(pt.x, pt.y, { clickCount: 3 });
    await sleep(300);
    const b = await snap();
    await page.mouse.click(pt.x, pt.y, { modifiers: ['Alt'] });
    await sleep(600);
    const c = await snap();
    out('dblclick-tripleclick-preview', { a, b, c });
  },
  async 'view-menu-items'() {
    const r = {};
    for (const id of ['view.mode.preview', 'view.mode.edit', 'view.mode.split', 'view.cycleMode', 'view.toggleToc', 'view.toggleToc', 'view.toggleTheme', 'view.toggleTheme', 'view.mountAll']) {
      await menuClick(id); await sleep(500);
      const s = await snap();
      r[id + '#' + Object.keys(r).length] = { mode: s.mode, focus: s.focus, cls: await page.evaluate(() => [document.documentElement.getAttribute('data-theme'), document.body.className, document.querySelector('.mdr-toc') ? getComputedStyle(document.querySelector('.mdr-toc')).display : 'none'].join(',')), toasts: s.toasts };
    }
    out('view-menu-items', r);
  },
  async 'format-menu-preview'() {
    const r = {};
    for (const id of ['edit.bold', 'edit.heading1', 'edit.toggleTask', 'edit.italic', 'edit.paragraph', 'edit.code', 'edit.link']) {
      await clickPreviewText('^第 3 段', 4);
      await menuClick(id); await sleep(500);
      const s = await snap();
      r[id] = { src3: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).filter((l) => l.includes('第 3 段') || l.includes('任务甲') || l.startsWith('#')).slice(0, 6).join('|')), focus: s.focus, title: s.title, dialogs: await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog, .mdr-palette, [role=dialog]')].map((d) => d.className.toString().slice(0, 30))) };
      await page.keyboard.press('Escape'); await sleep(200);
    }
    out('format-menu-preview', r);
  },
  async 'find-goto-palette-preview'() {
    const r = {};
    for (const id of ['edit.find', 'edit.gotoLine', 'view.palette']) {
      await clickPreviewText('^第 3 段', 4);
      await menuClick(id); await sleep(500);
      const s = await snap();
      r[id] = { focus: s.focus, active: await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '.' + (a.className || '').toString().slice(0, 40) + ':' + (a.getAttribute('placeholder') || a.getAttribute('aria-label') || '') : null; }), open: await page.evaluate(() => [...document.querySelectorAll('.cm-panels, .cm-search, .mdr-palette, .mdr-goto, [role=dialog]')].map((d) => d.className.toString().slice(0, 30))) };
      await page.keyboard.type('5'); await sleep(200);
      r[id].afterType = (await snap()).src;
      await page.keyboard.press('Escape'); await sleep(300);
      r[id].afterEsc = (await snap()).focus;
    }
    out('find-goto-palette-preview', r);
  },
};

try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    await launch();
    try { await fn(); } catch (e) { console.log(`OBS ${name} ${JSON.stringify({ threw: String(e).split('\n')[0] })}`); }
    await quit();
  }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
