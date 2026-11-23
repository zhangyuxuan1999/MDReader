// bench/verify/v7-vf-lib.mjs — verify-refs (0.2.0 stage 2g, round 6 verification): a small session harness on a server
// that is already running (never starts or kills one). Characters that are not plainly visible are built from code points.
// Usage: import { openApp, ... } from './v7-vf-lib.mjs'; every script passes its port explicitly.
import { chromium } from '@playwright/test';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const C = (...cps) => String.fromCodePoint(...cps);
export const show = (s) => (s == null ? 'null' : JSON.stringify([...s].map((c) => {
  const cp = c.codePointAt(0);
  return (cp >= 0x20 && cp <= 0x7e) || cp === 10 || (cp >= 0x4e00 && cp <= 0x9fff) ? c : '<' + cp.toString(16) + '>';
}).join('')));
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xfffc];
/** Not plainly visible (the guard's class): not a letter, mark-free digit, punctuation or symbol with ink; U+00A0
 *  included; space, LF and tab excluded. Marks count as not plainly visible (conservative). */
export function guardedChar(c) {
  if (c === ' ' || c === '\n' || c === '\t') return false;
  if (BLANK.includes(c.codePointAt(0))) return true;
  return !/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(c);
}
export function rawCounts(s) {
  const m = new Map();
  for (const c of s) if (guardedChar(c)) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}
/** Characters (not plainly visible) that `after` holds raw more often than `before` plus `typed`. */
export function rawAdded(before, after, typed = '') {
  const b = rawCounts(before), a = rawCounts(after), t = rawCounts(typed);
  const out = [];
  for (const [c, k] of a) { const lim = (b.get(c) ?? 0) + (t.get(c) ?? 0); if (k > lim) out.push(`U+${c.codePointAt(0).toString(16).toUpperCase()}x${k - lim}`); }
  return out;
}
const NAMED = { shy: 0xad, nbsp: 0xa0, ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e, rlm: 0x200f, emsp13: 0x2004, emsp14: 0x2005, numsp: 0x2007, puncsp: 0x2008, hairsp: 0x200a, NoBreak: 0x2060, ZeroWidthSpace: 0x200b, amp: 0x26 };
/** Character references of the source by decoded character (numeric and a small named table). */
export function refCounts(s) {
  const m = new Map();
  for (const x of s.matchAll(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g)) {
    const n = x[1];
    const cp = n[0] === '#' ? (n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10)) : NAMED[n];
    if (cp === undefined || cp === 0x26) continue;
    const c = String.fromCodePoint(cp);
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return m;
}
/** Percent-escapes of the source (upper-cased) with their counts. */
export function pctCounts(s) {
  const m = new Map();
  for (const x of s.matchAll(/(?:%[0-9A-Fa-f]{2})+/g)) { const k = x[0].toUpperCase(); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
export function lostKeys(before, after) {
  const out = [];
  for (const [k, n] of before) { const a = after.get(k) ?? 0; if (a < n) out.push(`${k.length === 1 ? 'U+' + k.codePointAt(0).toString(16).toUpperCase() : k}:${n}->${a}`); }
  return out;
}
/** The common prefix / suffix diff of two strings: { at, del, ins }. */
export function strDiff(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { at: i, del: a.slice(i, a.length - j), ins: b.slice(i, b.length - j) };
}

export async function launch() { return chromium.launch({ headless: true }); }

/** Opens the app. perf: true adds ?perf=1 (test hooks); stored: the value of mdr.previewEdit put in before load. */
export async function openApp(browser, port, { perf = true, stored = null, mode = 'split', width = 1300, height = 860 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(([st]) => {
    try { if (st !== null) localStorage.setItem('mdr.previewEdit', st); } catch {}
    window.__vf = { toasts: [], guard: 0 };
    const T = '此块请在源码中编辑';
    const obs = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === 'characterData') { if ((r.target.data || '').includes(T)) window.__vf.toasts.push(r.target.data); continue; }
        for (const n of r.addedNodes) if ((n.textContent || '').includes(T)) window.__vf.toasts.push(n.textContent);
      }
    });
    const go = () => obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  }, [stored]);
  const page = await context.newPage();
  const guard = [];
  const errors = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('the write guard refused')) guard.push(t); if (m.type() === 'error') errors.push(t); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const q = [];
  if (perf) q.push('perf=1');
  if (mode && perf) q.push('mode=' + mode);
  await page.goto(`http://localhost:${port}/${q.length ? '?' + q.join('&') : ''}`, { waitUntil: 'domcontentloaded' });
  if (perf) {
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
    await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  }
  if (!perf) await page.waitForSelector('.cm-content', { timeout: 30000 });
  const cdp = await context.newCDPSession(page);
  return { context, page, guard, errors, cdp, user: !perf };
}

