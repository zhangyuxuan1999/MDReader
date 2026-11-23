// bench/verify/v6-von-user.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): a REAL USER of the candidate's
// production build (no ?perf=1, no test hooks: the document typed into the editor, the source read from CodeMirror's
// lines, the caret placed with the DOM selection API) with the session module arriving through its dynamic import.
// Cases:
//   first      stored '1': wait until the switch is on; the first click on a block, typing, Esc; a second session on
//              another block; a join (Backspace at an item start) in a task list with formulas, Esc: atoms byte for byte,
//              the marker the user saw; a join in a quote with an image and a link with an escaped invisible character.
//   loading    stored '0', the chunk held: press the button, click a block during the load, type; release: what was
//              written; then a click starts a session and typing arrives once.
//   offmid     a session, typing, the switch turned off with ⌘⇧E in the middle: the session ends, the text is kept; on
//              again: a click starts a session that works.
// Run: MDR_URL=http://localhost:5483/ node bench/verify/v6-von-user.mjs [case ...]
// PASS / FAIL lines, exit 0 all pass, 1 a failure, 3 global timeout (T_MS, default 110 s). Writes nothing into the tree.
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || 'http://localhost:5483/').replace(/\/?$/, '/');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, Number(process.env.T_MS ?? 110_000));
const CHUNK = '**/assets/inlineEdit-*.js';
const ZW = String.fromCharCode(0x200b);
const INV = new RegExp('[' + [0x200b, 0xfeff, 0x2060, 0xa0, 0x202e].map((c) => String.fromCharCode(c)).join('') + ']');

const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const editing = (page) => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));

async function open(storedValue, { route } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  await context.addInitScript((v) => { try { if (!sessionStorage.getItem('v6init')) { sessionStorage.setItem('v6init', '1'); if (v === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } } catch { /* */ } }, storedValue);
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
  return { context, page, errors, reqs };
}
async function loadDoc(page, doc) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(doc);
  await sleep(1000);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(300);
}
/** A click on character k of the first preview text holding `needle` (the session starts on the release). */
async function clickText(page, needle, k = 1) {
  const p = await page.evaluate(({ t, k }) => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui], .katex-mathml') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(t); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getClientRects()[0] ?? r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { t: needle, k });
  if (!p) throw new Error('not shown: ' + needle);
  await page.mouse.click(p.x, p.y);
  await sleep(450);
}
const selectAt = (page, a, b = a) => page.evaluate(({ a, b }) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  if (!el) throw new Error('no session');
  const at = ([needle, k]) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, [data-mdr-ui]') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) return [n, i + k]; }
    throw new Error('selectAt: ' + needle);
  };
  const [an, ao] = at(a), [fn, fo] = at(b);
  getSelection().setBaseAndExtent(an, ao, fn, fo);
}, { a, b });
async function waitPressed(page, v = 'true', ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if ((await pressed(page)) === v) return true; await sleep(100); } return false; }
async function esc(page) { await page.keyboard.press('Escape'); await sleep(700); return source(page); }
function holder() {
  let release; const gate = new Promise((r) => { release = r; });
  return { route: async (route) => { await gate; await route.continue(); }, release: () => release() };
}

const DOC = [
  '# User check', '',
  'Para one words here.', '',
  'Para two $x^2$ words.', '',
  '- [ ] one first',
  '- [x] Lead $\\frac{a}{b}$ two',
  '- [ ] three $y_1$ end', '',
  `> quote first`, '>',
  `> Lead ![im](p%20q.png "T") and [l](https://e.example/a%E2%80%8Bb) two`, '',
  'last para', '',
].join('\n');

