// bench/verify/v5-offc-lib.mjs — audit-off-code (0.2.0 stage 2e) shared helpers for bench/verify/v5-offc-*.mjs.
// Two builds side by side: the candidate (MDR_PORT, default 5511: a dev server of the tree under test, opened
// with localStorage mdr.previewEdit = "0" put in place before the app starts, unless a case asks otherwise) and
// the 0.1.1 baseline (MDR_BASE_PORT, default 5512: vite preview of release/baseline-0.1.1.noindex/dist, opened
// with ?perf=1 for the test hooks). Needs both servers already listening; starts none, kills none.
// Writes nothing into the tree.
import { chromium } from '@playwright/test';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

export const PORT = Number(process.env.MDR_PORT || 5511);
export const BASE_PORT = Number(process.env.MDR_BASE_PORT || 5512);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/** A solid-colour PNG (no dependency). */
export function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const IMG = `data:image/png;base64,${png(120, 60, [200, 60, 60]).toString('base64')}`;
const FILLER = Array.from({ length: 60 }, (_, i) => `Filler paragraph number ${i + 1} with enough words to wrap across the preview line at least once or twice so that scrolling is possible.`).join('\n\n');
/** Every block kind, every inline kind, then filler so that the preview scrolls. */
export const DOC_ALL = [
  '# Heading Alpha',
  '',
  'First paragraph with **bold words**, *italic words*, `inline code`, ~~struck words~~, a [plain link](https://example.com/plain), an autolink <https://example.org/auto>, inline math $a^2+b^2=c^2$ and a footnote ref[^n1].',
  '',
  'Clickhere paragraph two has ordinary words only for collapsed clicks and keys.',
  '',
  `![Picture](${IMG})`,
  '',
  '## Lists Beta',
  '',
  '- bullet one',
  '- bullet two',
  '  - nested three',
  '  - nested four',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '- [ ] task alpha',
  '- [x] task beta',
  '- [ ] task gamma',
  '',
  '> quote line one',
  '> quote line two',
  '',
  '```js',
  'const fenced = 1;',
  '```',
  '',
  '    indented code line',
  '',
  '| Col A | Col B |',
  '|-------|-------|',
  '| cell 1 | cell 2 |',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '<div class="raw">raw <b>html</b> block</div>',
  '',
  'See the [anchor link](#lists-beta) and the [relative link](other.md).',
  '',
  'Second last paragraph before filler.',
  '',
  FILLER,
  '',
  'Final paragraph at the very end.',
  '',
  '[^n1]: The footnote text.',
  '',
].join('\n');

/** A page on `port`. base: the 0.1.1 production build (?perf=1). pref: what localStorage mdr.previewEdit holds
 *  before the app starts (null: nothing stored). window.open is recorded instead of opening anything. */
export async function open(port, { base = false, pref = '0', viewport = { width: 1400, height: 900 }, mode = 'split' } = {}) {
  const origin = `http://localhost:${port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.addInitScript(({ pref }) => {
    try { if (pref === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', pref); } catch { /* */ }
    window.__offcOpened = [];
    // drag-and-drop and clipboard events as the page finished with them (read after dispatch: defaultPrevented)
    window.__offcEv = [];
    const rec = (e) => {
      const t = e.target;
      const where = !(t instanceof Element) ? String(t && t.nodeName) : t.closest('.cm-editor') ? 'editor' : t.closest('.mdr-preview') ? 'preview' : t.tagName.toLowerCase();
      const ev = { type: e.type, where, types: e.dataTransfer ? Array.from(e.dataTransfer.types).join(',') : (e.clipboardData ? Array.from(e.clipboardData.types).join(',') : '') };
      window.__offcEv.push(ev);
      setTimeout(() => { ev.prevented = e.defaultPrevented; }, 0);
    };
    for (const ty of ['dragstart', 'drop', 'dragend', 'copy', 'cut', 'paste']) window.addEventListener(ty, rec);
    window.open = function (u) { window.__offcOpened.push(String(u)); return null; };
  }, { pref });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  let popups = 0;
  context.on('page', () => { popups++; });
  await page.goto(`${origin}/?mode=${mode}${base ? '&perf=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(500);
  await page.evaluate(() => { for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none'; });
  const B = {
    browser, context, page, base, pageErrors, port, popups: () => popups,
    name: base ? 'base' : 'cand',
    async close() { try { await browser.close(); } catch { /* */ } },
    source: () => page.evaluate(() => window.__mdr.app.getText()),
    idle: async (ms = 120) => { await page.evaluate(() => window.__mdr.waitIdle()); await sleep(ms); },
  };
  if (!base && pref === '0') await assertOff(B);
  return B;
}

/** The candidate's switch is off: its toolbar button is not pressed and the preview is not editable. */
export async function switchState(B) {
  return B.page.evaluate(() => ({
    pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null,
    editable: window.__mdr.app.preview.isPreviewEditable ? window.__mdr.app.preview.isPreviewEditable() : null,
    stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'n/a'; } })(),
  }));
}
export async function assertOff(B) {
  if (B.base) return;
  const st = await switchState(B);
  if (st.pressed !== 'false' || st.editable !== false) throw new Error(`switch is not off on the candidate: ${JSON.stringify(st)}`);
}