export async function load(A, text, name = 'vf.md') {
  await A.page.keyboard.press('Escape');
  if (A.user) {   // a real user: the document goes in through the editor (select all, paste)
    await A.page.click('.cm-content');
    await A.page.keyboard.press('Meta+a');
    await A.page.evaluate((t) => {
      const dt = new DataTransfer(); dt.setData('text/plain', t);
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
    await sleep(1500);
    return;
  }
  await A.page.evaluate(([t, n]) => window.__mdr.loadText(t, n), [text, name]);
  await A.page.evaluate(() => window.__mdr.waitIdle());
  await sleep(800);
}
export const source = (A) => A.page.evaluate(() => (window.__mdr ? window.__mdr.app.getText() : document.querySelector('.cm-content').cmTile.view.state.doc.toString()));
export const toasts = (A) => A.page.evaluate(() => window.__vf.toasts.length);
export const editing = (A) => A.page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
export async function idle(A) { if (A.user) { await sleep(600); return; } await A.page.evaluate(() => window.__mdr.waitIdle()); await sleep(250); }
/** The preview's text (the blocks only). */
export const shown = (A) => A.page.evaluate(() => {
  const root = window.__mdr?.app?.preview?.el ?? document.querySelector('.mdr-preview');
  return Array.from(root.querySelectorAll('.md-block')).map((b) => b.textContent).join('\n');
});
export const shownHtml = (A) => A.page.evaluate(() => {
  const root = window.__mdr?.app?.preview?.el ?? document.querySelector('.mdr-preview');
  return Array.from(root.querySelectorAll('.md-block')).map((b) => b.innerHTML).join('\n');
});

/** Point (viewport) of the character at `off` of the k-th occurrence of `needle` in the preview's text nodes. */
export async function pointOf(A, needle, k = 0, off = 1, scope = 'preview') {
  return A.page.evaluate(([needle, k, off, scope]) => {
    const root = scope === 'session' ? document.querySelector('.md-block.is-editing') : (window.__mdr?.app?.preview?.el ?? document.querySelector('.mdr-preview'));
    if (!root) return null;
    const tw = document.createTreeWalker(root, 4);
    let seen = 0;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      let i = n.data.indexOf(needle);
      while (i >= 0) {
        if (seen++ === k) {
          const el = n.parentElement; el.scrollIntoView({ block: 'center' });
          const r = document.createRange(); const p = Math.min(i + off, n.data.length - 1); r.setStart(n, p); r.setEnd(n, p + 1);
          const b = r.getBoundingClientRect(); return { x: b.left + Math.min(1, b.width / 2), y: b.top + b.height / 2 };
        }
        i = n.data.indexOf(needle, i + 1);
      }
    }
    return null;
  }, [needle, k, off, scope]);
}
/** Starts a session with a click (press and release) on `needle`; true when a session is live afterwards. */
export async function clickAt(A, needle, k = 0, off = 1, { double = false } = {}) {
  const p = await pointOf(A, needle, k, off);
  if (!p) return null;
  await sleep(120);
  const p2 = await pointOf(A, needle, k, off);
  if (double) await A.page.mouse.dblclick(p2.x, p2.y); else await A.page.mouse.click(p2.x, p2.y);
  await sleep(450);
  return editing(A);
}
/** Puts the caret (or a selection of `len`) at `needle`+`off` inside the live session. */
export async function caret(A, needle, off = needle.length, len = 0, k = 0) {
  return A.page.evaluate(([needle, off, len, k]) => {
    const el = document.querySelector('.md-block.is-editing');
    if (!el) return false;
    const tw = document.createTreeWalker(el, 4);
    let seen = 0;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i >= 0 && seen++ === k) {
        const r = document.createRange(); r.setStart(n, i + off);
        if (len) r.setEnd(n, i + off + len); else r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
      }
    }
    return false;
  }, [needle, off, len, k]);
}
export async function paste(A, text, html) {
  await A.page.evaluate(([text, html]) => {
    const dt = new DataTransfer(); dt.setData('text/plain', text); if (html) dt.setData('text/html', html);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [text, html ?? null]);
  await sleep(60);
}
export async function ime(A, steps, commit) {
  for (const t of steps) { await A.cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(25); }
  await A.cdp.send('Input.insertText', { text: commit });
  await sleep(40);
}
export async function insertText(A, t) { await A.cdp.send('Input.insertText', { text: t }); await sleep(30); }
export async function esc(A) { await A.page.keyboard.press('Escape'); await idle(A); await sleep(200); }

/** Runs steps: strings 'type:..', 'press:..', 'caret:needle[:off[:len]]', 'paste:..', 'ins:..' (CDP insertText),
 *  'ime:steps|commit', 'wait:ms'. Returns the typed text (what the user put in). */
export async function run(A, steps) {
  let typed = '';
  for (const st of steps) {
    if (typeof st === 'function') { await st(A); continue; }
    const i = st.indexOf(':'); const op = st.slice(0, i); const arg = st.slice(i + 1);
    if (op === 'type') { await A.page.keyboard.type(arg, { delay: 8 }); typed += arg; }
    else if (op === 'ins') { await insertText(A, arg); typed += arg; }
    else if (op === 'press') { await A.page.keyboard.press(arg); await sleep(40); }
    else if (op === 'caret') { const [n, o, l, k] = arg.split('§'); const ok = await caret(A, n, o === undefined || o === '' ? n.length : Number(o), l ? Number(l) : 0, k ? Number(k) : 0); if (!ok) throw new Error('caret not found: ' + n); }
    else if (op === 'paste') { await paste(A, arg); typed += arg; }
    else if (op === 'ime') { const [s, c] = arg.split('|'); await ime(A, s.split(','), c); typed += c; }
    else if (op === 'wait') await sleep(Number(arg));
    else throw new Error('step ' + st);
  }
  return typed;
}
export function globalTimeout(ms, cleanup) {
  const t = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await cleanup?.(); } catch {} process.exit(3); }, ms);
  return () => clearTimeout(t);
}
