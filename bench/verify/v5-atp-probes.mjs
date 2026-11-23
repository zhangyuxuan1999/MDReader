// bench/verify/v5-atp-probes.mjs — probe-activation (0.2.0 stage 2e): every way a user (or a script) can activate a
// task checkbox of the preview, on the candidate (switch off) and on 0.1.1, with the same gesture. Per case and build:
// the source lines that changed, the boxes' states afterwards and the events the page saw (window, capture phase).
//   MDR_PORT=5531 MDR_BASE_PORT=5532 node bench/verify/v5-atp-probes.mjs <case ...|group:q2|q3|q4|q5|q6> [--build cand|base]
//   MDR_ATP_JSON=<file>  also writes every result as JSON lines
// Needs both servers listening (see v5-atp-lib.mjs). Global timeout 115 s per invocation; writes nothing into the tree.
import fs from 'node:fs';
import { open, loadDoc, source, states, statesStr, srcDiff, rectOf, textPoint, events, clearEvents, watch, fmtEv, observe, idle, sleep, globalTimeout } from './v5-atp-lib.mjs';

const argv = process.argv.slice(2);
const bi = argv.indexOf('--build');
const BUILDS = bi >= 0 ? [argv[bi + 1]] : ['cand', 'base'];
const names = argv.filter((a, i) => !a.startsWith('--') && (bi < 0 || i !== bi + 1));
const JSON_OUT = process.env.MDR_ATP_JSON || '';
let current = null;
globalTimeout(115_000, () => current?.close());

const CASES = {};
const CTX = {};   // per case: newContext options

// ---------------------------------------------------------------- shared measuring
/** Replays the recorded events through hitsBox variants (the candidate's state machine: a press sets pressOn and
 *  clears keyOn, a key sets keyOn and clears pressOn, every click clears both after its test). For each click whose
 *  target is `boxDesc`: (i) the current test, (ii) floor / ceil of the rect, (iii) no coordinate test. */
export function replayTests(ev, boxDesc) {
  let pressOn = null, keyOn = null, rect = null;
  const out = [];
  for (const e of ev) {
    if (e.type === 'pointerdown' || e.type === 'mousedown') { pressOn = e.target; keyOn = null; if (e.rect) rect = e.rect; }
    else if (e.type === 'keydown') { keyOn = e.target; pressOn = null; }
    else if (e.type === 'click') {
      if (e.target === boxDesc && rect) {
        const [l, t, r, b] = rect;
        const key = e.detail === 0 && keyOn === boxDesc;
        const p = pressOn === boxDesc;
        out.push({
          i: key || (p && e.cx >= l && e.cx <= r && e.cy >= t && e.cy <= b),
          ii: key || (p && Math.floor(l) <= e.cx && e.cx <= Math.ceil(r) && Math.floor(t) <= e.cy && e.cy <= Math.ceil(b)),
          iii: key || p,
        });
      }
      pressOn = null; keyOn = null;
    }
  }
  return out;
}

/** 73 points over a rect: each edge at 0.1 / 0.3 / 0.5 / 0.8 / 1.2 px inside and outside (at the middle of the other
 *  axis), each corner at 0.1 / 0.3 / 0.5 / 0.8 px inside and outside along the diagonal, and the centre. */
export function gridPoints(R) {
  const cx = (R.l + R.r) / 2, cy = (R.t + R.b) / 2;
  const pts = [{ name: 'centre', x: cx, y: cy }];
  for (const d of [0.1, 0.3, 0.5, 0.8, 1.2]) for (const [io, s] of [['in', 1], ['out', -1]]) {
    pts.push({ name: `left-${io}${d}`, x: R.l + s * d, y: cy });
    pts.push({ name: `right-${io}${d}`, x: R.r - s * d, y: cy });
    pts.push({ name: `top-${io}${d}`, x: cx, y: R.t + s * d });
    pts.push({ name: `bottom-${io}${d}`, x: cx, y: R.b - s * d });
  }
  for (const d of [0.1, 0.3, 0.5, 0.8]) for (const [io, s] of [['in', 1], ['out', -1]]) {
    pts.push({ name: `tl-${io}${d}`, x: R.l + s * d, y: R.t + s * d });
    pts.push({ name: `tr-${io}${d}`, x: R.r - s * d, y: R.t + s * d });
    pts.push({ name: `bl-${io}${d}`, x: R.l + s * d, y: R.b - s * d });
    pts.push({ name: `br-${io}${d}`, x: R.r - s * d, y: R.b - s * d });
  }
  return pts;
}

