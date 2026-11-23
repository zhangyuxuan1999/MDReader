// bench/verify/r5-rl-races.mjs — review-lazy (0.2.0 stage 2f, rule L3 / L4 / L8 attack): a REAL USER of a production
// build (no ?perf=1, no test hooks; everything through the DOM and the keyboard) while the editing chunk
// (/assets/inlineEdit-*.js) is held back, fails, or arrives late. Complements bench/verify/r5-pl-user.mjs.
//   MDR_URL=http://localhost:5473/ node bench/verify/r5-rl-races.mjs <case> [<case> ...]     (or: list)
// Cases:
//   toggle20 / toggle21   stored '0', chunk held, the toolbar button pressed 20 (21) times; released: off (on), one
//                         request, number of toasts shown.
//   two-places            stored '0', chunk held: toolbar + ⌘⇧E (withdraws), then ⌘⇧E + toolbar (on again).
//   palette               stored '0', chunk held: the palette entry 预览可编辑 twice, then once; released: on.
//   doc-replace           stored '0', chunk held, toggle on, the document replaced by a dropped .md file; released:
//                         a click in the new document starts a session, typed text lands once in the new document.
//   mode-held             stored '0', chunk held, toggle on, mode cycled to the editor alone; released while the
//                         preview is hidden; back to split: a click starts a session and the text lands once.
//   press-held            stored '0', chunk held, toggle on, mouse DOWN on a block, released chunk, mouse UP: what
//                         happens (session or not), then a second click.
//   scrolled-find         stored '0', chunk held, toggle on, preview scrolled to the end, the editor's find open;
//                         released: a click on the last paragraph edits the last paragraph.
//   first-second          stored '1', chunk slow (1500 ms): in the first second a click on a block, typing, ⌘/ twice,
//                         ⌘⇧E; what the user ends up with.
//   fail-404 / fail-cut / fail-syntax / fail-throw   stored '0': the chunk answered 404 / cut in the middle /
//                         a syntax error / a module that throws; toggle: toast, not pressed, stored, page errors; a
//                         second toggle: is the chunk requested again; a reload with the route removed: works.
//   failstart-404 / failstart-cut   the same with stored '1' at start: editor time, toast, stored still '1'.
// fix-lazy (the lead's final rule L): toggle20/21 also check aria-busy while held (RL-2); the fail cases check that the
// failed toggle stored '0' (RL-1), and after the reload the user turns the switch on (it no longer starts on).
// PASS / FAIL / INFO lines; exit 0 all pass, 1 a failure, 3 global timeout (110 s). Writes nothing.
import { chromium } from '@playwright/test';

const BASE = (process.env.MDR_URL || `http://localhost:${process.env.MDR_PORT || 5473}/`).replace(/\/?$/, '/');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const info = (name, detail) => console.log(`INFO  ${name}  — ${detail}`);
let browser = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 110_000);
const CHUNK = '**/assets/inlineEdit-*.js';
const DOC = ['# Race check', '', ...Array.from({ length: 40 }, (_, i) => `Para ${i + 1} text of the race check, long enough to wrap a little.` + NL)].join(NL);
const DOC2 = ['# Second doc', '', ...Array.from({ length: 10 }, (_, i) => `Other ${i + 1} line of the second document here.` + NL)].join(NL);
const BTN = '[data-cmd="view.togglePreviewEdit"]';

const pressed = (page) => page.evaluate((b) => document.querySelector(b)?.getAttribute('aria-pressed') ?? null, BTN);
const busy = (page) => page.evaluate((b) => document.querySelector(b)?.getAttribute('aria-busy') ?? null, BTN);
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } });
const editingEls = (page) => page.evaluate(() => ({
  ce: document.querySelectorAll('.mdr-preview [contenteditable]').length,
  editing: document.querySelectorAll('.mdr-preview .is-editing').length,
  hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
}));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const count = (s, sub) => s.split(sub).length - 1;

