// bench/verify/r5-fl-loading.mjs — fix-lazy (0.2.0 stage 2f, the lead's final rule L, RL-2): a REAL USER of a production
// build (no ?perf=1) presses 预览可编辑 while the editing chunk (/assets/inlineEdit-*.js) is held back.
//   MDR_URL=http://localhost:5474/ node bench/verify/r5-fl-loading.mjs [case ...]
// Cases:
//   slow       stored '0', one press, chunk held 900 ms: aria-busy at once; no loading toast before 300 ms, then exactly
//              one 正在加载预览编辑功能…; not pressed and stored '0' meanwhile; released: aria-busy and the loading toast
//              gone, pressed, stored '1', one 开 toast, a session works.
//   withdraw   stored '0', press then press again within 100 ms while held: aria-busy gone at once, no loading toast
//              ever, 关 toast; released: not pressed, stored '0'.
//   startup    stored '1', chunk held: once the deferred start asks for it the button is aria-busy but no loading toast
//              appears (nobody pressed); released: pressed, aria-busy gone, no toast.
//   fail       stored '0', chunk answered 404: after the press the error toast 预览编辑功能加载失败，请刷新页面或重启应用后重试,
//              aria-busy gone, the loading toast gone, stored '0'.
// PASS / FAIL lines, exit 0 all pass, 1 a failure, 3 global timeout (100 s). Writes nothing.
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || `http://localhost:${process.env.MDR_PORT || 5474}/`).replace(/\/?$/, '/');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);
const CHUNK = '**/assets/inlineEdit-*.js';
const BTN = '[data-cmd="view.togglePreviewEdit"]';
const LOADING = '正在加载预览编辑功能…';
const FAILED = '预览编辑功能加载失败，请刷新页面或重启应用后重试';
const DOC = ['# Loading check', '', ...Array.from({ length: 12 }, (_, i) => `Para ${i + 1} text of the loading check, long enough.` + NL)].join(NL);

const attr = (page, a) => page.evaluate(([b, x]) => document.querySelector(b)?.getAttribute(x) ?? null, [BTN, a]);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const nOf = async (page, needle) => (await toasts(page)).filter((t) => t.includes(needle)).length;
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

async function open(v, route) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  await context.addInitScript((x) => { try { if (!sessionStorage.getItem('r5fl')) { sessionStorage.setItem('r5fl', '1'); localStorage.setItem('mdr.previewEdit', x); } } catch { /* */ } }, v);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  if (route) await page.route(CHUNK, route);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector(BTN, { timeout: 20000 });
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(DOC);
  await sleep(900);
  return { context, page, errors };
}
function holder() {
  let release, n = 0;
  const gate = new Promise((r) => { release = r; });
  return { route: async (route) => { n++; await gate; await route.continue(); }, release: () => release(), count: () => n };
}
async function sessionWorks(page, label) {
  const p = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('Para 4 text'));
    if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  });
  if (!p) { check(`${label}: a paragraph to click`, false); return; }
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  await page.keyboard.type('Zq');
  await sleep(700);
  const src = await source(page);
  check(`${label}: a session works (typed text in the source once)`, src.split('Zq').length - 1 === 1, src.split(NL).find((l) => l.includes('Zq')) ?? '');
  await page.keyboard.press('Escape');
}

