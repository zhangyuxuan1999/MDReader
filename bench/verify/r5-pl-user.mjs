// bench/verify/r5-pl-user.mjs — proto-lazy (0.2.0 stage 2f, rules L3, L4, L8): a REAL USER of a production build (no
// ?perf=1, no test hooks; everything through the DOM and the keyboard) and the editing chunk loaded on demand.
//   MDR_URL=http://localhost:5472/ node bench/verify/r5-pl-user.mjs [case-prefix ...]
// The chunk is /assets/inlineEdit-*.js; a Playwright route holds it back, aborts it or answers it with index.html.
// Cases:
//   time-*          stored '1' vs stored '0' at 10 Mbit/s (3 alternating runs, cache off): time to .cm-content and to the
//                   first preview block of the typed start document; when the chunk request starts and ends.
//   stored1-held    stored '1', chunk held: button not pressed, a click on a block starts no session and the source is
//                   unchanged; released: button pressed, stored still '1', a click starts a session, typed text arrives.
//   toggle-held     stored '0', chunk held: the button click does not press it, no toast; on, off, on in quick
//                   succession; released: pressed, stored '1', one toast 开, one typed character arrives once.
//   toggle-withdraw stored '0', chunk held: on, off; released: not pressed, stored '0', no editing element.
//   fail-abort      stored '0': the chunk request aborted: the failure toast, not pressed, stored '0'; then the route
//                   lets it through and the button is clicked again: what happens (requests counted).
//   fail-html       the same with the chunk answered by index.html, status 200, text/html (a single-page fallback).
//   fail-startup    stored '1' and the chunk aborted at startup: the toast, not pressed, stored still '1'.
//   off-on          stored '0': on (chunk arrives), a session, off, on again: immediate, one chunk request in all.
// PASS / FAIL lines, exit 0 all pass, 1 a failure, 3 global timeout (110 s). Writes nothing.
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || `http://localhost:${process.env.MDR_PORT || 5472}/`).replace(/\/?$/, '/');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const CHUNK = '**/assets/inlineEdit-*.js';
const LOAD_FAILED = '预览编辑功能加载失败';
const DOC = ['# Lazy check', '', ...Array.from({ length: 30 }, (_, i) => `Para ${i + 1} text of the lazy check, long enough to wrap a little.` + NL)].join(NL);

const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const editingEls = (page) => page.evaluate(() => ({
  ce: document.querySelectorAll('.mdr-preview [contenteditable]').length,
  editing: document.querySelectorAll('.mdr-preview .is-editing').length,
  hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
}));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

async function open(storedValue, { route } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  await context.addInitScript((v) => { try { if (v === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } catch { /* */ } }, storedValue);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const reqs = [];
  page.on('request', (r) => { if (/\/assets\/inlineEdit-/.test(r.url())) reqs.push(r.url()); });
  if (route) await page.route(CHUNK, route);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(300);
  // after the first visit the init script must not reset what the app stored (it runs on every navigation)
  return { context, page, errors, reqs };
}
async function loadDoc(page) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(DOC);
  await sleep(900);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(400);
}
const pointOf = (page, needle) => page.evaluate((t) => {
  const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
  if (!p) return null;
  const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(t); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  }
  return null;
}, needle);
async function clickPara(page, needle) {
  const p = await pointOf(page, needle);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  return true;
}
const clickButton = (page) => page.click('[data-cmd="view.togglePreviewEdit"]');
/** A route that holds the chunk until release() is called. */
function holder() {
  let release, n = 0;
  const gate = new Promise((r) => { release = r; });
  return { route: async (route) => { n++; await gate; await route.continue(); }, release: () => release(), count: () => n };
}
const count = (s, sub) => s.split(sub).length - 1;

