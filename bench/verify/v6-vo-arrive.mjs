// bench/verify/v6-vo-arrive.mjs — verify-off (0.2.0 stage 2f, round 5, rules L3 / L8): a REAL USER of a production build
// (no ?perf=1, no hooks; DOM, mouse and keyboard only) while the editing chunk /assets/inlineEdit-*.js is held back by a
// route, then released. Complements r5-rl-races.mjs and r5-pl-user.mjs with the gestures they do not make.
//   MDR_URL=http://localhost:5480/ node bench/verify/v6-vo-arrive.mjs <case ...|all>
// Cases:
//   held-mix        stored '0'; held; button pressed; meanwhile: a click on Para 3, a double click on Para 4, typing
//                   'abc' in the editor, a tick of the first box, the palette opened and closed, ⌘/ twice; released:
//                   no session anywhere, the source is exactly what the switch-off gestures made (abc once, one tick),
//                   pressed, stored '1', one 开 toast, one hint; then a click on Para 6 starts the session THERE and 'Q'
//                   arrives once.
//   held-key-btn    stored '0'; held; the toolbar click and ⌘⇧E in the same task (two toggles: on, then off); released:
//                   off, stored '0', no module element; then once more with the chunk free: on.
//   free-key-btn    stored '0'; chunk not held: toolbar click and ⌘⇧E at once; then again: on after the second pair? (each
//                   pair is on+off): the end state equals the parity, stored equals pressed.
//   rapid20 / rapid21  stored '0', chunk NOT held, 20 (21) toolbar clicks 30 ms apart: the end state equals the parity,
//                   stored equals pressed, at most one hint, a session (21) types once.
//   held-undo       ⌘Z and ⌘B pressed outside the editor while the chunk is held after a press: the same as on a page
//                   whose switch is off (CodeMirror's undo; bold in the editor); released: pressed, source unchanged.
//   held-open       the document replaced through 打开 (⌘O) while held, then 新建 after the install: sessions work once.
//   held-close      stored '0'; held; pressed; the page closed while held; a new page of the same browser profile: not
//                   pressed, stored '0', nothing loads.
//   st1-twice       stored '1' (deferred start); within the first 300 ms the button pressed twice (on, withdraw), the
//                   chunk held 2 s; after 6 s: off, stored '0', no hint (the deferred start must not turn it on again).
//   st1-early       stored '1', the chunk held 1500 ms; the button pressed once at once (the startup load on its way):
//                   it joins: on, stored '1', one hint, typed text once.
//   st1-held-use    stored '1'; chunk held: clicks, a tick, typing in the editor; released: on, stored '1', the source
//                   holds the tick and the typing once, no session until the next click.
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
const DOC = ['# Arrive check', '', '- [ ] first box', '- [ ] second box', '', ...Array.from({ length: 12 }, (_, i) => `Para ${i + 1} text of the arrival check, long enough to wrap a little.` + NL)].join(NL);
const st = (page) => page.evaluate((b) => {
  const c = document.querySelector('.cm-content');
  const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
  const ed = [...document.querySelectorAll('.mdr-preview .is-editing')];
  return {
    pressed: document.querySelector(b)?.getAttribute('aria-pressed') ?? null,
    busy: document.querySelector(b)?.getAttribute('aria-busy') ?? null,
    stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'ERR'; } })(),
    src: v ? v.state.doc.toString() : [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
    editing: ed.length, editingText: ed.map((e) => e.textContent.slice(0, 30)).join('|'),
    ce: document.querySelectorAll('.mdr-preview [contenteditable="true"]').length,
    hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
    toasts: [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent),
  };
}, BTN);
const count = (s, sub) => s.split(sub).length - 1;
function holder() {
  let release, n = 0;
  const gate = new Promise((r) => { release = r; });
  return { route: async (route) => { n++; await gate; await route.continue().catch(() => {}); }, release: () => release(), count: () => n };
}
async function open(stored, { route, ctx } = {}) {
  const context = ctx || await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (!ctx) await context.addInitScript((v) => { try { if (!sessionStorage.getItem('v6vo')) { sessionStorage.setItem('v6vo', '1'); if (v === null) localStorage.removeItem('mdr.previewEdit'); else localStorage.setItem('mdr.previewEdit', v); } } catch { /* */ } }, stored);
  const page = await context.newPage();
  const errors = [], reqs = [], toastLog = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('request', (r) => { if (/\/assets\/inlineEdit-/.test(r.url())) reqs.push(r.url()); });
  if (route) await page.route(CHUNK, route);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector(BTN, { timeout: 20000 });
  await page.evaluate(() => {
    window.__toastLog = [];
    const seen = new WeakSet();
    new MutationObserver(() => { for (const e of document.querySelectorAll('.mdr-toast__text')) if (!seen.has(e)) { seen.add(e); window.__toastLog.push(e.textContent); } }).observe(document.body, { childList: true, subtree: true });
  });
  return { context, page, errors, reqs };
}
const toastLog = (page) => page.evaluate(() => window.__toastLog.slice());
async function loadDoc(page) {
  await page.click('.cm-content'); await page.keyboard.press('Meta+a'); await page.keyboard.insertText(DOC);
  await sleep(900);
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; }); await sleep(300);
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
const clickPara = async (page, needle, n = 1) => { const p = await pointOf(page, needle); if (!p) return false; await page.mouse.click(p.x, p.y, { clickCount: n }); return true; };
const waitPressed = (page, v, ms = 8000) => page.waitForFunction(([b, x]) => document.querySelector(b)?.getAttribute('aria-pressed') === x, [BTN, v], { timeout: ms }).then(() => true, () => false);