/** Clicks every grid point on the task `name` (page.mouse: trusted events). io: {page, source(), idle(), boxDesc}.
 *  Returns per point: truth (the pointerdown went to the box), coordinates, ticked, and the three tests. */
export async function runGrid(io, name, R) {
  const { page } = io;
  const recs = [];
  for (const p of gridPoints(R)) {
    await page.evaluate(() => { window.__atpEv.length = 0; });
    const s0 = await io.source();
    await page.mouse.click(p.x, p.y);
    await sleep(120);
    await io.idle();
    const s1 = await io.source();
    const ev = await page.evaluate(() => window.__atpEv.slice());
    const pd = ev.find((e) => e.type === 'pointerdown');
    const ck = ev.filter((e) => e.type === 'click').at(-1);
    const tests = replayTests(ev, io.boxDesc);
    recs.push({
      name: p.name, x: +p.x.toFixed(3), y: +p.y.toFixed(3), truth: !!pd && pd.target === io.boxDesc,
      pd: pd ? [pd.cx, pd.cy] : null, click: ck ? [ck.cx, ck.cy] : null, clickTarget: ck?.target ?? null, rect: pd?.rect ?? null,
      ticked: s0 !== s1, i: tests.some((t) => t.i), ii: tests.some((t) => t.ii), iii: tests.some((t) => t.iii),
    });
  }
  return recs;
}
export function gridSummary(recs) {
  const hits = recs.filter((r) => r.truth), misses = recs.filter((r) => !r.truth);
  const cnt = (arr, k, want) => arr.filter((r) => !!r[k] === want).length;
  const names = (arr, k, want) => arr.filter((r) => !!r[k] === want).map((r) => r.name).join(' ');
  return {
    points: recs.length, hits: hits.length, misses: misses.length,
    ticked: { hitsTicked: cnt(hits, 'ticked', true), hitsRefused: cnt(hits, 'ticked', false), missesTicked: cnt(misses, 'ticked', true), refusedHits: names(hits, 'ticked', false) },
    i: { hitsRefused: cnt(hits, 'i', false), missesAccepted: cnt(misses, 'i', true) },
    ii: { hitsRefused: cnt(hits, 'ii', false), missesAccepted: cnt(misses, 'ii', true) },
    iii: { hitsRefused: cnt(hits, 'iii', false), missesAccepted: cnt(misses, 'iii', true) },
    rect: recs[0]?.rect, sample: recs.filter((r) => /^(left|top)-in0\.(3|5)$|^centre$|^tl-in0\.3$/.test(r.name)).map((r) => `${r.name}: pd=${r.pd} click=${r.click} truth=${r.truth} ticked=${r.ticked}`).join(' | '),
  };
}

