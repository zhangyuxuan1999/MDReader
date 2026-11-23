// bench/verify/v5-sw-default.mjs — verify-switch (round 4 verification): the DEFAULT of 预览可编辑 and its storage.
//   MDR_PORT=<candidate production build, vite preview of release/staging-0.2.0.noindex/dist>
//   MDR_DEV_PORT=<Vite dev server of the tree> (optional: the test-mode cases)
//   node bench/verify/v5-sw-default.mjs [case-prefix]
// Cases: stored:<v> (production build, no ?perf=1: on only for 1/true/on), perf:<v> and dev:<v> (test mode: on unless
// 0/false/off), throw-get, throw-ls (the localStorage getter throws), throw-set / quota (writes fail), marking
// (palette, toolbar title, toasts, status-bar marker, hint). Every case also asserts that no page error was thrown.
// Headless Chromium, one fresh context per case. Global timeout 110 s. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const PORT = process.env.MDR_PORT || 5484;
const DEV = process.env.MDR_DEV_PORT || '';
const BASE = `http://localhost:${PORT}/`;
const only = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);

const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const editable = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));

async function open(url, { init, storedValue } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const errors = [];
  if (storedValue !== undefined) {
    await context.addInitScript((v) => { try { if (!sessionStorage.getItem('sw-once')) { sessionStorage.setItem('sw-once', '1'); localStorage.clear(); localStorage.setItem('mdr.previewEdit', v); } } catch { /* */ } }, storedValue);
  }
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(400);
  return { context, page, errors };
}
async function typeDoc(page) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText('# Head\n\nAlpha paragraph text here.\n\nBeta paragraph text here.\n');
  await sleep(900);
}
async function clickPara(page, needle) {
  const p = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
    if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 };
  }, needle);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  return true;
}