export async function loadDoc(B, text, name = 'offc.md') {
  const { page } = B;
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
  await B.idle(300);
  await page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    root.scrollTop = 0;
    const sc = document.querySelector('.cm-scroller'); if (sc) sc.scrollTop = 0;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    getSelection().removeAllRanges();
    for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none';
  });
  await page.mouse.move(2, 2);
  await sleep(250);
  await B.idle(80);
}

/** Viewport point at the left (or right) edge of character k of the first occurrence of `needle` in `scope`. */
export async function pointOf(page, needle, k = 0, side = 'left', scope = '.mdr-preview') {
  return page.evaluate(({ needle, k, side, scope }) => {
    const root = document.querySelector(scope);
    if (!root) return null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui], .katex-mathml') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const at = i + k;
      const r = document.createRange();
      r.setStart(n, at); r.setEnd(n, Math.min(n.data.length, at + 1));
      let rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      const sc = scope === '.mdr-preview' ? root : (root.closest('.cm-scroller') ?? root.querySelector('.cm-scroller') ?? root);
      const box = sc.getBoundingClientRect();
      if (rect.top < box.top + 10 || rect.bottom > box.bottom - 10) {
        sc.scrollTop += rect.top - (box.top + box.height / 2);
        rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      }
      const x = side === 'left' ? rect.left + Math.min(1.5, rect.width / 3) : rect.right - Math.min(1.5, rect.width / 3);
      return { x, y: rect.top + rect.height / 2 };
    }
    return null;
  }, { needle, k, side, scope });
}
/** Centre (fx, fy fractions) of the n-th element matching css inside the preview, scrolled into view. */
export async function pointOfSel(page, css, { fx = 0.5, fy = 0.5, n = 0, scope = '.mdr-preview' } = {}) {
  return page.evaluate(({ css, fx, fy, n, scope }) => {
    const root = document.querySelector(scope);
    const e = root.querySelectorAll(css)[n];
    if (!e) return null;
    let r = e.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.top < box.top + 10 || r.bottom > box.bottom - 10) { root.scrollTop += r.top - (box.top + box.height / 2); r = e.getBoundingClientRect(); }
    return { x: r.left + r.width * fx, y: r.top + r.height * fy, rect: { l: r.left, t: r.top, w: r.width, h: r.height } };
  }, { css, fx, fy, n, scope });
}
export async function must(p, what) { if (!p) throw new Error(`not shown: ${what}`); return p; }

/** Mouse click with clickCount n (each press + release dispatched like a real multi-click). */
export async function clickAt(page, p, n = 1, { modifiers = [] } = {}) {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(p.x, p.y);
  for (let c = 1; c <= n; c++) { await page.mouse.down({ clickCount: c }); await page.mouse.up({ clickCount: c }); }
  for (const m of modifiers) await page.keyboard.up(m);
}
export async function dragFromTo(page, a, b, { steps = 12, gap = 15, pressed = false } = {}) {
  if (!pressed) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
  }
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(gap); }
  await page.mouse.up();
}

/** Everything a probe compares, in terms that do not depend on the build (no ids, no class names of the
 *  candidate's own UI): source, selection as text offsets in the preview body, focus, scroll positions, mode,
 *  toasts, popups, and the session's traces. */