// ---------------------------------------------------------------- Q2: fractional positions, headless DSF 1 and 2
for (const dsf of [1, 2]) for (const task of ['alpha', 'beta', 'gamma']) {
  const n = `q2:grid-dsf${dsf}-${task}`;
  CTX[n] = { deviceScaleFactor: dsf };
  CASES[n] = async (B) => {
    await loadDoc(B);
    await watch(B, task);
    const R = await rectOf(B, task);
    const recs = await runGrid({ page: B.page, source: () => source(B), idle: () => idle(B, 60), boxDesc: `input[checkbox].task{${task}}` }, task, R);
    return { rectFrac: [R.l, R.t, R.r, R.b].map((v) => +v.toFixed(3)).join(','), ...gridSummary(recs), recs };
  };
}
// three label gestures (is (iii) ever fooled by a forwarded click?) on the label-wrapped task and on the raw label
for (const [box, text, boxDesc] of [['wrapped', 'label words', 'input[checkbox].task{wrapped}@label'], ['raw', 'raw label text', 'input[checkbox].raw@label']]) {
  for (const g of ['box-to-text', 'text-to-box', 'text-click', 'box-click']) {
    CASES[`q2:label-${box}-${g}`] = async (B) => {
      await loadDoc(B);
      await watch(B, box);
      const R = await rectOf(B, box);
      const c = { x: (R.l + R.r) / 2, y: (R.t + R.b) / 2 };
      const tp = await textPoint(B, text, 3);
      const s0 = await source(B), st0 = await states(B);
      await clearEvents(B);
      const { page } = B;
      if (g === 'box-click') await page.mouse.click(c.x, c.y);
      else if (g === 'text-click') await page.mouse.click(tp.x, tp.y);
      else {
        const [a, b] = g === 'box-to-text' ? [c, tp] : [tp, c];
        await page.mouse.move(a.x, a.y); await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6); await sleep(15); }
        await page.mouse.up();
      }
      const o = await observe(B, s0, st0);
      const tests = replayTests(o.ev, boxDesc);
      return { src: o.src, changed: o.changed, tests: JSON.stringify(tests), evs: o.evs, active: await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + (a.id ? '#' + a.id : '') : null; }) };
    };
  }
}

// ---------------------------------------------------------------- Q3: touch and pen
async function tapCDP(B, x, y, radius) {
  const cdp = B.cdp ?? (B.cdp = await B.context.newCDPSession(B.page));
  const tp = { x, y, id: 1, force: 1, ...(radius ? { radiusX: radius, radiusY: radius } : {}) };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp] });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function penCDP(B, x, y) {
  const cdp = B.cdp ?? (B.cdp = await B.context.newCDPSession(B.page));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'pen' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
}
function touchPoints(R) {
  const cx = (R.l + R.r) / 2, cy = (R.t + R.b) / 2;
  const pts = [{ name: 'centre', x: cx, y: cy }];
  // inside the left / top strips that U24's integer test refuses for a mouse (does touch adjustment move them?)
  for (const d of [0.3, 0.8]) pts.push({ name: `left-in${d}`, x: R.l + d, y: cy }, { name: `top-in${d}`, x: cx, y: R.t + d }, { name: `tl-in${d}`, x: R.l + d, y: R.t + d });
  for (const d of [1, 2, 4, 6, 8]) {
    pts.push({ name: `left-${d}`, x: R.l - d, y: cy }, { name: `right-${d}`, x: R.r + d, y: cy }, { name: `top-${d}`, x: cx, y: R.t - d }, { name: `bottom-${d}`, x: cx, y: R.b + d });
  }
  return pts;
}
async function touchRun(B, how, radius, task = 'alpha') {
  await loadDoc(B);
  await watch(B, task);
  const R = await rectOf(B, task);
  const boxDesc = `input[checkbox].task{${task}}`;
  const out = [];
  const pts = how === 'pen' ? [
    { name: 'centre', x: (R.l + R.r) / 2, y: (R.t + R.b) / 2 },
    ...[0.3, 0.8].flatMap((d) => [{ name: `left-in${d}`, x: R.l + d, y: (R.t + R.b) / 2 }, { name: `top-in${d}`, x: (R.l + R.r) / 2, y: R.t + d }, { name: `right-in${d}`, x: R.r - d, y: (R.t + R.b) / 2 }, { name: `bottom-in${d}`, x: (R.l + R.r) / 2, y: R.b - d }]),
    ...[1, 2].flatMap((d) => [{ name: `left-out${d}`, x: R.l - d, y: (R.t + R.b) / 2 }, { name: `top-out${d}`, x: (R.l + R.r) / 2, y: R.t - d }]),
  ] : touchPoints(R);
  for (const p of pts) {
    await clearEvents(B);
    const s0 = await source(B), st0 = await states(B);
    if (how === 'pen') await penCDP(B, p.x, p.y);
    else if (how === 'pw') await B.page.touchscreen.tap(p.x, p.y);
    else await tapCDP(B, p.x, p.y, radius);
    await sleep(how === 'pen' ? 150 : 450);
    const o = await observe(B, s0, st0);
    const md = o.ev.find((e) => e.type === 'mousedown');
    const pd = o.ev.find((e) => e.type === 'pointerdown');
    const ck = o.ev.filter((e) => e.type === 'click').at(-1);
    out.push({ name: p.name, pt: `${p.x.toFixed(2)},${p.y.toFixed(2)}`, ticked: o.src !== 'unchanged', changed: o.changed,
      pdTarget: pd?.target ?? null, mdTarget: md?.target ?? null, clickTarget: ck?.target ?? null, click: ck ? `${ck.cx},${ck.cy}` : null,
      boxHitByPress: !!md && md.target === boxDesc, tests: JSON.stringify(replayTests(o.ev, boxDesc)), evs: fmtEv(o.ev) });
    if (o.src !== 'unchanged') {   // put the task back with a centre mouse click (keeps every tap on a fresh state)
      await B.page.mouse.click((R.l + R.r) / 2, (R.t + R.b) / 2); await sleep(150); await idle(B, 100);
    }
  }
  return { rect: [R.l, R.t, R.r, R.b].map((v) => +v.toFixed(3)).join(','), ticked: out.filter((r) => r.ticked).map((r) => r.name).join(' '), notTicked: out.filter((r) => !r.ticked).map((r) => r.name).join(' '), rows: out };
}
for (const mobile of [false, true]) {
  for (const [how, radius] of [['cdp', 0], ['cdp', 12], ['pw', 0]]) {
    const n = `q3:touch-${mobile ? 'mobile' : 'desktop'}-${how}${how === 'cdp' ? `-r${radius}` : ''}`;
    CTX[n] = { hasTouch: true, isMobile: mobile, ...(mobile ? { viewport: { width: 820, height: 1000 } } : {}) };
    CASES[n] = (B) => touchRun(B, how, radius);
  }
}
CTX['q3:pen'] = {};
CASES['q3:pen'] = (B) => touchRun(B, 'pen', 0);