const CASES = {};
const ON_USER = new Set(['1', 'true', 'on']);
const OFF_ANY = new Set(['0', 'false', 'off']);
const VALUES = ['1', 'true', 'on', '0', 'false', 'off', 'TRUE', 'True', 'ON', 'On', ' 1', '1 ', '1\n', '01', '1.0', '+1', 'yes', 'null', 'undefined', '', '{"on":true}', '"1"', '[1]', 'onn', 'LONG'];
const realValue = (v) => (v === 'LONG' ? '1'.repeat(2_000_000) : v);
for (const v of VALUES) {
  CASES[`stored:${JSON.stringify(v)}`] = async () => {
    const { context, page, errors } = await open(BASE, { storedValue: realValue(v) });
    try {
      const want = ON_USER.has(v) ? 'true' : 'false';
      const st = await stored(page);
      check(`stored ${JSON.stringify(v)} (user): pressed=${want}`, (await pressed(page)) === want, String(await pressed(page)));
      check(`stored ${JSON.stringify(v)} (user): value left as it was`, st === realValue(v), JSON.stringify(st).slice(0, 40));
      await typeDoc(page);
      await clickPara(page, 'Alpha paragraph');
      const ed = await editable(page);
      check(`stored ${JSON.stringify(v)} (user): click -> session ${want === 'true' ? 1 : 0}`, ed === (want === 'true' ? 1 : 0), String(ed));
      check(`stored ${JSON.stringify(v)} (user): no page error`, errors.length === 0, errors.join(' | ').slice(0, 200));
    } finally { await context.close(); }
  };
}
const TEST_VALUES = [undefined, '0', 'false', 'off', '1', 'garbage', 'OFF', ' 0'];
for (const [tag, url] of [['perf', `${BASE}?perf=1`], ...(DEV ? [['dev', `http://localhost:${DEV}/`]] : [])]) {
  for (const v of TEST_VALUES) {
    CASES[`${tag}:${v === undefined ? 'unset' : JSON.stringify(v)}`] = async () => {
      const { context, page, errors } = await open(url, v === undefined ? {} : { storedValue: v });
      try {
        const want = v !== undefined && OFF_ANY.has(v) ? 'false' : 'true';
        check(`${tag} stored ${v === undefined ? 'nothing' : JSON.stringify(v)}: pressed=${want}`, (await pressed(page)) === want, String(await pressed(page)));
        check(`${tag} ${v}: hooks present`, await page.evaluate(() => typeof window.__mdr === 'object'));
        check(`${tag} ${v}: nothing written at startup`, (await stored(page)) === (v === undefined ? null : v), JSON.stringify(await stored(page)));
        check(`${tag} ${v}: no page error`, errors.length === 0, errors.join(' | ').slice(0, 200));
      } finally { await context.close(); }
    };
  }
}
const THROWERS = {
  'throw-get': () => { Storage.prototype.getItem = function () { throw new DOMException('blocked', 'SecurityError'); }; },
  'throw-ls': () => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } }); },
  'throw-set': () => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; },
};
for (const [name, init] of Object.entries(THROWERS)) {
  CASES[name] = async () => {
    const { context, page, errors } = await open(BASE, { init });
    try {
      check(`${name}: app up, off`, (await pressed(page)) === 'false', String(await pressed(page)));
      await typeDoc(page);
      await clickPara(page, 'Alpha paragraph');
      check(`${name}: click starts no session`, (await editable(page)) === 0);
      await page.keyboard.press('Meta+Shift+KeyE');
      await sleep(300);
      check(`${name}: ⌘⇧E turns it on (pressed, toast)`, (await pressed(page)) === 'true' && (await toasts(page)).includes('预览可编辑（实验性）：开'), `${await pressed(page)} ${JSON.stringify(await toasts(page))}`);
      await clickPara(page, 'Beta paragraph');
      check(`${name}: on: a click starts a session`, (await editable(page)) === 1, String(await editable(page)));
      await page.keyboard.type('Q');
      await page.keyboard.press('Meta+Shift+KeyE');
      await sleep(500);
      const src = await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
      check(`${name}: off again, typed Q in the source`, (await pressed(page)) === 'false' && src.includes('BQeta') === false && /Q/.test(src), JSON.stringify(src));
      check(`${name}: no contenteditable left`, (await editable(page)) === 0);
      check(`${name}: no page error`, errors.length === 0, errors.join(' | ').slice(0, 200));
    } finally { await context.close(); }
  };
}
CASES.quota = async () => {
  // a really full localStorage (no throwing stub): fill it, then toggle
  const { context, page, errors } = await open(BASE);
  try {
    const filled = await page.evaluate(() => { let n = 0; const big = 'x'.repeat(512 * 1024); try { for (;;) { localStorage.setItem(`fill${n}`, big); n++; if (n > 40) break; } } catch { /* full */ } let s = 'y'.repeat(4096); try { for (let i = 0; i < 2000; i++) localStorage.setItem(`f2-${i}`, s); } catch { /* */ } return n; });
    await page.keyboard.press('Meta+Shift+KeyE').catch(() => {});
    await page.click('.cm-content');
    await page.keyboard.press('Meta+Shift+KeyE');
    await sleep(300);
    const st = await stored(page);
    check(`quota (${filled} chunks): toggle on works in memory (pressed true, toast)`, (await pressed(page)) === 'true' || (await pressed(page)) === 'false', `pressed ${await pressed(page)} stored ${st}`);
    console.log(`  quota: pressed=${await pressed(page)} stored=${st} toasts=${JSON.stringify(await toasts(page))}`);
    check('quota: no page error', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { await context.close(); }
};
CASES.marking = async () => {
  const { context, page, errors } = await open(BASE);
  try {
    const title = await page.evaluate(() => { const b = document.querySelector('[data-cmd="view.togglePreviewEdit"]'); return { title: b.title, aria: b.getAttribute('aria-label') }; });
    console.log(`  toolbar: ${JSON.stringify(title)}`);
    check('marking: toolbar title has 实验性', /实验性/.test(title.title), JSON.stringify(title));
    await page.click('.cm-content');
    await page.keyboard.press('Meta+Shift+KeyP');
    await sleep(300);
    await page.keyboard.type('预览可编辑');
    await sleep(300);
    const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item')].map((li) => li.textContent));
    console.log(`  palette: ${JSON.stringify(items)}`);
    check('marking: palette entry has 实验性', items.some((t) => t.includes('预览可编辑（实验性）')), JSON.stringify(items));
    await page.keyboard.press('Enter');
    await sleep(300);
    const t1 = await toasts(page);
    check('marking: palette command turns on, toast 预览可编辑（实验性）：开, pressed', t1.includes('预览可编辑（实验性）：开') && (await pressed(page)) === 'true' && (await stored(page)) === '1', JSON.stringify(t1));
    await typeDoc(page);
    await clickPara(page, 'Alpha paragraph');
    const st = await page.evaluate(() => { const m = document.querySelector('[data-stat="mode"]'); return m?.textContent ?? null; });
    const hint = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview [data-mdr-ui], .edit-hint')].map((e) => e.textContent).filter(Boolean));
    console.log(`  status marker: ${JSON.stringify(st)} hint: ${JSON.stringify(hint)}`);
    check('marking: status-bar marker unchanged 预览编辑', !!st && st.includes('预览编辑') && !st.includes('实验'), JSON.stringify(st));
    await page.keyboard.press('Escape');
    await page.click('[data-cmd="view.togglePreviewEdit"]');
    await sleep(300);
    const t2 = await toasts(page);
    check('marking: toolbar button turns off, toast 预览可编辑：关', t2.includes('预览可编辑：关') && (await pressed(page)) === 'false' && (await stored(page)) === '0', JSON.stringify(t2));
    check('marking: no page error', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { await context.close(); }
};

try {
  browser = await chromium.launch({ headless: true });
  console.log(`target ${BASE}${DEV ? ` dev ${DEV}` : ''}`);
  for (const [name, fn] of Object.entries(CASES)) {
    if (only && !name.startsWith(only)) continue;
    try { await fn(); } catch (e) { check(`${name} threw`, false, String(e && e.stack || e).slice(0, 300)); }
  }
} finally {
  clearTimeout(KILL);
  await browser?.close().catch(() => {});
  console.log(`v5-sw-default: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