async function open(storedValue, { route, slowMs } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
  await context.addInitScript((v) => { try { if (!sessionStorage.getItem('r5rl')) { sessionStorage.setItem('r5rl', '1'); if (v === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } } catch { /* */ } }, storedValue);
  const page = await context.newPage();
  const errors = [];
  const consoleErr = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 160)); });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const reqs = [];
  page.on('request', (r) => { if (/\/assets\/inlineEdit-/.test(r.url())) reqs.push(r.url()); });
  if (route) await page.route(CHUNK, route);
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  const tEditor = Date.now() - t0;
  await page.waitForSelector(BTN, { timeout: 20000 });
  return { context, page, errors, consoleErr, reqs, tEditor };
}
async function loadDoc(page, text = DOC) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(text);
  await sleep(900);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(400);
}
const pointOf = (page, needle) => page.evaluate((t) => {
  const p = [...document.querySelectorAll('.mdr-preview p, .mdr-preview h1')].find((x) => x.textContent.includes(t));
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
  // (integrate, round 5, harness repair: page.click('.cm-content') clicks the middle of the content and both panes
  // scroll; a paragraph above or below the viewport is scrolled into view first instead of clicking off-screen)
  const off = await page.evaluate((t) => {
    const p = [...document.querySelectorAll('.mdr-preview p, .mdr-preview h1')].find((x) => x.textContent.includes(t));
    const pane = document.querySelector('.mdr-preview');
    if (!p || !pane) return false;
    const r = p.getBoundingClientRect(), v = pane.getBoundingClientRect();
    if (r.top >= v.top && r.bottom <= v.bottom) return false;
    p.scrollIntoView({ block: 'center' });
    return true;
  }, needle);
  if (off) await sleep(800);
  const p = await pointOf(page, needle);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(400);
  return true;
}
const clickButton = (page) => page.click(BTN);
function holder() {
  let release, n = 0;
  const gate = new Promise((r) => { release = r; });
  return { route: async (route) => { n++; await gate; await route.continue(); }, release: () => release(), count: () => n };
}
const waitPressed = (page, v, ms = 8000) => page.waitForFunction(([b, x]) => document.querySelector(b)?.getAttribute('aria-pressed') === x, [BTN, v], { timeout: ms }).catch(() => {});
async function sessionTypes(page, label, needle, typed, { retry = false } = {}) {
  check(`${label}: clicked "${needle}"`, await clickPara(page, needle));
  let el = await editingEls(page);
  if (retry && el.editing === 0) {
    // (the same on the last candidate: the first click after the palette / a mode cycle starts no session)
    info(`${label}: first click started no session, clicking again`, JSON.stringify(el));
    await clickPara(page, needle);
    el = await editingEls(page);
  }
  check(`${label}: a session started`, el.editing === 1, JSON.stringify(el));
  await page.keyboard.type(typed);
  await sleep(700);
  const src = await source(page);
  const line = src.split(NL).find((l) => l.includes(typed)) ?? '';
  check(`${label}: typed text reached the source once, in the clicked line`, count(src, typed) === 1 && line.replace(typed, '').includes(needle), line);
  await page.keyboard.press('Escape');
  await sleep(300);
}

async function toggleN(n) {
  const h = holder();
  const { context, page, errors, reqs } = await open('0', { route: h.route });
  try {
    await loadDoc(page);
    for (let i = 0; i < n; i++) await clickButton(page);
    await sleep(150);
    const tsHeld = await toasts(page);
    info(`toggle${n}: toasts while held`, `${tsHeld.length}: ${JSON.stringify(tsHeld.slice(0, 4))}`);
    check(`toggle${n}: one chunk request while held`, h.count() === 1, String(h.count()));
    check(`toggle${n}: not pressed while held`, (await pressed(page)) === 'false');
    // RL-2 (the lead's final rule L, fix-lazy): while a load for a wish of on is on its way the button is aria-busy
    check(`toggle${n}: aria-busy while held ${n % 2 ? 'true (the last press wished on)' : 'absent (the last press withdrew it)'}`, (await busy(page)) === (n % 2 ? 'true' : null), String(await busy(page)));
    h.release();
    await sleep(1200);
    check(`toggle${n}: released: aria-busy gone`, (await busy(page)) === null, String(await busy(page)));
    const want = n % 2 ? 'true' : 'false';
    check(`toggle${n}: released: pressed=${want} (the last press wins)`, (await pressed(page)) === want, String(await pressed(page)));
    check(`toggle${n}: stored ${n % 2 ? '1' : '0'}`, (await stored(page)) === (n % 2 ? '1' : '0'), String(await stored(page)));
    const el = await editingEls(page);
    check(`toggle${n}: hint elements ${n % 2 ? 1 : 0} (one instance or none)`, el.hint === (n % 2 ? 1 : 0), JSON.stringify(el));
    if (n % 2) await sessionTypes(page, `toggle${n}`, 'Para 6 text', 'Wq');
    else { await clickPara(page, 'Para 6 text'); check(`toggle${n}: no session`, (await editingEls(page)).editing === 0); }
    const ts = await toasts(page);
    info(`toggle${n}: toasts visible at the end`, `${ts.length}: ${JSON.stringify(ts.slice(0, 6))}`);
    check(`toggle${n}: one chunk request in all`, reqs.length === 1, String(reqs.length));
    check(`toggle${n}: no page error`, errors.length === 0, errors.join(' | '));
  } finally { await context.close(); }
}

async function failCase(label, routeFn, { atStart = false } = {}) {
  let n = 0;
  const route = async (r) => { n++; await routeFn(r); };
  const o = await open(atStart ? '1' : '0', { route });
  const { context, page, errors, consoleErr } = o;
  try {
    await loadDoc(page);
    if (atStart) {
      info(`${label}: editor time`, `${o.tEditor} ms`);
      await sleep(4500);                      // the deferred start (first idle, 4 s at the latest)
    } else {
      check(`${label}: no request at rest`, n === 0, String(n));
      await clickButton(page);
      await sleep(1200);
    }
    const ts = await toasts(page);
    check(`${label}: chunk requested once`, n === 1, String(n));
    check(`${label}: the failure toast`, ts.some((t) => t.includes('预览编辑功能加载失败')), JSON.stringify(ts));
    check(`${label}: no 开 toast`, !ts.some((t) => t.includes('：开')), JSON.stringify(ts));
    check(`${label}: not pressed`, (await pressed(page)) === 'false', String(await pressed(page)));
    check(`${label}: stored ${atStart ? '1 kept' : '0'}`, (await stored(page)) === (atStart ? '1' : '0'), String(await stored(page)));
    const el = await editingEls(page);
    check(`${label}: nothing of the editing code in the DOM`, el.ce === 0 && el.editing === 0 && el.hint === 0, JSON.stringify(el));
    const before = await source(page);
    await clickPara(page, 'Para 3 text');
    await page.keyboard.type('z');
    await sleep(400);
    check(`${label}: a click and a key after the failure change nothing (switch off)`, (await source(page)) === before && (await editingEls(page)).editing === 0);
    info(`${label}: page errors`, `${errors.length}: ${errors.join(' | ')}`);
    info(`${label}: console errors`, `${consoleErr.length}: ${consoleErr.slice(0, 3).join(' | ')}`);
    // a second toggle: does the browser fetch again?
    const n1 = n;
    await clickButton(page);
    await sleep(1200);
    const ts2 = await toasts(page);
    info(`${label}: second toggle`, `requests ${n1} -> ${n}, failure toasts now ${ts2.filter((t) => t.includes('加载失败')).length}, pressed ${await pressed(page)}`);
    // RL-1 (the lead's final rule L, fix-lazy): the failure of a load the user asked for with a toggle stores '0'
    check(`${label}: the failed toggle stored 0 (RL-1)`, (await stored(page)) === '0', String(await stored(page)));
    // recovery: the route lets it through, reload; the stored value is '0' now (RL-1), so the user turns it on
    await page.unroute(CHUNK);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.cm-content', { timeout: 20000 });
    await loadDoc(page);
    await clickButton(page);
    await waitPressed(page, 'true', 8000);
    check(`${label}: after a reload the switch turns on`, (await pressed(page)) === 'true', `${await pressed(page)} stored ${await stored(page)}`);
    if ((await pressed(page)) === 'true') await sessionTypes(page, `${label} reload`, 'Para 7 text', 'Yv');
  } finally { await context.close(); }
}

const CASES = {
  toggle20: () => toggleN(20),
  toggle21: () => toggleN(21),
  async 'two-places'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await page.click('.cm-content');
      await page.keyboard.press('Meta+Shift+E');
      await sleep(150);
      h.release();
      await sleep(1000);
      check('two-places: toolbar then ⌘⇧E: off', (await pressed(page)) === 'false' && (await stored(page)) === '0', `${await pressed(page)} ${await stored(page)}`);
      await page.keyboard.press('Meta+Shift+E');
      await clickButton(page);
      await sleep(400);
      check('two-places: ⌘⇧E then toolbar (chunk here): off', (await pressed(page)) === 'false', String(await pressed(page)));
      await clickButton(page);
      await sleep(200);
      check('two-places: once more: on', (await pressed(page)) === 'true' && (await stored(page)) === '1');
      await sessionTypes(page, 'two-places', 'Para 8 text', 'Hk');
      check('two-places: one hint (one instance)', (await editingEls(page)).hint === 1);
      check('two-places: one chunk request', reqs.length === 1, String(reqs.length));
      check('two-places: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async palette() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      const viaPalette = async () => {
        await page.click('.cm-content');
        await page.keyboard.press('Meta+Shift+P');
        await page.waitForSelector('.mdr-palette__input', { timeout: 3000 });
        await page.keyboard.insertText('预览可编辑');
        await sleep(150);
        await page.keyboard.press('Enter');
        await sleep(200);
      };
      await viaPalette();
      await viaPalette();
      await viaPalette();
      check('palette: not pressed while held', (await pressed(page)) === 'false');
      h.release();
      await waitPressed(page, 'true');
      check('palette: three times: on', (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
      await sessionTypes(page, 'palette', 'Para 9 text', 'Pz', { retry: true });
      check('palette: one chunk request', reqs.length === 1, String(reqs.length));
      check('palette: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'doc-replace'() {
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await sleep(100);
      // replace the document: a dropped .md file (App's window drop handler opens it)
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], 'second.md', { type: 'text/markdown' }));
        const target = document.querySelector('.mdr-preview') ?? document.body;
        for (const ty of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, DOC2);
      await sleep(500);
      // the typed document is modified: the app's own 取消 / 丢弃 question
      for (const b of await page.$$('.mdr-dialog__btn')) if (((await b.textContent()) ?? '').includes('丢弃')) { await b.click(); break; }
      await sleep(1200);
      const src0 = await source(page);
      check('doc-replace: the second document is open', src0.includes('Other 3 line'), src0.slice(0, 60));
      h.release();
      await waitPressed(page, 'true');
      check('doc-replace: released: on', (await pressed(page)) === 'true');
      await sessionTypes(page, 'doc-replace', 'Other 3 line', 'Dq');
      const src = await source(page);
      check('doc-replace: nothing of the first document came back', !src.includes('Para 1 text'));
      check('doc-replace: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'mode-held'() {
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await page.click('.cm-content');
      await page.keyboard.press('Meta+/');        // split -> preview? cycle: read what is shown
      await sleep(300);
      const vis = async () => page.evaluate(() => ({ ed: !!document.querySelector('.cm-editor')?.getClientRects().length && document.querySelector('.cm-editor').getBoundingClientRect().width > 50, pv: (document.querySelector('.mdr-preview')?.getBoundingClientRect().width ?? 0) > 50 }));
      let v = await vis();
      for (let i = 0; i < 3 && !(v.ed && !v.pv); i++) { await page.keyboard.press('Meta+/'); await sleep(300); v = await vis(); }
      check('mode-held: editor alone reached', v.ed && !v.pv, JSON.stringify(v));
      h.release();
      await waitPressed(page, 'true');
      check('mode-held: installed while the preview is hidden: on', (await pressed(page)) === 'true');
      for (let i = 0; i < 3 && !(v.ed && v.pv); i++) { await page.click('.cm-content'); await page.keyboard.press('Meta+/'); await sleep(400); v = await vis(); }
      check('mode-held: split again', v.ed && v.pv, JSON.stringify(v));
      await sleep(500);
      await sessionTypes(page, 'mode-held', 'Para 2 text', 'Mx', { retry: true });
      check('mode-held: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'press-held'() {
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await sleep(100);
      const p = await pointOf(page, 'Para 4 text');
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      h.release();
      await waitPressed(page, 'true');
      await page.mouse.up();
      await sleep(400);
      const el = await editingEls(page);
      info('press-held: a press made before the install, released after it', `session ${el.editing} (0.2.0 with the switch on from the start: a session; the stand-in's press: none)`);
      await sessionTypes(page, 'press-held second click', 'Para 5 text', 'Rb');
      check('press-held: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'scrolled-find'() {
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await clickButton(page);
      await page.click('.cm-content');
      await page.keyboard.press('Meta+f');
      await sleep(300);
      await page.evaluate(() => { const s = document.querySelector('.mdr-preview'); s.scrollTop = s.scrollHeight; });
      await sleep(800);
      h.release();
      await waitPressed(page, 'true');
      await sleep(300);
      check('scrolled-find: on', (await pressed(page)) === 'true');
      await sessionTypes(page, 'scrolled-find', 'Para 39 text', 'Fy');
      check('scrolled-find: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'first-second'() {
    const route = async (r) => { await sleep(1500); await r.continue(); };
    const o = await open('1', { route });
    const { context, page, errors, reqs } = o;
    try {
      info('first-second: editor time', `${o.tEditor} ms`);
      await page.click('.cm-content');
      await page.keyboard.insertText(DOC);
      await sleep(250);
      const before = await source(page);
      await clickPara(page, 'Para 2 text');
      await page.keyboard.type('e');
      await sleep(100);
      const afterClick = await source(page);
      check('first-second: a click + key in the first second edit nothing in the preview', afterClick === before && (await editingEls(page)).editing === 0);
      await page.keyboard.press('Meta+/');
      await page.keyboard.press('Meta+/');
      await page.keyboard.press('Meta+/');
      const p0 = await pressed(page);
      await page.click('.cm-content');
      await page.keyboard.press('Meta+Shift+E');
      await sleep(3000);
      const ts = await toasts(page);
      info('first-second: after ⌘⇧E pressed in the first second (button showed ' + p0 + ')', `pressed ${await pressed(page)} stored ${await stored(page)} toasts ${JSON.stringify(ts)} requests ${reqs.length}`);
      check('first-second: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  'fail-404': () => failCase('fail-404', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })),
  'fail-cut': async () => {
    const body = await (await fetch(BASE)).text();
    const m = body.match(/assets\/index-[^"]+\.js/);
    const main = await (await fetch(BASE + m[0])).text();
    const name = main.match(/inlineEdit-[A-Za-z0-9_-]+\.js/)[0];
    const full = await (await fetch(BASE + 'assets/' + name)).text();
    await failCase('fail-cut', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: full.slice(0, Math.floor(full.length / 2)) }));
  },
  'fail-syntax': () => failCase('fail-syntax', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const createInlineEdit = ;' })),
  'fail-throw': () => failCase('fail-throw', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("r5rl boom");' })),
  async 'tick-install'() {
    // a task ticked a moment before the switch is turned on, and one ticked while the chunk is on its way
    const TASKS = ['# Ticks', '', '- [ ] alpha task one', '- [ ] beta task two', '- [ ] gamma task three', '', 'Tail paragraph text here.', ''].join(NL);
    const h = holder();
    const { context, page, errors } = await open('0', { route: h.route });
    try {
      await loadDoc(page, TASKS);
      const box = (i) => page.locator('.mdr-preview input[type="checkbox"]').nth(i);
      await box(0).click();
      await clickButton(page);                 // at once after the tick
      await sleep(60);
      await box(1).click();                    // while the chunk is held: the tick that does not wait
      await sleep(400);
      let src = await source(page);
      check('tick-install: both ticks applied at once (switch off while loading)', src.includes('- [x] alpha') && src.includes('- [x] beta'), src.split(NL).filter((l) => l.startsWith('- [')).join(' | '));
      h.release();
      await waitPressed(page, 'true');
      await box(2).click();
      await sleep(500);
      src = await source(page);
      check('tick-install: a tick right after the install', src.includes('- [x] gamma'), src.split(NL).filter((l) => l.startsWith('- [')).join(' | '));
      await sessionTypes(page, 'tick-install', 'Tail paragraph', 'Tq');
      src = await source(page);
      check('tick-install: the three ticks kept', (src.match(/- \[x\]/g) ?? []).length === 3, src.split(NL).filter((l) => l.startsWith('- [')).join(' | '));
      const ts = await toasts(page);
      check('tick-install: no 未勾选 toast', !ts.some((t) => t.includes('未')), JSON.stringify(ts));
      check('tick-install: no page error', errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  },
  async 'failstart-stuck'() {
    // stored '1' and a chunk that can never load (a filter, a broken deployment): what the user can do about it
    const route = (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    const o = await open('1', { route });
    const { context, page } = o;
    try {
      const failToast = async () => (await toasts(page)).filter((t) => t.includes('加载失败')).length;
      await loadDoc(page);
      await sleep(4500);
      info('failstart-stuck: start 1', `failure toasts ${await failToast()} pressed ${await pressed(page)} stored ${await stored(page)}`);
      await clickButton(page);
      await sleep(800);
      info('failstart-stuck: the user presses the button (shows off)', `pressed ${await pressed(page)} stored ${await stored(page)}`);
      await clickButton(page);
      await sleep(800);
      info('failstart-stuck: presses it again', `pressed ${await pressed(page)} stored ${await stored(page)}`);
      for (let i = 2; i <= 3; i++) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.cm-content', { timeout: 20000 });
        await loadDoc(page);
        await sleep(4500);
        info(`failstart-stuck: start ${i}`, `failure toasts ${await failToast()} pressed ${await pressed(page)} stored ${await stored(page)}`);
      }
      check('failstart-stuck: the user has a way to stop the failure toast at every start (stored no longer 1)', (await stored(page)) !== '1', `stored ${await stored(page)}`);
    } finally { await context.close(); }
  },
  'failstart-404': () => failCase('failstart-404', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' }), { atStart: true }),
  'failstart-cut': async () => {
    const body = await (await fetch(BASE)).text();
    const main = await (await fetch(BASE + body.match(/assets\/index-[^"]+\.js/)[0])).text();
    const full = await (await fetch(BASE + 'assets/' + main.match(/inlineEdit-[A-Za-z0-9_-]+\.js/)[0])).text();
    await failCase('failstart-cut', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: full.slice(0, 5000) }), { atStart: true });
  },
};

try {
  if (only[0] === 'list') { console.log(Object.keys(CASES).join(' ')); process.exit(0); }
  browser = await chromium.launch({ headless: true });
  for (const [k, f] of Object.entries(CASES)) {
    if (only.length && !only.includes(k)) continue;
    console.log(`== ${k}`);
    try { await f(); } catch (e) { check(`${k}: ran`, false, String(e?.message ?? e).slice(0, 200)); }
  }
} finally {
  clearTimeout(KILL);
  await browser?.close().catch(() => {});
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