// ---------------------------------------------------------------- Q4: keyboard
async function keyCase(B, steps) {
  await loadDoc(B);
  const s0 = await source(B), st0 = await states(B);
  const log = [];
  for (const [k, a] of steps) {
    if (k === 'clickText') { const p = await textPoint(B, a, 2); await B.page.mouse.click(p.x, p.y); await sleep(250); }
    else if (k === 'key') { await B.page.keyboard.press(a); await sleep(250); }
    const ae = await B.page.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.closest('.cm-editor')) return 'editor'; const li = a.closest('li'); return a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (li ? '{' + li.textContent.trim().slice(0, 10) + '}' : ''); });
    log.push(`${k}(${a})->focus ${ae}`);
  }
  const o = await observe(B, s0, st0);
  return { src: o.src, changed: o.changed, states: o.states, steps: log.join(' ; '), evs: fmtEv(o.ev.filter((e) => e.type !== 'pointerup' && e.type !== 'mouseup'), { coords: true }) };
}
CASES['q4:tab-space'] = (B) => keyCase(B, [['clickText', 'Intro paragraph'], ['key', 'Tab'], ['key', 'Space']]);
CASES['q4:text-tab-space'] = (B) => keyCase(B, [['clickText', 'alpha task'], ['key', 'Tab'], ['key', 'Space']]);
CASES['q4:label-then-space'] = (B) => keyCase(B, [['clickText', 'label words'], ['key', 'Space']]);
CASES['q4:rawlabel-then-space'] = (B) => keyCase(B, [['clickText', 'raw label text'], ['key', 'Space']]);
CASES['q4:tab-enter'] = (B) => keyCase(B, [['clickText', 'Intro paragraph'], ['key', 'Tab'], ['key', 'Enter']]);
CASES['q4:tab-space-space'] = (B) => keyCase(B, [['clickText', 'Intro paragraph'], ['key', 'Tab'], ['key', 'Space'], ['key', 'Space']]);
CASES['q4:quote-tab-space'] = (B) => keyCase(B, [['clickText', 'Intro paragraph'], ['key', 'Tab'], ['key', 'Tab'], ['key', 'Tab'], ['key', 'Space']]);

