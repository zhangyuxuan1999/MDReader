// bench/verify/v8-vw-user.mjs — verify-web (0.2.0 stage 3, post-release check of the deployed page), headless chromium.
// Checks, as a user meets the page (no test hooks, no ?perf): (A) a first visit with nothing stored: editor appears,
// no console error / failed request, no request for assets/inlineEdit-*.js during ~2 minutes of ordinary use (typing
// Markdown, ticking a task box, mode buttons, outline), the 预览可编辑 button exists and is not pressed; (B) turning the
// switch on / reload / off; (C) a failing chunk (route abort); (D) three must-not cases with the switch on (soft-hyphen
// reference kept, inline iframe refused with a toast, Backspace join in a list with an inline formula).
// About 7 page loads in all. Non-visible characters are built from code points.
// Run: cd /Users/zyx/LocalDocuments/MDReader && node bench/verify/v8-vw-user.mjs <phase A|B|C|D|all> [baseUrl] > out.json
import { chromium } from '@playwright/test';

const PHASE = process.argv[2] ?? 'all';
const BASE = process.argv[3] ?? 'https://mdreader.cashbook2026.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = /\/assets\/inlineEdit-[^/]*\.js(\?|$)/;
const LOAD_FAILED = '预览编辑功能加载失败，请刷新页面或重启应用后重试';
const NOT_EDITABLE = '此块请在源码中编辑';
const BTN = 'button[data-cmd="view.togglePreviewEdit"]';
const out = { base: BASE };
const t0 = Date.now();
const log = (...a) => console.error(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

async function open(browser, { abortChunk = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  await context.addInitScript(([A, B]) => {
    window.__vw = { toasts: [] };
    const obs = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        const t = n.matches?.('.mdr-toast') ? n : n.querySelector?.('.mdr-toast');
        if (t) window.__vw.toasts.push(t.textContent);
        else if ((n.textContent || '').includes(A) || (n.textContent || '').includes(B)) window.__vw.toasts.push(n.textContent);
      }
    });
    obs.observe(document, { childList: true, subtree: true });
  }, [LOAD_FAILED, NOT_EDITABLE]);
  if (abortChunk) await context.route(CHUNK, (r) => r.abort('failed'));
  const page = await context.newPage();
  const S = { context, page, errors: [], failed: [], bad: [], chunk: [], requests: 0 };
  page.on('console', (m) => { if (m.type() === 'error') S.errors.push(m.text()); });
  page.on('pageerror', (e) => S.errors.push('pageerror: ' + String(e)));
  page.on('request', (r) => { S.requests++; if (CHUNK.test(r.url())) S.chunk.push({ url: r.url().replace(BASE, ''), at: Date.now(), conditional: Object.keys(r.headers()).filter((h) => h.startsWith('if-')) }); });
  page.on('requestfailed', (r) => S.failed.push(r.url().replace(BASE, '') + ' ' + (r.failure()?.errorText ?? '')));
  page.on('response', (r) => { if (r.status() >= 400) S.bad.push(r.status() + ' ' + r.url().replace(BASE, '')); if (CHUNK.test(r.url())) S.chunkResp = (S.chunkResp ?? []).concat(r.status()); });
  return S;
}
async function goto(S) {
  const start = Date.now();
  await S.page.goto(BASE + '/', { waitUntil: 'load', timeout: 60000 });
  const loadAt = Date.now();
  await S.page.waitForSelector('.cm-content', { timeout: 30000 });
  return { start, loadAt, editorAt: Date.now() };
}
const src = (S) => S.page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
const pressed = (S) => S.page.evaluate((b) => document.querySelector(b)?.getAttribute('aria-pressed') ?? 'NO-BUTTON', BTN);
const stored = (S) => S.page.evaluate(() => { try { return localStorage.getItem('mdr.previewEdit'); } catch (e) { return 'ERR ' + e; } });
const editing = (S) => S.page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
const toastsSeen = (S) => S.page.evaluate(() => window.__vw.toasts.slice());
/** Puts a whole document in through the editor (select all, paste), as a user would. */
async function putDoc(S, text) {
  await S.page.keyboard.press('Escape');
  await S.page.click('.cm-content');
  await S.page.keyboard.press('Meta+a');
  await S.page.evaluate((t) => {
    const dt = new DataTransfer(); dt.setData('text/plain', t);
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await sleep(1500);
}
async function pointOf(S, needle, off = 1) {
  return S.page.evaluate(([needle, off]) => {
    const root = document.querySelector('.mdr-preview');
    const tw = document.createTreeWalker(root, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange(); r.setStart(n, i + off); r.setEnd(n, i + off + 1);
      const b = r.getBoundingClientRect(); return { x: b.left + Math.min(1, b.width / 2), y: b.top + b.height / 2 };
    }
    return null;
  }, [needle, off]);
}
async function clickText(S, needle, off = 1) {
  const p = await pointOf(S, needle, off);
  if (!p) return 'not-found';
  await sleep(150);
  const p2 = await pointOf(S, needle, off);
  await S.page.mouse.click(p2.x, p2.y);
  await sleep(500);
  return editing(S);
}
async function caretInSession(S, needle, off) {
  return S.page.evaluate(([needle, off]) => {
    const el = document.querySelector('.md-block.is-editing'); if (!el) return false;
    const tw = document.createTreeWalker(el, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i >= 0) { const r = document.createRange(); r.setStart(n, i + off); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
    }
    return false;
  }, [needle, off]);
}
const finish = async (S) => ({ errors: S.errors, failed: S.failed, bad: S.bad, chunkRequests: S.chunk.length, chunkStatus: S.chunkResp ?? [], requests: S.requests });

async function phaseA(browser) {
  const S = await open(browser);
  const r = { };
  const tm = await goto(S);
  r.loadMs = tm.loadAt - tm.start; r.editorMs = tm.editorAt - tm.start;
  r.buttonPressed = await pressed(S);
  r.buttonTitle = await S.page.evaluate((b) => document.querySelector(b)?.title ?? null, BTN);
  r.storedAtStart = await stored(S);
  r.startDocLen = (await src(S)).length;
  await sleep(2000);
  // Type a document: heading and paragraph keystroke by keystroke, the structured lines as text input.
  await S.page.click('.cm-content');
  await S.page.keyboard.press('Meta+a');
  await S.page.keyboard.press('Backspace');
  await S.page.keyboard.type('# Web check', { delay: 15 });
  await S.page.keyboard.press('Enter'); await S.page.keyboard.press('Enter');
  await S.page.keyboard.type('A plain paragraph with $a+b$ inline.', { delay: 15 });
  await S.page.keyboard.press('Enter'); await S.page.keyboard.press('Enter');
  const F = '```';
  const rest = ['- one', '- two', '', '- [ ] task item', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '$$', 'E = mc^2', '$$', '', F + 'js', 'const x = 1;', F, ''];
  for (const line of rest) { await S.page.keyboard.insertText(line + '\n'); await sleep(60); }
  await sleep(2500);
  r.typedSource = await src(S);
  r.preview = await S.page.evaluate(() => {
    const p = document.querySelector('.mdr-preview');
    return { h1: p.querySelector('h1')?.textContent ?? null, li: p.querySelectorAll('li').length, task: p.querySelectorAll('input[type=checkbox]').length,
      table: p.querySelectorAll('table td').length, katex: p.querySelectorAll('.katex').length, katexDisplay: p.querySelectorAll('.katex-display').length,
      code: p.querySelector('pre code')?.textContent ?? null };
  });
  // Tick the task box in the preview.
  const box = await S.page.$('.mdr-preview input[type=checkbox]');
  if (box) { await box.scrollIntoViewIfNeeded(); await box.click(); await sleep(1200); }
  r.afterTick = (await src(S)).split('\n').filter((l) => l.includes('task item'));
  r.boxChecked = box ? await box.evaluate((b) => b.checked).catch(() => 'detached') : 'no-box';
  // Mode buttons.
  r.modes = {};
  for (const m of ['preview', 'edit', 'split']) {
    await S.page.click(`button[data-cmd="view.mode.${m}"]`); await sleep(700);
    r.modes[m] = await S.page.evaluate((m) => ({ pressed: document.querySelector(`button[data-cmd="view.mode.${m}"]`).getAttribute('aria-pressed'),
      previewVisible: !!document.querySelector('.mdr-preview')?.offsetWidth, editorVisible: !!document.querySelector('.cm-editor')?.offsetWidth }), m);
  }
  // Outline.
  const tocBefore = await S.page.evaluate(() => document.querySelector('button[data-cmd="view.toggleToc"]').getAttribute('aria-pressed'));
  const tocState = () => S.page.evaluate(() => ({ pressed: document.querySelector('button[data-cmd="view.toggleToc"]').getAttribute('aria-pressed'),
    visibleItems: [...document.querySelectorAll('.mdr-toc a, .mdr-toc li, .mdr-toc [data-line]')].filter((e) => e.offsetWidth > 0).map((e) => e.textContent.trim()).filter(Boolean).slice(0, 6) }));
  r.toc = { before: await tocState(), clicks: [] };
  // Open the outline: if it is already open (wide window), close it and open it again.
  for (let i = 0; i < (tocBefore === 'true' ? 2 : 1); i++) {
    await S.page.click('button[data-cmd="view.toggleToc"]'); await sleep(800);
    r.toc.clicks.push(await tocState());
  }
  // Ordinary use until two minutes after the editor appeared: a line every few seconds, scrolling the preview.
  let n = 0;
  while (Date.now() - tm.editorAt < 121000) {
    await S.page.click('.cm-content'); await S.page.keyboard.press('Meta+ArrowDown');
    await S.page.keyboard.type(`\nline ${++n} with **bold**`, { delay: 10 });
    await S.page.mouse.wheel(0, 200);
    await sleep(4000);
  }
  r.ordinaryUseSec = Math.round((Date.now() - tm.editorAt) / 1000);
  r.linesAdded = n;
  r.previewHasLastLine = await S.page.evaluate((n) => document.querySelector('.mdr-preview').textContent.includes(`line ${n} with bold`), n);
  r.buttonPressedEnd = await pressed(S);
  r.storedEnd = await stored(S);
  r.toastsSeen = await toastsSeen(S);
  Object.assign(r, await finish(S));
  await S.context.close();
  return r;
}

const P1 = 'Alpha bravo charlie delta.';
async function sessionTyping(S, r, tag) {
  await putDoc(S, P1 + '\n');
  const before = await src(S);
  r[tag + 'session'] = await clickText(S, 'bravo', 2);   // caret between "br" and "avo"
  await S.page.keyboard.type('XY', { delay: 40 });
  await sleep(900);
  r[tag + 'sourceLive'] = await src(S);
  await S.page.keyboard.press('Escape'); await sleep(900);
  r[tag + 'sourceAfter'] = await src(S);
  r[tag + 'sourceBefore'] = before;
  r[tag + 'ok'] = r[tag + 'sourceAfter'] === before.replace('bravo', 'brXYavo');
  r[tag + 'editingAfterEsc'] = await editing(S);
}
async function phaseB(browser) {
  const S = await open(browser);
  const r = {};
  const tm = await goto(S);
  await sleep(2500);
  r.pressedBefore = await pressed(S);
  r.chunkBeforePress = S.chunk.length;
  const pressAt = Date.now();
  await S.page.click(BTN);
  await sleep(2500);
  r.chunkAfterPress = S.chunk.map((c) => ({ url: c.url, msAfterPress: c.at - pressAt, conditional: c.conditional }));
  r.chunkStatus = S.chunkResp ?? [];
  r.pressedAfter = await pressed(S);
  r.storedAfter = await stored(S);
  await sessionTyping(S, r, 's1_');
  // Reload.
  S.chunk.length = 0; S.chunkResp = [];
  const rs = Date.now();
  await S.page.reload({ waitUntil: 'load' });
  const loadAt = Date.now();
  await S.page.waitForSelector('.cm-content');
  const readyAt = Date.now();
  await sleep(3000);
  r.reload = { pressed: await pressed(S), stored: await stored(S), chunk: S.chunk.map((c) => ({ url: c.url, msAfterLoadEvent: c.at - loadAt, msAfterEditor: c.at - readyAt })), chunkStatus: S.chunkResp,
    loadMs: loadAt - rs };
  await sessionTyping(S, r, 's2_');
  // Off.
  await S.page.click(BTN); await sleep(800);
  r.off = { pressed: await pressed(S), stored: await stored(S) };
  await putDoc(S, P1 + '\n');
  const b = await src(S);
  r.off.sessionOnClick = await clickText(S, 'charlie', 2);
  await S.page.keyboard.press('Escape');
  r.off.sourceUnchanged = (await src(S)) === b;
  r.toastsSeen = await toastsSeen(S);
  Object.assign(r, await finish(S));
  r.chunkRequestsTotalNote = 'chunk counters were reset at the reload';
  await S.context.close();
  return r;
}
async function phaseC(browser) {
  const S = await open(browser, { abortChunk: true });
  const r = {};
  await goto(S);
  await sleep(2500);
  await S.page.click(BTN);
  await sleep(3000);
  r.toastsSeen = await toastsSeen(S);
  r.toastShown = r.toastsSeen.some((t) => t.includes(LOAD_FAILED));
  r.pressed = await pressed(S);
  r.stored = await stored(S);
  await S.page.click('.cm-content'); await S.page.keyboard.press('Meta+ArrowDown');
  const b = await src(S);
  await S.page.keyboard.type('\nstill typing', { delay: 15 }); await sleep(1200);
  const a = await src(S);
  r.editorWorks = a === b + '\nstill typing';
  r.previewHasTyped = await S.page.evaluate(() => document.querySelector('.mdr-preview').textContent.includes('still typing'));
  Object.assign(r, await finish(S));
  await S.context.close();
  return r;
}
async function phaseD(browser) {
  const S = await open(browser);
  const r = {};
  await goto(S);
  await sleep(2500);
  await S.page.click(BTN); await sleep(2500);
  r.pressed = await pressed(S);
  // (a) soft-hyphen reference.
  const REF = '&' + 'shy;';
  const docA = 'Soft' + REF + 'hyphen word here and more text.\n';
  await putDoc(S, docA);
  r.a = { before: await src(S) };
  r.a.session = await clickText(S, 'more', 2);
  await S.page.keyboard.type('Z', { delay: 40 }); await sleep(600);
  await S.page.keyboard.press('Escape'); await sleep(900);
  r.a.after = await src(S);
  r.a.refKept = r.a.after.includes(REF);
  r.a.expected = r.a.after === docA.replace('more', 'moZre');
  // (b) inline iframe.
  const docB = 'Text with <iframe src="about:blank"></iframe> inline frame here.\n';
  await putDoc(S, docB);
  const tb = (await toastsSeen(S)).length;
  r.b = { before: await src(S) };
  r.b.session = await clickText(S, 'inline frame', 3);
  await sleep(600);
  r.b.toastsNew = (await toastsSeen(S)).slice(tb);
  r.b.toastShown = r.b.toastsNew.some((t) => t.includes(NOT_EDITABLE));
  await S.page.keyboard.press('Escape'); await sleep(400);
  r.b.after = await src(S);
  r.b.unchanged = r.b.after === docB;
  // (c) list with an inline formula, Backspace at the start of the second item.
  const docC = '- first $x^2+1$ item\n- second item\n';
  await putDoc(S, docC);
  r.c = { before: await src(S) };
  r.c.session = await clickText(S, 'second', 2);
  r.c.caret = await caretInSession(S, 'second', 0);
  await S.page.keyboard.press('Backspace'); await sleep(600);
  await S.page.keyboard.press('Escape'); await sleep(900);
  r.c.after = await src(S);
  r.c.formulaKept = (r.c.after.match(/\$[^$]*\$/g) ?? []).join('|');
  r.c.joined = !r.c.after.includes('\n- second');
  r.toastsSeen = await toastsSeen(S);
  Object.assign(r, await finish(S));
  await S.context.close();
  return r;
}

const kill = setTimeout(() => { console.log(JSON.stringify({ ...out, GLOBAL_TIMEOUT: true }, null, 1)); process.exit(3); }, 330000);
const browser = await chromium.launch({ headless: true });
try {
  for (const [k, f] of [['A', phaseA], ['B', phaseB], ['C', phaseC], ['D', phaseD]]) {
    if (PHASE !== 'all' && PHASE !== k) continue;
    log('phase', k);
    try { out[k] = await f(browser); } catch (e) { out[k] = { THREW: String(e).slice(0, 600) }; }
    log('done', k);
  }
} finally { await browser.close(); clearTimeout(kill); }
console.log(JSON.stringify(out, null, 1));
