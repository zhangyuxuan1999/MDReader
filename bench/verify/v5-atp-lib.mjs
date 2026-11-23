// bench/verify/v5-atp-lib.mjs — probe-activation (0.2.0 stage 2e) shared helpers for bench/verify/v5-atp-*.mjs and
// bench/electron/v5-atp-desk.mjs. Two builds side by side, the same gestures on each:
//   cand: a dev server of the stable snapshot of round 4 (deleted at the release of 0.2.0; now this tree's dev server)
//         (MDR_PORT, default 5531), opened with
//         localStorage mdr.previewEdit = "0" put in place before the app starts; every open asserts the toolbar
//         button of view.togglePreviewEdit is not pressed;
//   base: vite preview of release/baseline-0.1.1.noindex/dist (MDR_BASE_PORT, default 5532), opened with ?perf=1.
// Starts no server, kills nothing, writes nothing into the tree.
import { chromium } from '@playwright/test';

export const PORT = Number(process.env.MDR_PORT || 5531);
export const BASE_PORT = Number(process.env.MDR_BASE_PORT || 5532);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Three tasks (one wraps, one in a blockquote), a task wrapped by a raw-HTML label, a raw-HTML label wrapping a
 *  raw checkbox, and a link. */
export const DOC = [
  '# ATP probe',
  '',
  'Intro paragraph before the tasks.',
  '',
  '- [ ] alpha task',
  '- [ ] beta task has a long text that wraps across the preview line at least once or twice so that this item spans more than one line in the preview pane of the window, and then some more words to be sure it wraps',
  '',
  '> - [ ] gamma quoted task',
  '',
  '- <label>label words here',
  '  - [ ] wrapped task',
  '  </label>',
  '',
  'A raw <label class="rawlab"><input type="checkbox" id="rawbox"> raw label text</label> in a paragraph.',
  '',
  'A [plain link](#atp-probe) here, and the end.',
  '',
].join('\n');
export const TASKS = ['alpha', 'beta', 'gamma', 'wrapped'];

/** Installed in the page (window, capture phase): every event of TYPES as the page saw it, with its target described
 *  in build-neutral terms; defaultPrevented is read after the dispatch. window.__atpWatch names the task whose
 *  checkbox rect is recorded with each press. Idempotent. */
export function recorderSource() {
  return `(() => {
    if (window.__atpEv) return;
    window.__atpEv = [];
    const TYPES = ['pointerdown','mousedown','pointerup','mouseup','click','dblclick','keydown','keyup','touchstart','touchend','focusin','change','contextmenu','auxclick'];
    const ownText = (li) => Array.from(li.childNodes).filter((n) => !(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))).map((n) => n.textContent).join('').trim();
    const taskName = (li) => { const t = ownText(li); const m = /^(alpha|beta|gamma|wrapped)/.exec(t); return m ? m[1] : t.slice(0, 12); };
    window.__atpBox = (name) => {
      const root = document.querySelector('.mdr-preview');
      if (!root) return null;
      if (name === 'raw') return root.querySelector('#rawbox');
      for (const inp of root.querySelectorAll('input[type=checkbox]')) { const li = inp.closest('li'); if (li && taskName(li) === name) return inp; }
      return null;
    };
    const desc = (t) => {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (!(t instanceof Element)) return String(t && t.nodeName);
      let s = t.tagName.toLowerCase();
      if (s === 'input') s += '[' + t.type + ']' + (t.id === 'rawbox' ? '.raw' : t.closest('li') ? '.task' : '.other');
      else if (t.id) s += '#' + t.id;
      else if (typeof t.className === 'string' && t.className) s += '.' + t.className.split(/\\s+/)[0];
      const li = t.closest('li');
      if (li && t.closest('.mdr-preview')) s += '{' + taskName(li) + '}';
      if (t.closest('label')) s += '@label';
      if (t.closest('.cm-editor')) s += '@editor';
      return s;
    };
    const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
    const rec = (e) => {
      const o = { type: e.type, trusted: e.isTrusted, target: desc(e.target) };
      if ('detail' in e && e.type !== 'focusin' && e.type !== 'change') o.detail = e.detail;
      if ('button' in e) { o.button = e.button; o.buttons = e.buttons; o.cx = r3(e.clientX); o.cy = r3(e.clientY); o.sx = r3(e.screenX); o.sy = r3(e.screenY); }
      if ('pointerType' in e) o.pt = e.pointerType;
      if (e.touches) { const t = (e.changedTouches || e.touches)[0]; if (t) { o.cx = r3(t.clientX); o.cy = r3(t.clientY); o.rx = r3(t.radiusX); o.ry = r3(t.radiusY); } }
      if ('key' in e) o.key = e.key;
      const mods = ['shiftKey','ctrlKey','altKey','metaKey'].filter((k) => e[k]).map((k) => k[0]).join('');
      if (mods) o.mods = mods;
      if (e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart') {
        const w = window.__atpWatch && window.__atpBox(window.__atpWatch);
        if (w) { const b = w.getBoundingClientRect(); o.rect = [b.left, b.top, b.right, b.bottom].map(r3); }
      }
      if (e.type === 'click' && e.target instanceof HTMLInputElement) o.checkedAtDispatch = e.target.checked;
      window.__atpEv.push(o);
      setTimeout(() => { o.prevented = e.defaultPrevented; }, 0);
    };
    for (const ty of TYPES) window.addEventListener(ty, rec, true);
  })()`;
}

