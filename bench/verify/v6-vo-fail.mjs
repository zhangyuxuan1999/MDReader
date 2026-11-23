// bench/verify/v6-vo-fail.mjs — verify-off (0.2.0 stage 2f, round 5, rule L4 + RL-1/RL-2): the editing chunk
// /assets/inlineEdit-*.js fails for a REAL USER of a production build (no ?perf=1, no hooks). Complements the fail-*
// cases of r5-rl-races.mjs (404, cut, syntax, throw at a toggle; 404 / cut at start) and r5-pl-user.mjs (abort, html).
//   MDR_URL=http://localhost:5480/ node bench/verify/v6-vo-fail.mjs <case ...|all>
// Cases (each: the editor's time to .cm-content, typing in the editor, a tick, the theme and a mode switch after the
// failure; the failure toast kind and text; pressed / busy / stored; page errors):
//   start-abort / start-html / start-cut   stored '1', the chunk aborted / answered by index.html with status 200 /
//                   cut in the middle, at start: the editor is not delayed (vs stored '0' in the same run), one failure
//                   toast, stored still '1', not busy; then a press: fails at once (no new request), stored '0'.
//   start-hang      stored '1', the chunk never answers: the editor works, nothing toasts, busy while waiting;
//                   a press joins (toast 正在加载… after 300 ms), a second press withdraws: off, not busy, stored '0'.
//   toggle-html-typing  stored '0': typing in the editor while the press's load is answered by index.html: every typed
//                   character is in the source once; failure toast; stored '0'; then a reload without the route: a
//                   press turns it on, a session works.
//   toggle-abort-twice  stored '0', aborted: the first press fails (toast), a second press fails again without a new
//                   request (Chromium remembers), one more toast; nothing else breaks.
// PASS / FAIL lines; exit 0 all pass, 1 a failure, 3 global timeout (115 s). Writes nothing.
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || 'http://localhost:5480/').replace(/\/?$/, '/');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 115_000);
const CHUNK = '**/assets/inlineEdit-*.js';
const BTN = '[data-cmd="view.togglePreviewEdit"]';
const FAILED = '预览编辑功能加载失败，请刷新页面或重启应用后重试';
const LOADING = '正在加载预览编辑功能…';
const DOC = ['# Fail check', '', '- [ ] first box', '', ...Array.from({ length: 8 }, (_, i) => `Para ${i + 1} text of the failure check, long enough.` + NL)].join(NL);
const st = (page) => page.evaluate((b) => {
  const c = document.querySelector('.cm-content');
  const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
  return {
    pressed: document.querySelector(b)?.getAttribute('aria-pressed') ?? null,
    busy: document.querySelector(b)?.getAttribute('aria-busy') ?? null,
    stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } })(),
    src: v ? v.state.doc.toString() : null,
    editing: document.querySelectorAll('.mdr-preview .is-editing').length,
    hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
    theme: document.documentElement.dataset.theme || document.documentElement.className,
    errToasts: [...document.querySelectorAll('.mdr-toast')].filter((t) => /error/.test(t.className)).map((t) => t.textContent),
  };
}, BTN);
const count = (s, sub) => s.split(sub).length - 1;
const HTML = '<!doctype html><html><head><title>MDReader</title></head><body><div id="app"></div></body></html>';
const routes = {
  abort: (r) => r.abort('failed'),
  html: (r) => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }),
  cut: async (r) => { const resp = await r.fetch(); const body = await resp.text(); await r.fulfill({ status: 200, contentType: 'text/javascript', body: body.slice(0, Math.floor(body.length / 2)) }); },
  hang: () => new Promise(() => {}),
};
async function open(stored, route, { ctx } = {}) {
  const context = ctx || await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (!ctx) await context.addInitScript((v) => { try { if (!sessionStorage.getItem('v6vof')) { sessionStorage.setItem('v6vof', '1'); if (v === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } } catch { /* */ } }, stored);
  const page = await context.newPage();
  const errors = [], reqs = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('request', (r) => { if (/\/assets\/inlineEdit-/.test(r.url())) reqs.push(r.url()); });
  if (route) await page.route(CHUNK, route);
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  const tEditor = Date.now() - t0;
  await page.evaluate(() => {
    window.__toastLog = [];
    const seen = new WeakSet();
    const scan = () => { for (const e of document.querySelectorAll('.mdr-toast')) if (!seen.has(e)) { seen.add(e); window.__toastLog.push({ text: e.querySelector('.mdr-toast__text')?.textContent ?? e.textContent, cls: e.className, at: Math.round(performance.now()) }); } };
    scan(); new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  });
  return { context, page, errors, reqs, tEditor };
}
const toastLog = (page) => page.evaluate(() => window.__toastLog.slice());
/** How many failure toasts were shown: new toast elements, plus the "×N" the toast stack writes when it merges a repeat. */
const failures = (page) => page.evaluate((F) => {
  const els = window.__toastLog.filter((t) => t.text.startsWith(F)).length;
  const merged = [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent).filter((t) => t.startsWith(F)).map((t) => { const m = /×\s*(\d+)/.exec(t); return m ? Number(m[1]) : 1; });
  return Math.max(els, merged.reduce((a, b) => a + b, 0));
}, FAILED);
async function loadDoc(page) { await page.click('.cm-content'); await page.keyboard.press('Meta+a'); await page.keyboard.insertText(DOC); await sleep(800); }
async function stillWorks(page, label) {
  await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('typed1');
  await sleep(300);
  await page.click('.mdr-preview input[type=checkbox] >> nth=0'); await sleep(500);
  const t0 = (await st(page)).theme;
  await page.keyboard.press('Meta+Shift+L'); await sleep(300);
  await page.click('[data-cmd="view.mode.preview"]'); await sleep(300); await page.click('[data-cmd="view.mode.split"]'); await sleep(400);
  const s = await st(page);
  check(`${label}: the rest of the app works (typing, tick, theme, mode)`, count(s.src, 'typed1') === 1 && s.src.includes('- [x] first box') && s.theme !== t0, JSON.stringify({ typed: count(s.src, 'typed1'), tick: s.src.includes('- [x]'), theme: [t0, s.theme] }));
}
async function startCase(kind) {
  // a control start with stored '0' and no route, then the failing start
  const ctl = await open('0', null); const tCtl = ctl.tEditor; await ctl.context.close();
  const { context, page, errors, reqs, tEditor } = await open('1', routes[kind]);
  try {
    await loadDoc(page);
    await sleep(4800);
    let s = await st(page);
    const tl = await toastLog(page);
    check(`start-${kind}: the editor is not delayed (${tEditor} ms vs ${tCtl} ms with '0')`, tEditor < tCtl + 400, '');
    check(`start-${kind}: one failure toast of the error kind, stored still 1, not pressed, not busy`, tl.filter((t) => t.text === FAILED && /error/.test(t.cls)).length === 1 && s.stored === '1' && s.pressed === 'false' && s.busy === null, JSON.stringify({ tl: tl.map((t) => t.text), st: s.stored, p: s.pressed, b: s.busy, reqs: reqs.length }));
    const n0 = reqs.length;
    await page.click(BTN); await sleep(1200);
    s = await st(page);
    const tl2 = await toastLog(page);
    const nf = await failures(page);
    check(`start-${kind}: a press fails again: toast, stored 0, not pressed, not busy`, nf === 2 && s.stored === '0' && s.pressed === 'false' && s.busy === null, JSON.stringify({ failures: nf, tl: tl2.map((t) => t.text), st: s.stored, p: s.pressed, b: s.busy, newReqs: reqs.length - n0 }));
    await stillWorks(page, `start-${kind}`);
    check(`start-${kind}: no page error`, errors.length === 0, JSON.stringify(errors));
  } finally { await context.close(); }
}
const CASES = {
  'start-abort': () => startCase('abort'),
  'start-html': () => startCase('html'),
  'start-cut': () => startCase('cut'),
  async 'start-hang'() {
    const { context, page, errors, reqs } = await open('1', routes.hang);
    try {
      await loadDoc(page);
      await sleep(4800);
      let s = await st(page);
      const tl = await toastLog(page);
      check('start-hang: chunk asked, not pressed, no toast', reqs.length >= 1 && s.pressed === 'false' && tl.length === 0, JSON.stringify({ reqs: reqs.length, p: s.pressed, b: s.busy, tl: tl.map((t) => t.text) }));
      console.log(`INFO  start-hang: busy while the startup load hangs = ${s.busy}`);
      await stillWorks(page, 'start-hang');
      await page.click(BTN); await sleep(700);
      s = await st(page);
      const tl2 = await toastLog(page);
      check('start-hang: a press joins: busy, loading toast, not pressed', s.busy === 'true' && s.pressed === 'false' && tl2.some((t) => t.text === LOADING), JSON.stringify({ b: s.busy, p: s.pressed, tl: tl2.map((t) => t.text) }));
      await page.click(BTN); await sleep(700);
      s = await st(page);
      const tl3 = await toastLog(page);
      check('start-hang: a second press withdraws: not busy, not pressed, stored 0, loading toast gone', s.busy === null && s.pressed === 'false' && s.stored === '0', JSON.stringify({ b: s.busy, p: s.pressed, st: s.stored, tl: tl3.map((t) => t.text) }));
      const visibleLoading = await page.evaluate((L) => [...document.querySelectorAll('.mdr-toast__text')].some((t) => t.textContent === L), LOADING);
      check('start-hang: the loading toast is dismissed after the withdrawal', !visibleLoading);
      check('start-hang: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
  async 'toggle-html-typing'() {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => { try { if (!localStorage.getItem('v6vof.once')) { localStorage.setItem('v6vof.once', '1'); localStorage.setItem('mdr.previewEdit', '0'); } } catch { /* */ } });
    try {
      let slow = async (r) => { await sleep(500); await routes.html(r); };
      const a = await open('0', slow, { ctx: context });
      await loadDoc(a.page);
      await a.page.click('.cm-content'); await a.page.keyboard.press('Meta+End');
      await a.page.click(BTN);
      await a.page.click('.cm-content'); await a.page.keyboard.press('Meta+End');
      await a.page.keyboard.type('abcdefghij', { delay: 80 });
      await sleep(1200);
      let s = await st(a.page);
      const tl = await toastLog(a.page);
      check('toggle-html-typing: every typed character once, failure toast, stored 0, not pressed', count(s.src, 'abcdefghij') === 1 && tl.some((t) => t.text === FAILED) && s.stored === '0' && s.pressed === 'false', JSON.stringify({ tail: s.src.slice(-14), tl: tl.map((t) => t.text), st: s.stored, p: s.pressed }));
      await a.page.close({ runBeforeUnload: false });
      const b = await open('0', null, { ctx: context });
      await loadDoc(b.page);
      await b.page.click(BTN);
      const on = await b.page.waitForFunction((x) => document.querySelector(x)?.getAttribute('aria-pressed') === 'true', BTN, { timeout: 6000 }).then(() => true, () => false);
      await sleep(400);
      const p = await b.page.evaluate(() => { const e = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('Para 2')); const r = e.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 8 }; });
      await b.page.mouse.click(p.x, p.y); await sleep(500); await b.page.keyboard.type('K'); await sleep(700);
      s = await st(b.page);
      check('toggle-html-typing: after a reload without the failure a press turns it on and a session types once', on && count(s.src, 'K') === 1, JSON.stringify({ on, line: s.src.split(NL).find((l) => l.includes('K')) }));
      check('toggle-html-typing: no page error', a.errors.length + b.errors.length === 0, JSON.stringify([...a.errors, ...b.errors]));
    } finally { await context.close(); }
  },
  async 'toggle-abort-twice'() {
    const { context, page, errors, reqs } = await open('0', routes.abort);
    try {
      await loadDoc(page);
      await page.click(BTN); await sleep(1000);
      const n1 = reqs.length;
      await page.click(BTN); await sleep(1000);
      const s = await st(page);
      const tl = await toastLog(page);
      const nf = await failures(page);
      check('toggle-abort-twice: two failure toasts, stored 0, not pressed, not busy', nf === 2 && s.stored === '0' && s.pressed === 'false' && s.busy === null, JSON.stringify({ tl: tl.map((t) => t.text), st: s.stored, p: s.pressed, b: s.busy, reqs: [n1, reqs.length] }));
      await stillWorks(page, 'toggle-abort-twice');
      check('toggle-abort-twice: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
};
try {
  browser = await chromium.launch({ headless: true });
  const names = only.includes('all') || !only.length ? Object.keys(CASES) : only;
  for (const n of names) {
    if (!CASES[n]) { console.log('no case', n); continue; }
    try { await CASES[n](); } catch (e) { check(`${n}: ran`, false, e.message.split(NL)[0]); }
  }
} finally {
  clearTimeout(KILL);
  console.log(`RESULT ${pass} passed / ${fail} failed`);
  await browser?.close();
  process.exit(fail ? 1 : 0);
}