const CASES = {
  async 'held-mix'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      const src0 = (await st(page)).src;
      await page.click(BTN); await sleep(150);
      let s = await st(page);
      check('held-mix: while held not pressed, busy', s.pressed === 'false' && s.busy === 'true', JSON.stringify({ p: s.pressed, b: s.busy }));
      await clickPara(page, 'Para 3 text'); await sleep(200);
      await clickPara(page, 'Para 4 text', 2); await sleep(200);
      s = await st(page);
      check('held-mix: clicks while held start no session', s.editing === 0 && s.ce === 0 && s.src === src0, JSON.stringify({ e: s.editing, ce: s.ce }));
      await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('abc'); await sleep(150);
      await page.click('.mdr-preview input[type=checkbox] >> nth=0'); await sleep(400);
      await page.keyboard.press('Meta+Shift+P'); await sleep(200); await page.keyboard.press('Escape'); await sleep(150);
      await page.click('.cm-content'); await page.keyboard.press('Meta+/'); await sleep(200); await page.keyboard.press('Meta+/'); await sleep(200); await page.keyboard.press('Meta+/'); await sleep(300);
      s = await st(page);
      const expSrc = src0.replace('- [ ] first box', '- [x] first box') + 'abc';
      check('held-mix: while held the switch-off gestures did their switch-off work', s.src === expSrc, JSON.stringify(s.src.slice(-30)) + ' tick=' + s.src.includes('- [x] first box'));
      h.release();
      const on = await waitPressed(page, 'true', 8000); await sleep(400);
      s = await st(page);
      check('held-mix: released: pressed, stored 1, not busy, one hint', on && s.stored === '1' && s.busy === null && s.hint === 1, JSON.stringify({ p: s.pressed, st: s.stored, b: s.busy, h: s.hint }));
      check('held-mix: released: no session started by itself, source unchanged', s.editing === 0 && s.src === expSrc, JSON.stringify({ e: s.editing, t: s.editingText }));
      const tl = await toastLog(page);
      check('held-mix: one 开 toast', tl.filter((t) => /开/.test(t) && /预览可编辑/.test(t)).length === 1, JSON.stringify(tl));
      await clickPara(page, 'Para 6 text'); await sleep(500);
      s = await st(page);
      check('held-mix: a click on Para 6 starts a session there', s.editing === 1 && /Para 6/.test(s.editingText), JSON.stringify({ e: s.editing, t: s.editingText }));
      await page.keyboard.type('Q'); await sleep(700);
      s = await st(page);
      const line = s.src.split(NL).find((l) => l.includes('Q')) || '';
      check('held-mix: typed Q once in Para 6 (at the click point)', count(s.src, 'Q') === 1 && /Para 6/.test(line.replace('Q', '')), line);
      check('held-mix: one chunk request, no page error', reqs.length === 1 && errors.length === 0, JSON.stringify({ reqs: reqs.length, errors }));
    } finally { await context.close(); }
  },
  async 'held-key-btn'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await page.click('.mdr-preview h1'); // focus outside the editor, so ⌘⇧E reaches the window's shortcut
      await Promise.all([page.click(BTN), page.keyboard.press('Meta+Shift+E')]);
      await sleep(300);
      let s = await st(page);
      check('held-key-btn: two toggles while held: not pressed, not busy (withdrawn)', s.pressed === 'false' && s.busy === null, JSON.stringify({ p: s.pressed, b: s.busy }));
      h.release(); await sleep(1200);
      s = await st(page);
      check('held-key-btn: released: off, stored 0, no hint (never installed)', s.pressed === 'false' && s.stored === '0' && s.hint === 0, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint }));
      await page.click(BTN);
      const on = await waitPressed(page, 'true', 5000); await sleep(300);
      s = await st(page);
      check('held-key-btn: one more press: on, stored 1, one hint', on && s.stored === '1' && s.hint === 1, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint, reqs: reqs.length }));
      check('held-key-btn: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
  async 'free-key-btn'() {
    const { context, page, errors } = await open('0');
    try {
      await loadDoc(page);
      await page.click('.mdr-preview h1');
      await Promise.all([page.click(BTN), page.keyboard.press('Meta+Shift+E')]);
      await sleep(1200);
      let s = await st(page);
      check('free-key-btn: a pair at once: off, stored agrees', s.pressed === 'false' && (s.stored === '0' || s.stored === null) && s.busy === null, JSON.stringify({ p: s.pressed, st: s.stored, b: s.busy, h: s.hint }));
      await page.click(BTN); await sleep(100); await page.click('.mdr-preview h1');
      await Promise.all([page.click(BTN), page.keyboard.press('Meta+Shift+E')]);
      await sleep(1200);
      s = await st(page);
      check('free-key-btn: press, then a pair: on, stored 1, one hint', s.pressed === 'true' && s.stored === '1' && s.hint <= 1, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint }));
      check('free-key-btn: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
  async 'held-undo'() {
    // ⌘Z / ⌘B pressed outside the editor while the chunk is held after a press: the switch-off path (U2: CodeMirror's
    // undo; ⌘B goes to the editor), compared with the same gestures on a page whose switch is simply off
    const out = {};
    for (const held of [true, false]) {
      const h = holder();
      const { context, page, errors } = await open('0', held ? { route: h.route } : {});
      try {
        await loadDoc(page);
        await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('undo me'); await sleep(700);
        await clickPara(page, 'Para 2 text'); await sleep(200);
        if (held) { await page.click(BTN); await sleep(150); await clickPara(page, 'Para 2 text'); await sleep(200); }
        await page.keyboard.press('Meta+Z'); await sleep(400);
        const a = await st(page);
        await clickPara(page, 'Para 3 text', 2); await sleep(200);
        await page.keyboard.press('Meta+B'); await sleep(400);
        const b = await st(page);
        out[held] = { undo: a.src.slice(-12), undoEditing: a.editing, bold: (b.src.match(/\*\*[^*]*\*\*/) || [''])[0], boldEditing: b.editing, errors: errors.length };
        if (held) { h.release(); await sleep(1200); const c = await st(page); out.after = { pressed: c.pressed, src: c.src === b.src, editing: c.editing }; }
      } finally { await context.close(); }
    }
    check('held-undo: ⌘Z and ⌘B outside the editor while held do what the switch-off page does', JSON.stringify({ ...out.true }) === JSON.stringify({ ...out.false }), JSON.stringify(out));
    check('held-undo: released afterwards: pressed, source unchanged, no session', out.after && out.after.pressed === 'true' && out.after.src && out.after.editing === 0, JSON.stringify(out.after));
  },
  async 'held-open'() {
    // the document replaced through 打开 (⌘O; the picker returns an OPFS file) and then 新建 while the chunk is held
    const h = holder();
    const { context, page, errors, reqs } = await open('0', { route: h.route });
    try {
      await loadDoc(page);
      await page.click(BTN); await sleep(150);
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle('held-open.md', { create: true });
        const w = await fh.createWritable(); await w.write('# Opened while held\n\nOpened para one text here.\n\nOpened para two text here.\n'); await w.close();
        window.showOpenFilePicker = async () => [fh];
      });
      await page.click('.cm-content'); await page.keyboard.press('Meta+O'); await sleep(500);
      await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃'); if (b) b.click(); });
      await sleep(800);
      let s = await st(page);
      check('held-open: the opened document is shown, still not pressed, busy', /Opened while held/.test(s.src) && s.pressed === 'false' && s.busy === 'true', JSON.stringify({ head: s.src.slice(0, 20), p: s.pressed, b: s.busy }));
      h.release();
      const on = await waitPressed(page, 'true', 6000); await sleep(400);
      s = await st(page);
      check('held-open: released: on, stored 1, one hint, no session', on && s.stored === '1' && s.hint === 1 && s.editing === 0, JSON.stringify({ st: s.stored, h: s.hint, e: s.editing }));
      await clickPara(page, 'Opened para two'); await sleep(500); await page.keyboard.type('V'); await sleep(700);
      s = await st(page);
      check('held-open: a session in the opened document types once, in the clicked paragraph', count(s.src, 'V') === 1 && /Opened para two/.test((s.src.split(NL).find((l) => l.includes('V')) || '').replace('V', '')), s.src.split(NL).find((l) => l.includes('V')) || '(none)');
      await page.keyboard.press('Escape'); await sleep(300);
      await page.click('[data-cmd="file.new"]'); await sleep(400);
      await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃'); if (b) b.click(); });
      await sleep(600);
      await page.click('.cm-content'); await page.keyboard.type('Fresh para text for the new doc.'); await sleep(900);
      await clickPara(page, 'Fresh para'); await sleep(500); await page.keyboard.type('N'); await sleep(700);
      s = await st(page);
      check('held-open: after 新建 a session types once', count(s.src, 'N') === 1 && s.editing <= 1, JSON.stringify(s.src));
      check('held-open: one request, no page error', reqs.length === 1 && errors.length === 0, JSON.stringify({ reqs: reqs.length, errors }));
    } finally { await context.close(); }
  },
  async rapid20() { await rapid(20); },
  async rapid21() { await rapid(21); },
  async 'held-close'() {
    const h = holder();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(() => { try { if (!localStorage.getItem('v6vo.once')) { localStorage.setItem('v6vo.once', '1'); localStorage.setItem('mdr.previewEdit', '0'); } } catch { /* */ } });
    try {
      const a = await open('0', { route: h.route, ctx: context });
      await loadDoc(a.page);
      await a.page.click(BTN); await sleep(200);
      await a.page.close({ runBeforeUnload: false });
      h.release();
      const b = await open('0', { ctx: context });
      await sleep(5000);
      const s = await st(b.page);
      check('held-close: next start: not pressed, stored 0, nothing requested, no hint', s.pressed === 'false' && s.stored === '0' && b.reqs.length === 0 && s.hint === 0, JSON.stringify({ p: s.pressed, st: s.stored, reqs: b.reqs.length, h: s.hint }));
    } finally { await context.close(); }
  },
  async 'st1-twice'() {
    let n = 0;
    const route = async (r) => { n++; await sleep(2000); await r.continue().catch(() => {}); };
    const { context, page, errors, reqs } = await open('1', { route });
    try {
      await sleep(50);
      await page.click(BTN); await sleep(60); await page.click(BTN);
      await sleep(6000);
      const s = await st(page);
      check('st1-twice: on then withdrawn early: off after 6 s, stored 0, no hint, not busy', s.pressed === 'false' && s.stored === '0' && s.hint === 0 && s.busy === null, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint, b: s.busy, reqs: reqs.length }));
      const tl = await toastLog(page);
      check('st1-twice: toasts', !tl.some((t) => /失败/.test(t)), JSON.stringify(tl));
      check('st1-twice: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
  async 'st1-early'() {
    // the deferred start asks for the chunk within ~10 ms of the editor on a local server; the chunk is held 1500 ms so
    // that the press lands while the startup load is on its way (the button shows off): it joins, and the switch is on
    const { context, page, errors, reqs } = await open('1', { route: async (r) => { await sleep(1500); await r.continue().catch(() => {}); } });
    try {
      await page.evaluate((b) => {
        window.__tl = []; const t0 = performance.now();
        const rec = (why) => window.__tl.push(`${Math.round(performance.now() - t0)}:${why}:${document.querySelector(b)?.getAttribute('aria-pressed')}/${document.querySelector(b)?.getAttribute('aria-busy')}/${localStorage.getItem('mdr.previewEdit')}`);
        new MutationObserver(() => rec('mut')).observe(document.querySelector(b), { attributes: true });
        document.querySelector(b).addEventListener('click', () => rec('click'), true);
        window.addEventListener('keydown', (e) => rec('key:' + e.key), true);
      }, BTN);
      await page.click(BTN);
      const on = await waitPressed(page, 'true', 6000);
      await sleep(4500); // past the deferred start
      let s = await st(page);
      console.log('INFO  st1-early: timeline ' + JSON.stringify(await page.evaluate(() => window.__tl)) + ' toasts ' + JSON.stringify(await toastLog(page)) + ' on=' + on);
      check('st1-early: one early press: on, stored 1, one hint', on && s.pressed === 'true' && s.stored === '1' && s.hint === 1, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint, reqs: reqs.length }));
      await loadDoc(page);
      await clickPara(page, 'Para 2 text'); await sleep(500);
      await page.keyboard.type('W'); await sleep(700);
      s = await st(page);
      check('st1-early: typed W once', count(s.src, 'W') === 1, s.src.split(NL).find((l) => l.includes('W')) || '(none)');
      check('st1-early: one chunk request, no page error', reqs.length === 1 && errors.length === 0, JSON.stringify({ reqs: reqs.length, errors }));
    } finally { await context.close(); }
  },
  async 'st1-held-use'() {
    const h = holder();
    const { context, page, errors, reqs } = await open('1', { route: h.route });
    try {
      await loadDoc(page);
      const src0 = (await st(page)).src;
      await page.waitForFunction(() => true);
      await sleep(4200); // the deferred start has asked for the chunk by now
      let s = await st(page);
      check('st1-held-use: deferred load asked, held: not pressed', h.count() >= 1 && s.pressed === 'false', JSON.stringify({ n: h.count(), p: s.pressed, b: s.busy }));
      await clickPara(page, 'Para 3 text'); await sleep(250);
      await page.click('.mdr-preview input[type=checkbox] >> nth=1'); await sleep(400);
      await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('zz'); await sleep(300);
      s = await st(page);
      const exp = src0.replace('- [ ] second box', '- [x] second box') + 'zz';
      check('st1-held-use: switch-off work while held', s.src === exp && s.editing === 0, JSON.stringify(s.src.slice(-20)));
      h.release();
      const on = await waitPressed(page, 'true', 6000); await sleep(400);
      s = await st(page);
      check('st1-held-use: released: on, stored 1, one hint, no session, source unchanged', on && s.stored === '1' && s.hint === 1 && s.editing === 0 && s.src === exp, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint, e: s.editing }));
      const tl = await toastLog(page);
      check('st1-held-use: no toast for the deferred start', !tl.some((t) => /预览可编辑|加载/.test(t)), JSON.stringify(tl));
      check('st1-held-use: no page error', errors.length === 0, JSON.stringify(errors));
    } finally { await context.close(); }
  },
};
async function rapid(n) {
  const { context, page, errors, reqs } = await open('0');
  try {
    await loadDoc(page);
    for (let i = 0; i < n; i++) { await page.click(BTN); await sleep(30); }
    await sleep(1500);
    const s = await st(page);
    const want = n % 2 ? 'true' : 'false';
    check(`rapid${n}: end state equals the parity, stored agrees, at most one hint, not busy`, s.pressed === want && s.stored === (n % 2 ? '1' : '0') && s.hint <= 1 && s.busy === null, JSON.stringify({ p: s.pressed, st: s.stored, h: s.hint, b: s.busy, reqs: reqs.length }));
    if (n % 2) {
      await clickPara(page, 'Para 5 text'); await sleep(500); await page.keyboard.type('R'); await sleep(700);
      const t = await st(page);
      check(`rapid${n}: typed R once`, count(t.src, 'R') === 1, t.src.split(NL).find((l) => l.includes('R')) || '(none)');
    }
    const tl = await toastLog(page);
    console.log(`INFO  rapid${n}: toasts ${JSON.stringify(tl)}`);
    check(`rapid${n}: no page error`, errors.length === 0, JSON.stringify(errors));
  } finally { await context.close(); }
}
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