export async function obs(B) {
  const o = await B.page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const body = root.querySelector('.mdr-preview__body');
    const sel = getSelection();
    const off = (node, k) => {
      if (!node || !body.contains(node)) return null;
      const r = document.createRange(); r.setStart(body, 0);
      try { r.setEnd(node, k); } catch { return null; }
      return r.toString().length;
    };
    const cm = document.querySelector('.cm-editor');
    const ae = document.activeElement;
    const where = (e) => {
      if (!e || e === document.body) return 'body';
      if (cm && cm.contains(e)) return 'editor';
      if (root.contains(e)) {
        if (e.classList?.contains('mdr-preview__edit-capture')) return 'preview:capture';
        if (e === root) return 'preview';
        return `preview:${e.tagName.toLowerCase()}${e.getAttribute('href') ? `[href=${e.getAttribute('href').slice(0, 30)}]` : ''}${e.type ? `[${e.type}]` : ''}`;
      }
      if (e.closest?.('[class*="toolbar"]')) return `toolbar:${e.dataset?.cmd ?? e.tagName.toLowerCase()}`;
      return e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(/\s+/)[0] : '');
    };
    const sc = document.querySelector('.cm-scroller');
    const modeBtn = Array.from(document.querySelectorAll('[data-cmd^="view.mode."]')).find((b) => b.getAttribute('aria-pressed') === 'true');
    const zwRe = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`, 'g');
    const hint = document.querySelector('.mdr-preview__edit-hint');
    const app = document.querySelector('.mdr-app');
    const status = document.querySelector('[class*="statusbar"]');
    return {
      src: window.__mdr.app.getText(),
      sel: sel.toString().slice(0, 400),
      selLen: sel.toString().length,
      aOff: off(sel.anchorNode, sel.anchorOffset), fOff: off(sel.focusNode, sel.focusOffset),
      selIn: !sel.anchorNode ? 'none' : (cm && cm.contains(sel.anchorNode)) ? 'editor' : body.contains(sel.anchorNode) ? 'preview' : 'other',
      active: where(ae),
      pTop: Math.round(root.scrollTop), pMax: Math.round(root.scrollHeight - root.clientHeight),
      eTop: sc ? Math.round(sc.scrollTop) : null,
      mode: modeBtn ? modeBtn.dataset.cmd : (app?.dataset.mode ?? null),
      toast: Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent.trim()).filter(Boolean).join(' | ').slice(0, 200),
      opened: (window.__offcOpened || []).slice(),
      checks: Array.from(root.querySelectorAll('input[type="checkbox"]')).map((c) => (c.checked ? 1 : 0)).join(''),
      ce: root.querySelectorAll('[contenteditable]').length,
      editing: root.querySelectorAll('.is-editing').length,
      cap: !!root.querySelector('.mdr-preview__edit-capture'),
      hint: !!(hint && !hint.hidden && getComputedStyle(hint).display !== 'none'),
      zw: (body.textContent.match(zwRe) || []).length,
      status: status ? status.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
      spell: root.querySelectorAll('[spellcheck]').length,
      mdrO: root.querySelectorAll('[data-mdr-o]').length,
      mathSrc: root.querySelectorAll('.md-math-src').length,
      ghost: !!root.querySelector('.md-ghost-holder'),
      stale: root.querySelectorAll('section.md-block.is-stale').length,
    };
  });
  o.popups = B.popups();
  return o;
}

/** Clipboard contents (every type the async clipboard exposes). */
export async function clip(B) {
  return B.page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      const out = {};
      for (const it of items) for (const t of it.types) out[t] = await (await it.getType(t)).text();
      return out;
    } catch (e) { return { err: String(e && e.message ? e.message : e) }; }
  });
}
export async function clipSentinel(B) { await B.page.evaluate(() => navigator.clipboard.writeText('<<none>>')); }

/** Per-block HTML of the preview at rest, normalized: data-id, the focus-line tint, wrapper-only state and the
 *  attributes rule 8 names (data-mdr-x) are left out. */
export async function restBlocks(B) {
  return B.page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    return Array.from(root.querySelectorAll('section.md-block')).map((s) => {
      const c = s.cloneNode(true);
      for (const e of [c, ...c.querySelectorAll('*')]) {
        e.removeAttribute('data-id');
        e.removeAttribute('data-mdr-x');
        e.removeAttribute('style');
        e.classList?.remove('is-focus');
        if (e.classList && e.classList.length === 0) e.removeAttribute('class');
      }
      return { attrs: Array.from(s.attributes).map((a) => a.name).filter((n) => !['data-id', 'style', 'class', 'data-mdr-x'].includes(n)).join(','), cls: Array.from(s.classList).filter((k) => k !== 'is-focus').join(' '), html: c.innerHTML };
    });
  });
}

/** Runs `fn(B)` on both builds and returns {cand, base}. */
export async function both(C, Bb, fn) {
  const cand = await fn(C);
  const base = await fn(Bb);
  return { cand, base };
}

/** Keys whose values differ (deep, by JSON). */
export function diffKeys(a, b, prefix = '') {
  const out = [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix || '(value)');
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) out.push(...diffKeys(x, y, prefix ? `${prefix}.${k}` : k));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(prefix ? `${prefix}.${k}` : k);
  }
  return out;
}
export function getPath(o, p) { return p.split('.').reduce((v, k) => (v == null ? v : v[k]), o); }

/** Clipboard HTML compared by content: Chrome inlines each copied element's computed style in the order the matched
 *  rules declare it (the dev server's unminified stylesheets and the production bundle differ in that order), the page
 *  URL differs (port, ?perf=1), and the minifier rewrote some values in the baseline's stylesheets (rgba(0, 0, 0, 0) for
 *  transparent, 0.12s for 120ms, background: 0px 0px for background: transparent). */
export function normHtml(html) {
  if (html === null || html === undefined) return null;
  // (block ids depend on the edit history of the window, in 0.1.1 as well: data-id="N" is left out)
  return html.replace(/ data-id="\d+"/g, '').replace(/http:\/\/localhost:\d+\/(\?mode=split(&amp;perf=1)?)?/g, 'ORIGIN/')
    .replace(/rgba\(0, 0, 0, 0\)/g, 'transparent').replace(/\b120ms\b/g, '0.12s').replace(/\b160ms\b/g, '0.16s').replace(/background: 0px 0px/g, 'background: transparent')
    .replace(/style="([^"]*)"/g, (m, v) => `style="${v.split(/;\s*/).filter(Boolean).sort().join('; ')}"`);
}
