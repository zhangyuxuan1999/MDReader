// bench/verify/v6-vr-stamps.mjs — verify-review (stage 2f, after fix round 5): two small experiments in headless Chromium.
//  off   (questions 1-3) a REAL user (no ?perf=1) with the switch off ('0' stored, and nothing stored): the candidate build
//        against the 0.1.1 build — script requests, the editing chunk never asked for (also after a click, typing and a
//        tick), the listeners on window / document / the preview (CDP getEventListeners, per type), the editing elements.
//  stamps (question 4) the candidate build in test mode (?perf=1, switch on): the P-G stamps exist during a session and
//        none is left in the page after each way a session ends (Esc, a click on another block, the switch turned off,
//        Enter + typing (split), a new document, a refused start), and a document's own data-mdr-tex / data-mdr-ps never
//        reach the DOM (the sanitizer) nor become a stamp.
// Run: MDR_PORT=<vite preview of the candidate dist> MDR_BASE_PORT=<vite preview of the 0.1.1 dist> node bench/verify/v6-vr-stamps.mjs [off|stamps]
// Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT, basePort = process.env.MDR_BASE_PORT;
if (!port || !basePort) { console.log('pass MDR_PORT and MDR_BASE_PORT'); process.exit(2); }
const only = process.argv[2] || '';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

async function listeners(page) {
  const cdp = await page.context().newCDPSession(page);
  const out = {};
  for (const [name, expr] of [['window', 'window'], ['document', 'document'], ['preview', "document.querySelector('.mdr-preview') || document.querySelector('[class*=preview]')"]]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    if (!result.objectId) { out[name] = 'none'; continue; }
    const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
    const by = {};
    for (const l of ls) { const k = `${l.type}${l.useCapture ? ':c' : ''}`; by[k] = (by[k] ?? 0) + 1; }
    out[name] = by;
  }
  await cdp.detach();
  return out;
}
const editingEls = (page) => page.evaluate(() => ({
  hint: document.querySelectorAll('.mdr-preview__edit-hint').length,
  capture: document.querySelectorAll('.mdr-preview__edit-capture').length,
  ce: document.querySelectorAll('.md-block[contenteditable]').length,
  stamps: document.querySelectorAll('[data-mdr-tex], [data-mdr-ps]').length,
}));

async function offRun(browser, which, p, stored) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  if (stored !== null) await context.addInitScript((v) => { try { localStorage.setItem('mdr.previewEdit', v); } catch { /* */ } }, stored);
  const page = await context.newPage();
  const reqs = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') reqs.push(new URL(r.url()).pathname.replace(/-[\w-]{8}\.js$/, '.js')); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`http://localhost:${p}/?mode=split`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.cm-content', { timeout: 20000 });
    await sleep(5500);                                    // past the deferred start (first idle, 4 s at the latest)
    const atRest = { reqs: [...reqs].sort(), els: await editingEls(page), ls: await listeners(page) };
    // use it: type a small document, tick its task in the preview, click a paragraph, type again
    await page.click('.cm-content');
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('# T\n\n- [ ] task one\n\npara words here\n');
    await sleep(1500);
    const box = await page.$('.md-block input[type=checkbox]');
    if (box) { await box.click(); await sleep(600); }
    const para = await page.evaluate(() => {
      for (const p of Array.from(document.querySelectorAll('.md-block p'))) if ((p.textContent ?? '').includes('para words')) { const b = p.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; }
      return null;
    });
    if (para) { await page.mouse.click(para.x, para.y); await sleep(400); await page.keyboard.type('Q'); await sleep(600); }
    const text = await page.evaluate(() => Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'));
    const after = { reqs: [...reqs].sort(), els: await editingEls(page), text, errors };
    return { atRest, after };
  } finally { await context.close(); }
}

async function off(browser) {
  for (const stored of ['0', null]) {
    const c = await offRun(browser, 'cand', port, stored);
    const b = await offRun(browser, 'base', basePort, stored);
    const tag = `off stored=${stored === null ? 'none' : stored}`;
    const chunk = c.after.reqs.filter((u) => /inlineEdit/.test(u));
    check(`${tag}: the editing chunk is never requested (at rest, after typing, a tick, a click)`, chunk.length === 0, chunk.join(','));
    console.log(`info ${tag}: scripts cand=${c.atRest.reqs.length} base=${b.atRest.reqs.length}; cand-only=${c.atRest.reqs.filter((u) => !b.atRest.reqs.includes(u)).join(',')} base-only=${b.atRest.reqs.filter((u) => !c.atRest.reqs.includes(u)).join(',')}`);
    check(`${tag}: no editing element (hint, capture, contenteditable, stamp)`, JSON.stringify(c.atRest.els) === JSON.stringify(b.atRest.els) && JSON.stringify(c.after.els) === JSON.stringify(b.after.els), `cand ${JSON.stringify(c.after.els)} base ${JSON.stringify(b.after.els)}`);
    for (const k of ['window', 'document', 'preview']) {
      const cl = c.atRest.ls[k], bl = b.atRest.ls[k];
      const keys = [...new Set([...Object.keys(cl ?? {}), ...Object.keys(bl ?? {})])].sort();
      const diff = keys.filter((t) => (cl?.[t] ?? 0) !== (bl?.[t] ?? 0)).map((t) => `${t} ${cl?.[t] ?? 0}/${bl?.[t] ?? 0}`);
      console.log(`info ${tag}: listeners on ${k} cand/base differ in: ${diff.join(', ') || 'nothing'}`);
    }
    check(`${tag}: the same source after the same use`, c.after.text === b.after.text, `cand ${JSON.stringify(c.after.text)} base ${JSON.stringify(b.after.text)}`);
    check(`${tag}: no page error`, c.after.errors.length === 0, c.after.errors.join(' | '));
  }
}