/** A page on one build. ctx: extra newContext options (deviceScaleFactor, hasTouch, isMobile, viewport). */
export async function open(build, ctx = {}) {
  const base = build === 'base';
  const port = base ? BASE_PORT : PORT;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, colorScheme: 'light', ...ctx });
  await context.addInitScript(({ pref }) => { try { localStorage.setItem('mdr.previewEdit', pref); } catch { /* */ } window.open = () => null; }, { pref: '0' });
  await context.addInitScript(recorderSource());
  await context.route((u) => !/^https?:\/\/localhost[:/]/.test(String(u)), (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`http://localhost:${port}/?mode=split${base ? '&perf=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  await sleep(400);
  await page.evaluate(() => { for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none'; });
  const B = { build, base, browser, context, page, errors, async close() { try { await browser.close(); } catch { /* */ } } };
  B.switchState = () => page.evaluate(() => ({
    pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? 'absent',
    stored: (() => { try { return localStorage.getItem('mdr.previewEdit'); } catch { return 'n/a'; } })(),
  }));
  const st = await B.switchState();
  if (base ? st.pressed !== 'absent' : st.pressed !== 'false') throw new Error(`${build}: switch state unexpected ${JSON.stringify(st)}`);
  B.switch = st;
  return B;
}

export async function loadDoc(B, text = DOC) {
  const { page } = B;
  await page.evaluate(({ t }) => window.__mdr.loadText(t, 'atp.md'), { t: text });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(250);
  await page.evaluate(() => {
    const root = document.querySelector('.mdr-preview'); root.scrollTop = 0;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    getSelection().removeAllRanges();
    for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none';
    window.__atpEv.length = 0;
  });
  await page.mouse.move(2, 2);
  await sleep(100);
  if (!B.base) { const st = await B.switchState(); if (st.pressed !== 'false') throw new Error('switch not off after load'); }
}

export const source = (B) => B.page.evaluate(() => window.__mdr.app.getText());
export const idle = async (B, ms = 150) => { await B.page.evaluate(() => window.__mdr.waitIdle()); await sleep(ms); };
/** Checked state of each named box ('alpha', 'beta', 'gamma', 'wrapped', 'raw'). */
export const states = (B) => B.page.evaluate(() => Object.fromEntries(['alpha', 'beta', 'gamma', 'wrapped', 'raw'].map((n) => [n, window.__atpBox(n)?.checked ? 1 : 0])));
export const statesStr = (s) => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(' ');
/** Lines that differ between two sources, as "n:old->new". */
export function srcDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(`${i + 1}:${JSON.stringify(x[i] ?? null)}->${JSON.stringify(y[i] ?? null)}`);
  return out.length ? out.join(', ') : 'unchanged';
}
export const rectOf = (B, name) => B.page.evaluate((n) => { const b = window.__atpBox(n); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }, name);
/** Viewport point inside the text `needle` of the preview (k-th character). */
export const textPoint = (B, needle, k = 2) => B.page.evaluate(({ needle, k }) => {
  const root = document.querySelector('.mdr-preview');
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
}, { needle, k });
export const events = (B) => B.page.evaluate(() => window.__atpEv.slice());
export const clearEvents = (B) => B.page.evaluate(() => { window.__atpEv.length = 0; });
export const watch = (B, name) => B.page.evaluate((n) => { window.__atpWatch = n; }, name);
/** One line per event, compact. */
export function fmtEv(ev, { coords = true } = {}) {
  return ev.map((e) => {
    let s = `${e.type}${e.pt ? '/' + e.pt : ''}${e.trusted ? '' : '(untrusted)'}>${e.target}`;
    if (e.detail !== undefined) s += ` d${e.detail}`;
    if (e.key) s += ` key=${e.key}`;
    if (e.mods) s += ` +${e.mods}`;
    if (coords && e.cx !== undefined) s += ` c(${e.cx},${e.cy})`;
    if (coords && e.sx !== undefined) s += ` s(${e.sx},${e.sy})`;
    if (e.rx !== undefined) s += ` r(${e.rx},${e.ry})`;
    if (e.prevented) s += ' PREVENTED';
    return s;
  }).join(' ; ');
}
/** Did a gesture tick: source lines changed, box states afterwards, the events. */
export async function observe(B, src0, st0) {
  await sleep(250);
  await idle(B, 200);
  const src1 = await source(B);
  const st1 = await states(B);
  const ev = await events(B);
  return { src: srcDiff(src0, src1), states: statesStr(st1), changed: Object.keys(st1).filter((k) => st1[k] !== st0[k]).join(',') || '-', ev, evs: fmtEv(ev) };
}
export function globalTimeout(ms, onTimeout) {
  const t = setTimeout(async () => { console.log(`GLOBAL TIMEOUT after ${ms} ms`); try { await onTimeout?.(); } catch { /* */ } process.exit(3); }, ms);
  t.unref?.();
  return t;
}

// ---- shared with bench/electron/v5-atp-desk.mjs: the grid of Q2 and the hitsBox variants replayed on recorded events
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