// ---------------------------------------------------------------- Q5: clicks from script
async function scriptCase(B, how) {
  await loadDoc(B);
  await watch(B, 'alpha');
  await rectOf(B, 'alpha');
  const s0 = await source(B), st0 = await states(B);
  await B.page.evaluate((how) => {
    const box = window.__atpBox('alpha');
    const r = box.getBoundingClientRect();
    const c = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const ev = (type, xy, detail) => new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, detail, ...xy });
    const zero = { clientX: 0, clientY: 0 };
    if (how === 'input.click') box.click();
    else if (how === 'click-0') box.dispatchEvent(ev('click', zero, 0));
    else if (how === 'click-centre') box.dispatchEvent(ev('click', c, 0));
    else if (how === 'click-centre-d1') box.dispatchEvent(ev('click', c, 1));
    else if (how === 'down-click-0') { box.dispatchEvent(ev('mousedown', zero, 1)); box.dispatchEvent(ev('mouseup', zero, 1)); box.dispatchEvent(ev('click', zero, 1)); }
    else if (how === 'down-click-centre') { box.dispatchEvent(ev('mousedown', c, 1)); box.dispatchEvent(ev('mouseup', c, 1)); box.dispatchEvent(ev('click', c, 1)); }
    else if (how === 'down-click-centre-d0') { box.dispatchEvent(ev('mousedown', c, 0)); box.dispatchEvent(ev('click', c, 0)); }
    else if (how === 'pointer-down-click-centre') { box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', ...c })); box.dispatchEvent(ev('click', c, 1)); }
    else if (how === 'vimium') { for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) box.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 })); }
    else if (how === 'focus-key-click') { box.focus(); box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); box.dispatchEvent(ev('click', zero, 0)); }
  }, how);
  const o = await observe(B, s0, st0);
  return { src: o.src, changed: o.changed, evs: fmtEv(o.ev) };
}
for (const how of ['input.click', 'click-0', 'click-centre', 'click-centre-d1', 'down-click-0', 'down-click-centre', 'down-click-centre-d0', 'pointer-down-click-centre', 'vimium', 'focus-key-click']) CASES[`q5:${how}`] = (B) => scriptCase(B, how);