const DOC = [
  '# Stamps', '',
  'Para one $x^2$ and <span style="color:red">red</span> and ![i](e.png) words.', '',
  'Para two $\\frac{a}{b}$ words.', '',
  '- [ ] task one $y$ words', '- [x] task two words', '',
  'Para three <span data-mdr-tex="EVIL" class="md-math">z</span> and <b data-mdr-ps=\'{"style":"color:blue"}\'>bb</b> words.', '',
  'Para four <u style="color:green">gg</u> words.', '',
].join('\n');

async function stamps(browser) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
    const load = async (t) => { await page.evaluate(([x]) => window.__mdr.loadText(x, 'stamps.md'), [t]); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(800); };
    const at = (needle) => page.evaluate(([n]) => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let x = tw.nextNode(); x; x = tw.nextNode()) {
        const i = x.data.indexOf(n);
        if (i >= 0) { const r = document.createRange(); r.setStart(x, i + n.length - 1); r.setEnd(x, i + n.length); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 }; }
      }
      return null;
    }, [needle]);
    const clickAt = async (needle) => { const q = await at(needle); if (!q) return false; await page.mouse.click(q.x, q.y); await sleep(450); return true; };
    const state = () => page.evaluate(() => {
      const ed = document.querySelector('.md-block.is-editing');
      return {
        editing: !!ed,
        tex: Array.from((ed ?? document).querySelectorAll('[data-mdr-tex]')).map((e) => e.getAttribute('data-mdr-tex')),
        ps: (ed ?? document).querySelectorAll('[data-mdr-ps]').length,
        pageStamps: document.querySelectorAll('[data-mdr-tex], [data-mdr-ps]').length,
        forged: document.querySelectorAll('[data-mdr-tex="EVIL"]').length,
      };
    });
    await load(DOC);
    const s0 = await state();
    check('stamps: none in the page before a session; the document\'s own data-mdr-tex / data-mdr-ps were removed by the sanitizer', s0.pageStamps === 0 && s0.forged === 0, JSON.stringify(s0));
    const ends = [
      ['esc', async () => { await page.keyboard.press('Escape'); }],
      ['click another block', async () => { await clickAt('Para two'); await page.keyboard.press('Escape'); }],
      ['switch off', async () => { await page.keyboard.press('Meta+Shift+E'); await sleep(300); await page.keyboard.press('Meta+Shift+E'); }],
      ['enter split + typing', async () => { await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Nn'); await sleep(500); await page.keyboard.press('Escape'); }],
      ['new document', async () => { await page.evaluate(() => window.__mdr.loadText('Other $q$ <span style="color:red">r</span> words\n', 'other.md')); }],
    ];
    for (const [name, end] of ends) {
      await load(DOC);
      await clickAt('Para one');                         // "Para one … words." (formula, styled span, image); the ?perf=1 overlay covers the right end
      const s1 = await state();
      check(`stamps/${name}: during the session the formulas and styled elements are stamped`, s1.editing && s1.tex.includes('x^2') && s1.ps > 0, JSON.stringify(s1));
      await end();
      await sleep(900);
      const s2 = await state();
      check(`stamps/${name}: none left in the page after it`, s2.pageStamps === 0 || (s2.editing && name === 'click another block'), JSON.stringify(s2));
    }
    // the forged block: a session on it (or its refusal) never makes "EVIL" a stamp
    await load(DOC);
    await clickAt('Para three');
    const s3 = await state();
    check('stamps/forged: a document\'s data-mdr-tex never becomes a stamp', s3.forged === 0 && !s3.tex.includes('EVIL'), JSON.stringify(s3));
    await page.keyboard.press('Escape');
    await sleep(600);
    // a refused start (a raw HTML block the gate refuses): nothing left
    await load('Lead <div>a<p>b</div> $x$ words\n\nPara <span style="color:red">r</span> $y$ words\n');
    await clickAt('Lead');
    await sleep(500);
    const s4 = await state();
    check('stamps/refused or plain start: none left outside a live session', s4.editing || s4.pageStamps === 0, JSON.stringify(s4));
    const text = await page.evaluate(() => window.__mdr.app.getText());
    console.log('info stamps: last source', JSON.stringify(text));
    check('stamps: no page error', errors.length === 0, errors.join(' | '));
  } finally { await context.close(); }
}

const browser = await chromium.launch({ headless: true });
try {
  if (!only || only === 'off') await off(browser);
  if (!only || only === 'stamps') await stamps(browser);
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);