const CASES = {
  async slow() {
    const h = holder();
    const { context, page, errors } = await open('0', h.route);
    try {
      await page.click(BTN);
      await sleep(60);
      check('slow: aria-busy at once', (await attr(page, 'aria-busy')) === 'true', String(await attr(page, 'aria-busy')));
      check('slow: not pressed while held', (await attr(page, 'aria-pressed')) === 'false');
      check('slow: no loading toast before 300 ms', (await nOf(page, LOADING)) === 0, JSON.stringify(await toasts(page)));
      await sleep(500);
      check('slow: one loading toast after 300 ms', (await nOf(page, LOADING)) === 1, JSON.stringify(await toasts(page)));
      check('slow: still not pressed, stored 0', (await attr(page, 'aria-pressed')) === 'false' && (await stored(page)) === '0', `${await attr(page, 'aria-pressed')} ${await stored(page)}`);
      await sleep(400);
      check('slow: the loading toast is not repeated', (await nOf(page, LOADING)) === 1 && !(await toasts(page)).some((t) => t.includes(LOADING + ' ×')), JSON.stringify(await toasts(page)));
      h.release();
      await page.waitForFunction((b) => document.querySelector(b)?.getAttribute('aria-pressed') === 'true', BTN, { timeout: 8000 }).catch(() => {});
      await sleep(100);
      check('slow: released: pressed, stored 1', (await attr(page, 'aria-pressed')) === 'true' && (await stored(page)) === '1', `${await attr(page, 'aria-pressed')} ${await stored(page)}`);
      check('slow: released: aria-busy gone', (await attr(page, 'aria-busy')) === null);
      check('slow: released: the loading toast gone, one 开 toast', (await nOf(page, LOADING)) === 0 && (await nOf(page, '预览可编辑（实验性）：开')) === 1, JSON.stringify(await toasts(page)));
      await sessionWorks(page, 'slow');
      check('slow: one chunk request', h.count() === 1, String(h.count()));
      check('slow: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async withdraw() {
    const h = holder();
    const { context, page, errors } = await open('0', h.route);
    try {
      await page.click(BTN);
      await sleep(30);
      check('withdraw: aria-busy after the first press', (await attr(page, 'aria-busy')) === 'true');
      await page.click(BTN);
      await sleep(30);
      check('withdraw: aria-busy gone at once after the withdrawal', (await attr(page, 'aria-busy')) === null, String(await attr(page, 'aria-busy')));
      await sleep(600);
      check('withdraw: no loading toast at all', (await nOf(page, LOADING)) === 0, JSON.stringify(await toasts(page)));
      check('withdraw: the 关 toast', (await nOf(page, '预览可编辑：关')) === 1, JSON.stringify(await toasts(page)));
      h.release();
      await sleep(1000);
      check('withdraw: released: not pressed, stored 0, not busy', (await attr(page, 'aria-pressed')) === 'false' && (await stored(page)) === '0' && (await attr(page, 'aria-busy')) === null, `${await attr(page, 'aria-pressed')} ${await stored(page)} ${await attr(page, 'aria-busy')}`);
      check('withdraw: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async startup() {
    const h = holder();
    const { context, page, errors } = await open('1', h.route);
    try {
      await page.waitForFunction(() => true);
      for (let i = 0; i < 50 && h.count() === 0; i++) await sleep(100);
      check('startup: the deferred start asked for the chunk', h.count() === 1, String(h.count()));
      await sleep(100);
      check('startup: aria-busy while it is on its way', (await attr(page, 'aria-busy')) === 'true', String(await attr(page, 'aria-busy')));
      await sleep(500);
      check('startup: no loading toast (nobody pressed)', (await nOf(page, LOADING)) === 0, JSON.stringify(await toasts(page)));
      h.release();
      await page.waitForFunction((b) => document.querySelector(b)?.getAttribute('aria-pressed') === 'true', BTN, { timeout: 8000 }).catch(() => {});
      await sleep(100);
      check('startup: released: pressed, not busy, stored 1, no toast', (await attr(page, 'aria-pressed')) === 'true' && (await attr(page, 'aria-busy')) === null && (await stored(page)) === '1' && (await toasts(page)).length === 0, `${await attr(page, 'aria-pressed')} ${await attr(page, 'aria-busy')} ${await stored(page)} ${JSON.stringify(await toasts(page))}`);
      check('startup: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async fail() {
    const route = async (r) => { await sleep(600); await r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }); };
    const { context, page, errors } = await open('0', route);
    try {
      await page.click(BTN);
      await sleep(450);
      check('fail: the loading toast while it is on its way', (await nOf(page, LOADING)) === 1, JSON.stringify(await toasts(page)));
      await sleep(900);
      const ts = await toasts(page);
      check('fail: the error toast with the reload / restart text', ts.includes(FAILED), JSON.stringify(ts));
      const kind = await page.evaluate((t) => [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes(t))?.className ?? '', FAILED);
      check('fail: it is of the error kind', kind.includes('mdr-toast--error'), kind);
      check('fail: the loading toast gone, not busy, not pressed, stored 0', (await nOf(page, LOADING)) === 0 && (await attr(page, 'aria-busy')) === null && (await attr(page, 'aria-pressed')) === 'false' && (await stored(page)) === '0', `${JSON.stringify(ts)} ${await attr(page, 'aria-busy')} ${await attr(page, 'aria-pressed')} ${await stored(page)}`);
      check('fail: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
};

try {
  browser = await chromium.launch({ headless: true });
  for (const [k, f] of Object.entries(CASES)) {
    if (only.length && !only.includes(k)) continue;
    console.log(`== ${k}`);
    try { await f(); } catch (e) { check(`${k}: ran`, false, String(e?.message ?? e).slice(0, 200)); }
  }
} finally {
  clearTimeout(KILL);
  await browser?.close().catch(() => {});
  console.log(`RESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