const CASES = {
  async 'time-stored'() {
    const res = { '0': [], '1': [] };
    for (let i = 0; i < 3; i++) {
      for (const v of i % 2 ? ['1', '0'] : ['0', '1']) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await context.addInitScript((x) => { try { localStorage.setItem('mdr.previewEdit', x); } catch { /* */ } }, v);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 10e6 / 8, uploadThroughput: 10e6 / 8 });
        const t0 = Date.now();
        let chunkStart = null, chunkEnd = null;
        page.on('request', (r) => { if (/inlineEdit-/.test(r.url())) chunkStart = Date.now() - t0; });
        page.on('requestfinished', (r) => { if (/inlineEdit-/.test(r.url())) chunkEnd = Date.now() - t0; });
        await page.goto(BASE);
        await page.waitForSelector('.cm-content', { timeout: 30000 });
        const tEditor = Date.now() - t0;
        await page.waitForSelector('.mdr-preview', { timeout: 30000 });
        // the start document is empty: the first block appears once a text is typed; measure the worker round trip
        await page.click('.cm-content');
        const t1 = Date.now();
        await page.keyboard.insertText('# Hello' + NL + NL + 'world');
        await page.waitForSelector('.mdr-preview .md-block h1', { timeout: 30000 });
        const tFirst = Date.now() - t0, tRender = Date.now() - t1;
        if (v === '1') await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 30000 });
        const tOn = Date.now() - t0;
        res[v].push({ tEditor, tFirst, tRender, chunkStart, chunkEnd, tOn });
        await context.close();
      }
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    for (const k of ['tEditor', 'tFirst', 'tRender', 'chunkStart', 'chunkEnd', 'tOn']) {
      console.log(`  ${k.padEnd(10)} stored1 ${String(med(res['1'].map((r) => r[k] ?? -1))).padStart(6)} [${res['1'].map((r) => r[k]).join(',')}]  stored0 ${String(med(res['0'].map((r) => r[k] ?? -1))).padStart(6)} [${res['0'].map((r) => r[k]).join(',')}]`);
    }
    check('time: stored 0 never requests the chunk', res['0'].every((r) => r.chunkStart === null));
    check('time: stored 1 requests the chunk after the editor exists or beside it', res['1'].every((r) => r.chunkStart !== null));
    const e1 = med(res['1'].map((r) => r.tEditor)), e0 = med(res['0'].map((r) => r.tEditor));
    check('time: editor with stored 1 within 15 % (or 60 ms) of stored 0 (median)', e1 <= Math.max(e0 * 1.15, e0 + 60), `${e1} vs ${e0}`);
  },

  async 'stored1-held'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('1', { route: h.route });
    try {
      await loadDoc(page);
      check('stored1-held: chunk requested', h.count() === 1, String(h.count()));
      check('stored1-held: button not pressed while the chunk is on its way', (await pressed(page)) === 'false', String(await pressed(page)));
      check('stored1-held: stored value still 1', (await stored(page)) === '1');
      const before = await source(page);
      check('stored1-held: clicked a paragraph', await clickPara(page, 'Para 3 text'));
      await page.keyboard.type('x');
      await sleep(300);
      const el1 = await editingEls(page);
      check('stored1-held: no session, no editing element', el1.ce === 0 && el1.editing === 0 && el1.hint === 0, JSON.stringify(el1));
      check('stored1-held: the source is unchanged by the click and the key', (await source(page)) === before);
      check('stored1-held: no toast yet', (await toasts(page)).length === 0, JSON.stringify(await toasts(page)));
      h.release();
      await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
      check('stored1-held: released: button pressed', (await pressed(page)) === 'true');
      check('stored1-held: stored value 1', (await stored(page)) === '1');
      check('stored1-held: no toast at startup (as before rule L)', (await toasts(page)).length === 0, JSON.stringify(await toasts(page)));
      check('stored1-held: clicked a paragraph', await clickPara(page, 'Para 5 text'));
      const el2 = await editingEls(page);
      check('stored1-held: a session started', el2.editing === 1, JSON.stringify(el2));
      await page.keyboard.type('QJ');
      await sleep(600);
      const src = await source(page);
      check('stored1-held: typed text reached the source once', count(src, 'QJ') === 1, src.split(NL).find((l) => l.includes('Para 5')) ?? '');
      check('stored1-held: one chunk request', reqs.length === 1, String(reqs.length));
      check('stored1-held: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },

  async 'toggle-held'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      check('toggle-held: no chunk request at rest', h.count() === 0);
      await clickButton(page);
      await sleep(200);
      check('toggle-held: chunk requested by the button', h.count() === 1, String(h.count()));
      check('toggle-held: button not pressed while the chunk is held', (await pressed(page)) === 'false');
      check('toggle-held: stored still 0', (await stored(page)) === '0');
      check('toggle-held: no toast yet', (await toasts(page)).length === 0, JSON.stringify(await toasts(page)));
      check('toggle-held: clicked a paragraph meanwhile', await clickPara(page, 'Para 2 text'));
      check('toggle-held: no session meanwhile', (await editingEls(page)).editing === 0);
      await clickButton(page);           // off (withdraws)
      await clickButton(page);           // on again
      await sleep(100);
      check('toggle-held: still one chunk request', h.count() === 1, String(h.count()));
      h.release();
      await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
      await sleep(300);
      check('toggle-held: released: pressed (the last toggle was on)', (await pressed(page)) === 'true');
      check('toggle-held: stored 1', (await stored(page)) === '1');
      const ts = await toasts(page);
      check('toggle-held: toasts: one 关 (the withdrawal, true at once) and one 开', count(ts.join('|'), '预览可编辑（实验性）：开') === 1 && count(ts.join('|'), '预览可编辑：关') === 1, JSON.stringify(ts));
      check('toggle-held: clicked a paragraph', await clickPara(page, 'Para 4 text'));
      check('toggle-held: a session started', (await editingEls(page)).editing === 1);
      await page.keyboard.type('K');
      await sleep(600);
      const line = (await source(page)).split(NL).find((l) => l.includes('K')) ?? '';
      check('toggle-held: one typed character arrives once (one instance)', count(await source(page), 'K') === 1 && /Pa.?.?ra 4 /.test(line), line);
      check('toggle-held: one hint element (one instance)', (await editingEls(page)).hint === 1);
      check('toggle-held: one chunk request in all', reqs.length === 1, String(reqs.length));
      check('toggle-held: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },

  async 'toggle-withdraw'() {
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await clickButton(page);
      await sleep(100);
      h.release();
      await sleep(1200);
      check('toggle-withdraw: not pressed', (await pressed(page)) === 'false');
      check('toggle-withdraw: stored 0', (await stored(page)) === '0');
      const el = await editingEls(page);
      check('toggle-withdraw: no editing element (module loaded, not installed)', el.ce === 0 && el.editing === 0 && el.hint === 0, JSON.stringify(el));
      check('toggle-withdraw: clicked a paragraph', await clickPara(page, 'Para 2 text'));
      check('toggle-withdraw: no session', (await editingEls(page)).editing === 0);
      const ts = await toasts(page);
      check('toggle-withdraw: no 开 toast', !ts.some((t) => t.includes('：开')), JSON.stringify(ts));
      // turning it on now is immediate (the chunk is here)
      await clickButton(page);
      await sleep(50);
      check('toggle-withdraw: on again: pressed at once', (await pressed(page)) === 'true');
      check('toggle-withdraw: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },

  async 'fail-abort'() { await failCase('fail-abort', (route) => route.abort('internetdisconnected')); },
  async 'fail-html'() {
    const html = await (await fetch(BASE)).text();
    await failCase('fail-html', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  },

  async 'fail-startup'() {
    let n = 0;
    const { context, page, errors } = await open('1', { route: (route) => { n++; return route.abort('internetdisconnected'); } });
    try {
      await sleep(1000);
      const ts = await toasts(page);
      check('fail-startup: the failure toast', ts.some((t) => t.includes(LOAD_FAILED)), JSON.stringify(ts));
      check('fail-startup: not pressed', (await pressed(page)) === 'false');
      check('fail-startup: stored 1 not rewritten', (await stored(page)) === '1', String(await stored(page)));
      await loadDoc(page);
      check('fail-startup: the preview renders', (await page.locator('.mdr-preview .md-block p').count()) > 3);
      check('fail-startup: clicked a paragraph', await clickPara(page, 'Para 3 text'));
      check('fail-startup: no session', (await editingEls(page)).editing === 0);
      check('fail-startup: no page error', errors.length === 0, errors.join(' | '));
      console.log(`  fail-startup: chunk requests ${n}`);
    } finally { await context.close(); }
  },

  async 'off-on'() {
    const { context, page, errors, reqs } = await open('0');
    try {
      await loadDoc(page);
      await clickButton(page);
      await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
      check('off-on: on', (await pressed(page)) === 'true');
      check('off-on: clicked a paragraph', await clickPara(page, 'Para 6 text'));
      await page.keyboard.type('V');
      await sleep(500);
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.keyboard.press('Meta+Shift+KeyE');
      await sleep(300);
      check('off-on: off: not pressed, stored 0', (await pressed(page)) === 'false' && (await stored(page)) === '0');
      const el = await editingEls(page);
      check('off-on: off: no contenteditable / session, the hint stays hidden', el.ce === 0 && el.editing === 0 && (await page.evaluate(() => document.querySelector('.mdr-preview__edit-hint')?.hidden)) === true, JSON.stringify(el));
      await clickButton(page);
      await sleep(30);
      check('off-on: on again: pressed at once', (await pressed(page)) === 'true');
      check('off-on: clicked a paragraph', await clickPara(page, 'Para 7 text'));
      await page.keyboard.type('W');
      await sleep(500);
      const src = await source(page);
      check('off-on: both typed characters once', count(src, 'V') === 1 && count(src, 'W') === 1, JSON.stringify(src.split(NL).filter((l) => /Para [67] /.test(l))));
      check('off-on: one chunk request in all', reqs.length === 1, String(reqs.length));
      check('off-on: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
};

async function failCase(name, failWith) {
  let failing = true, n = 0;
  const { context, page, errors, reqs } = await open('0', { route: (route) => { n++; return failing ? failWith(route) : route.continue(); } });
  try {
    await loadDoc(page);
    await clickButton(page);
    await sleep(1000);
    const ts = await toasts(page);
    check(`${name}: the failure toast`, ts.some((t) => t.includes(LOAD_FAILED)), JSON.stringify(ts));
    check(`${name}: no 开 toast`, !ts.some((t) => t.includes('：开')));
    check(`${name}: not pressed`, (await pressed(page)) === 'false');
    check(`${name}: stored still 0`, (await stored(page)) === '0', String(await stored(page)));
    check(`${name}: clicked a paragraph`, await clickPara(page, 'Para 3 text'));
    check(`${name}: no session`, (await editingEls(page)).editing === 0);
    const n1 = n;
    failing = false;
    await clickButton(page);
    await sleep(1500);
    const n2 = n, r2 = reqs.length;
    const after = { pressed: await pressed(page), stored: await stored(page), toasts: await toasts(page) };
    console.log(`  ${name}: second toggle after the failure: route calls ${n1} -> ${n2}, requests seen ${r2}, ${JSON.stringify(after)}`);
    if (after.pressed !== 'true') {
      // what a reload does
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.cm-content', { timeout: 20000 });
      await sleep(300);
      await loadDoc(page);
      await clickButton(page);
      await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
      console.log(`  ${name}: after a reload and a toggle: pressed ${await pressed(page)}, stored ${await stored(page)}`);
      check(`${name}: after a reload the toggle works`, (await pressed(page)) === 'true');
    } else check(`${name}: the second toggle works`, true);
    check(`${name}: no page error`, errors.length === 0, errors.join(' | '));
  } finally { await context.close(); }
}

browser = await chromium.launch({ headless: true });
try {
  for (const [n, fn] of Object.entries(CASES)) {
    if (only.length && !only.some((o) => n.startsWith(o))) continue;
    try { await fn(); } catch (err) { fail++; console.log(`FAIL  ${n}: ${String(err && err.message || err).split(NL)[0]}`); }
  }
} finally {
  clearTimeout(KILL);
  await browser.close();
}
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
void fs;