const CASES = {
  async first() {
    const { context, page, errors, reqs } = await open('1');
    try {
      await loadDoc(page, DOC);
      const on = await waitPressed(page, 'true', 9000);
      await clickText(page, 'Para one', 2);
      const live = await editing(page);
      if (live) { await selectAt(page, ['words', 5]); await page.keyboard.type('A'); }
      const s1 = await esc(page);
      check('first: switch on after the deferred load, the first session types', on && live && s1 === DOC.replace('one words', 'one wordsA') && reqs.length === 1, `on=${on} live=${live} reqs=${reqs.length} src1=${J(s1.split('\n')[2])}`);
      await clickText(page, 'Para two', 2);
      const live2 = await editing(page);
      if (live2) { await selectAt(page, [' words.', 0]); await page.keyboard.type('B'); }
      const s2 = await esc(page);
      check('first: second session next to a formula', live2 && s2.includes('Para two $x^2$B words.'), `live2=${live2} src=${J(s2.split('\n')[4])}`);
      await clickText(page, 'Lead', 2);
      const live3 = await editing(page);
      if (live3) { await selectAt(page, ['first', 5]); await page.keyboard.press('Delete'); await sleep(400); await selectAt(page, ['first', 5]); await page.keyboard.type('Q'); await sleep(300); await selectAt(page, ['two', 3]); await page.keyboard.press('Delete'); await sleep(400); }
      await sleep(400);
      const boxes = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview .is-editing input[type="checkbox"]')].map((b) => b.checked));
      const s3 = await esc(page);
      const exp3 = '- [ ] one firstQ Lead $\\frac{a}{b}$ two three $y_1$ end\n';   // (a dropped moved-in box leaves the space after it: v5-keys-probe task-del-join)
      check('first: task-list three-way Delete join with formulas (real user)', live3 && s3.includes(exp3) && J(boxes) === J([false]) && !s3.includes('style='), `live3=${live3} boxes=${J(boxes)} src=${J(s3.split('\n').slice(6, 9).join('⏎'))}`);
      await clickText(page, 'quote first', 2);
      const live4 = await editing(page);
      if (live4) { await selectAt(page, ['Lead', 0]); await page.keyboard.press('Backspace'); await sleep(400); }
      const s4 = await esc(page);
      const ok4 = s4.includes('![im](p%20q.png "T")') && s4.includes('https://e.example/a%E2%80%8Bb') && !INV.test(s4) && !s4.includes('<img') && !s4.includes('style=');
      check('first: quote join with image and escaped link (real user)', live4 && ok4 && s4 !== s3, `live4=${live4} src=${J(s4.split('\n').slice(10, 13).join('⏎'))}`);
      check('first: no page error', errors.length === 0, J(errors));
    } finally { await context.close(); }
  },
  async loading() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page, DOC);
      const before = await source(page);
      await page.click('[data-cmd="view.togglePreviewEdit"]');
      await sleep(150);
      await clickText(page, 'Para one', 2);
      const liveDuring = await editing(page);
      await page.keyboard.type('Z');
      await sleep(300);
      const during = await source(page);
      const busy = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-busy'));
      h.release();
      const on = await waitPressed(page, 'true', 6000);
      await sleep(300);
      const after = await source(page);
      await clickText(page, 'Para one', 2);
      const live = await editing(page);
      if (live) { await selectAt(page, ['here', 4]); await page.keyboard.type('W'); }
      const s = await esc(page);
      const zCount = (x) => x.split('Z').length - 1;
      check('loading: a click during the load starts no session; typing goes where the switch-off app sends it', !liveDuring && busy === 'true', `liveDuring=${liveDuring} busy=${busy} typedZ before=${zCount(before)} during=${zCount(during)} after=${zCount(after)}`);
      check('loading: after the arrival a session works and typing arrives once', on && live && s.includes('here.W') === false && s.includes('hereW.') && (s.split('W').length - 1) === (before.split('W').length - 1) + 1 && reqs.length === 1, `on=${on} live=${live} reqs=${reqs.length} line=${J(s.split('\n').find((l) => l.startsWith('Para one')))}`);
      check('loading: no page error', errors.length === 0, J(errors));
    } finally { await context.close(); }
  },
  async offmid() {
    const { context, page, errors } = await open('1');
    try {
      await loadDoc(page, DOC);
      const on = await waitPressed(page, 'true', 9000);
      await clickText(page, 'Para two', 2);
      const live = await editing(page);
      if (live) { await selectAt(page, ['words.', 5]); await page.keyboard.type('K'); }
      await sleep(80);
      await page.keyboard.press('Meta+Shift+e');
      await sleep(500);
      const off = await pressed(page);
      const liveAfter = await editing(page);
      const s1 = await source(page);
      const stampsOff = await page.evaluate(() => document.querySelectorAll('.mdr-preview [data-mdr-tex], .mdr-preview [data-mdr-ps], .mdr-preview [contenteditable="true"]').length);
      await page.keyboard.press('Meta+Shift+e');
      const on2 = await waitPressed(page, 'true', 4000);
      await clickText(page, 'last para', 2);
      const live2 = await editing(page);
      if (live2) { await selectAt(page, ['para', 4]); await page.keyboard.type('M'); }
      const s2 = await esc(page);
      const ce = await page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
      check('offmid: ⌘⇧E in a session ends it and keeps the typed text', on && live && off === 'false' && !liveAfter && stampsOff === 0 && s1.includes('Para two $x^2$ wordsK.'), `on=${on} live=${live} off=${off} stampsOff=${stampsOff} liveAfter=${liveAfter} line=${J(s1.split('\n')[4])}`);
      check('offmid: on again, a session works', on2 && live2 && s2.includes('last paraM') && s2.includes('wordsK.') && ce === 0, `on2=${on2} live2=${live2} ce=${ce} last=${J(s2.split('\n').filter((l) => l.startsWith('last')))}`);
      check('offmid: no page error', errors.length === 0, J(errors));
    } finally { await context.close(); }
  },
};

try {
  browser = await chromium.launch({ headless: true });
  for (const [n, f] of Object.entries(CASES)) {
    if (only.length && !only.some((p) => n.startsWith(p))) continue;
    try { await f(); } catch (e) { check(n, false, 'threw ' + String(e?.message ?? e).split('\n')[0]); }
  }
  console.log(`${pass}/${pass + fail} passed`);
} finally { clearTimeout(KILL); await browser?.close(); }
process.exitCode = fail ? 1 : 0;