// ---------------------------------------------------------------- Q6: other activations
async function mouseCase(B, fn, task = 'alpha') {
  await loadDoc(B);
  await watch(B, task);
  const R = await rectOf(B, task);
  const c = { x: (R.l + R.r) / 2, y: (R.t + R.b) / 2 };
  const s0 = await source(B), st0 = await states(B);
  const extra = await fn(B, c, R);
  const o = await observe(B, s0, st0);
  const ed = await B.page.evaluate(() => { const v = window.__mdr.app; const s = document.querySelector('.cm-editor .cm-activeLine'); return s ? s.textContent.slice(0, 30) : null; });
  return { src: o.src, changed: o.changed, editorActiveLine: ed, ...(extra || {}), evs: fmtEv(o.ev.filter((e) => e.type !== 'pointerup' && e.type !== 'mouseup')) };
}
CASES['q6:dblclick'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.dblclick(c.x, c.y); });
for (const m of ['Shift', 'Control', 'Alt', 'Meta']) CASES[`q6:${m.toLowerCase()}-click`] = (B) => mouseCase(B, async (B, c) => { await B.page.keyboard.down(m); await B.page.mouse.click(c.x, c.y); await B.page.keyboard.up(m); });
CASES['q6:press-box-release-outside'] = (B) => mouseCase(B, async (B, c) => {
  const tp = await textPoint(B, 'Intro paragraph', 4);
  await B.page.mouse.move(c.x, c.y); await B.page.mouse.down();
  for (let i = 1; i <= 6; i++) { await B.page.mouse.move(c.x + (tp.x - c.x) * i / 6, c.y + (tp.y - c.y) * i / 6); await sleep(15); }
  await B.page.mouse.up();
});
CASES['q6:press-box-release-own-text'] = (B) => mouseCase(B, async (B, c) => {
  const tp = await textPoint(B, 'alpha task', 3);
  await B.page.mouse.move(c.x, c.y); await B.page.mouse.down();
  for (let i = 1; i <= 6; i++) { await B.page.mouse.move(c.x + (tp.x - c.x) * i / 6, c.y + (tp.y - c.y) * i / 6); await sleep(15); }
  await B.page.mouse.up();
});
CASES['q6:press-text-release-box'] = (B) => mouseCase(B, async (B, c) => {
  const tp = await textPoint(B, 'alpha task', 3);
  await B.page.mouse.move(tp.x, tp.y); await B.page.mouse.down();
  for (let i = 1; i <= 6; i++) { await B.page.mouse.move(tp.x + (c.x - tp.x) * i / 6, tp.y + (c.y - tp.y) * i / 6); await sleep(15); }
  await B.page.mouse.up();
});
CASES['q6:background-page-click'] = (B) => mouseCase(B, async (B, c) => {
  const other = await B.context.newPage();
  await other.goto('about:blank'); await other.bringToFront(); await sleep(200);
  const hasFocus0 = await B.page.evaluate(() => document.hasFocus());
  await B.page.mouse.click(c.x, c.y);
  const hasFocus1 = await B.page.evaluate(() => document.hasFocus());
  await other.close();
  return { hasFocusBefore: hasFocus0, hasFocusAfter: hasFocus1 };
});
CASES['q6:right-click'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y, { button: 'right' }); });
CASES['q6:middle-click'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y, { button: 'middle' }); });
CASES['q6:triple-click'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y, { clickCount: 3 }); });
CASES['q6:click-held-long'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.move(c.x, c.y); await B.page.mouse.down(); await sleep(1200); await B.page.mouse.up(); });
CASES['q6:sanity-centre'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y); });
CASES['q6:sanity-centre-beta'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y); }, 'beta');
CASES['q6:sanity-centre-gamma'] = (B) => mouseCase(B, async (B, c) => { await B.page.mouse.click(c.x, c.y); }, 'gamma');

// ---------------------------------------------------------------- runner
const groups = { 'group:q2': (k) => k.startsWith('q2:'), 'group:q3': (k) => k.startsWith('q3:'), 'group:q4': (k) => k.startsWith('q4:'), 'group:q5': (k) => k.startsWith('q5:'), 'group:q6': (k) => k.startsWith('q6:') };
let todo = [];
for (const n of names) {
  if (groups[n]) todo.push(...Object.keys(CASES).filter(groups[n]));
  else if (n.endsWith('*')) todo.push(...Object.keys(CASES).filter((k) => k.startsWith(n.slice(0, -1))));
  else if (CASES[n]) todo.push(n);
  else { console.log(`unknown case ${n}`); process.exit(64); }
}
if (!todo.length) { console.log(Object.keys(CASES).join('\n')); process.exit(0); }
for (const n of todo) {
  for (const build of BUILDS) {
    try {
      current = await open(build, CTX[n] || {});
      const r = await CASES[n](current);
      const { recs, rows, ...brief } = r;
      console.log(`${n} [${build}] ${JSON.stringify(brief)}`);
      if (rows) for (const row of rows) console.log(`   ${row.name}: ticked=${row.ticked} pd=${row.pdTarget} md=${row.mdTarget} click=${row.clickTarget}@${row.click} tests=${row.tests}`);
      if (JSON_OUT) fs.appendFileSync(JSON_OUT, JSON.stringify({ case: n, build, ...r }) + '\n');
      if (current.errors.length) console.log(`   page errors: ${current.errors.slice(0, 3).join(' | ')}`);
    } catch (e) {
      console.log(`${n} [${build}] ERROR ${String(e && e.stack || e).slice(0, 400)}`);
    } finally {
      await current?.close(); current = null;
    }
  }
}
process.exit(0);
