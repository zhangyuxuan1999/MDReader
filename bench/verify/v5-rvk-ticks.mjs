// bench/verify/v5-rvk-ticks.mjs — review-ticks (0.2.0, review of the checkpoint-B decisions A1 / B1, switch OFF).
// Measures what U16 as amended a second time (a queue of waiting task ticks) does against 0.1.1:
//   ser10-giant-<gap>, ser3-giant-*: per box, ms from the press to the box showing its tick (latencyMs), ticks written;
//   serN<n>-giant-30, hum15-big300-200, hum12-big200-250: long series; a tick that expires only because others were
//     before it in the same block ("never" in latencyMs, giveup:bound in the trace);
//   same-twice-giant-<gap>: the same box twice while it waits (two toggles, source unchanged; flips4 = what the box showed);
//   tick-then-type-undo-<lag>: two ticks 100 ms apart (the 2nd waits), a click into the editor pane, 'hello' typed,
//     then ONE Cmd-Z in the editor: undo1 is what that Cmd-Z took back (0.1.1: the typing; the queue: the tick);
//   modal-cancel: a tick waits, Meta+O puts the discard question up, Esc (取消): is the tick there (0.1.1: yes);
//   alt-<gap>: ticks of two lists in turn (held).
// The trace fields are filled only by a build that records window.__rvkTrace (the review's patched copy); elsewhere empty.
// Run: MDR_PORT=<candidate dev server> node bench/verify/v5-rvk-ticks.mjs cand <case-prefix ...>
//      MDR_BASE_PORT=<0.1.1 build, vite preview> node bench/verify/v5-rvk-ticks.mjs base <case-prefix ...>
// The switch is stored off ('0') before load. Writes nothing into the tree.
import { chromium } from '@playwright/test';
const target = process.argv[2] || 'cand';
const only = process.argv.slice(3);
const URL = target === 'base' ? `http://localhost:${process.env.MDR_BASE_PORT || 5524}/?perf=1&mode=split` : `http://localhost:${process.env.MDR_PORT || 5523}/?mode=split`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const NOT_TICKED = '没有勾选：该任务项刚被改动，请再点一次';
const giant = (n) => 'Intro\n\n' + Array.from({ length: n }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n';
const GIANT = giant(100);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
const page = await context.newPage();
page.on('dialog', (d) => d.dismiss().catch(() => {}));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
async function boot() {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await page.evaluate(() => { try { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await sleep(500);
}
async function load(doc) {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await page.evaluate((t) => window.__mdr.loadText(t, 'v.md'), doc);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  const s = await src();
  if (s !== doc) throw new Error('load mismatch');
}
const src = () => page.evaluate(() => window.__mdr.app.getText());
async function track(n) {
  await page.evaluate((n) => {
    window.__rvkTrace = [];
    const W = window.__rvk = { downs: {}, first: {}, flips: {}, toasts: [], stop: false };
    const boxes = () => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]'));
    const last = {};
    document.addEventListener('pointerdown', (e) => { const k = boxes().indexOf(e.target); if (k >= 0) (W.downs[k] ??= []).push(performance.now()); }, true);
    const loop = () => {
      const bs = boxes();
      for (let k = 0; k < n && k < bs.length; k++) {
        const c = bs[k].checked;
        if (last[k] !== undefined && c !== last[k]) (W.flips[k] ??= []).push(`${c ? 'on' : 'off'}@${Math.round(performance.now())}`);
        if (c && W.first[k] === undefined) W.first[k] = performance.now();
        last[k] = c;
      }
      if (!W.stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new MutationObserver((ms) => { for (const m of ms) for (const nd of m.addedNodes) { if (nd.nodeType !== 1) continue; const t = nd.matches?.('.mdr-toast') ? nd : nd.querySelector?.('.mdr-toast'); if (t) W.toasts.push(`${t.textContent}@${Math.round(performance.now())}`); } })
      .observe(document.body, { childList: true, subtree: true });
  }, n);
}
const readTrack = () => page.evaluate(() => { window.__rvk.stop = true; return { ...window.__rvk, trace: window.__rvkTrace }; });
async function boxPoint(k) {
  return page.evaluate((k) => {
    const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k];
    if (!b) return null;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, k);
}
async function clickBox(k) { const p = await boxPoint(k); await page.mouse.click(p.x, p.y); }
const ticked = (s) => (s.match(/^- \[x\] task(\d+)/gm) || []).map((x) => Number(x.replace(/\D+/g, '')));
async function editorClickEnd(needle) {
  const p = await page.evaluate((needle) => {
    const v = window.__mdr.app.editor.view;
    const at = v.state.doc.toString().indexOf(needle) + needle.length;
    const c = v.coordsAtPos(at);
    return c ? { x: c.left + 1, y: (c.top + c.bottom) / 2 } : null;
  }, needle);
  await page.mouse.click(p.x, p.y);
}
const results = [];
function report(name, obj) { results.push({ name, ...obj }); console.log(name, J(obj)); }

async function series(name, doc, first, count, gap, settleMs = Math.max(4000, count * 750 + 2500)) {
  await load(doc);
  await track(first + count + 1);
  const t0 = Date.now();
  for (let i = 0; i < count; i++) { await clickBox(first + i); if (i < count - 1) await sleep(gap); }
  const clickSpan = Date.now() - t0;
  await sleep(settleMs);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  const tr = await readTrack();
  const s = await src();
  const lat = [];
  for (let i = 0; i < count; i++) {
    const k = first + i; const d = tr.downs[k]?.[0]; const f = tr.first[k];
    lat.push(d === undefined ? 'nodown' : f === undefined ? 'never' : Math.round(f - d));
  }
  const flipsBack = Object.entries(tr.flips).filter(([, v]) => v.some((x) => x.startsWith('off'))).map(([k, v]) => `${k}:${v.join(',')}`);
  report(name, { target, gap, clickSpan, ticked: ticked(s), want: Array.from({ length: count }, (_, i) => first + i), latencyMs: lat, toasts: tr.toasts, flipsBack, trace: (tr.trace || []).slice(0, 60) });
}

const cases = [];
for (const gap of [30, 60, 100, 200]) cases.push([`ser10-giant-${gap}`, () => series(`ser10-giant-${gap}`, GIANT, 3, 10, gap)]);
cases.push(['ser3-giant-150', () => series('ser3-giant-150', GIANT, 3, 3, 150)]);
cases.push(['ser3-giant-200', () => series('ser3-giant-200', GIANT, 3, 3, 200)]);
for (const n of [200, 300]) cases.push([`ser10-big${n}-100`, () => series(`ser10-big${n}-100`, giant(n), 3, 10, 100, 14000)]);
for (const c of [16, 20, 25]) cases.push([`serN${c}-giant-30`, () => series(`serN${c}-giant-30`, GIANT, 3, c, 30, 14000)]);
cases.push(['hum15-big300-200', () => series('hum15-big300-200', giant(300), 3, 15, 200, 16000)]);
cases.push(['hum12-big200-250', () => series('hum12-big200-250', giant(200), 3, 12, 250, 14000)]);
cases.push(['ser20-big300-60', () => series('ser20-big300-60', giant(300), 3, 20, 60, 14000)]);
for (const gap of [60, 200]) {
  cases.push([`same-twice-giant-${gap}`, async () => {
    await load(GIANT); await track(10);
    await clickBox(3); await sleep(150); await clickBox(4); await sleep(gap); await clickBox(4);
    await sleep(3000); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
    const tr = await readTrack(); const s = await src();
    report(`same-twice-giant-${gap}`, { target, ticked: ticked(s), want: [3], toasts: tr.toasts, flips4: tr.flips[4], trace: tr.trace });
  }]);
}
// a tick that waits, then at once a click into the editor pane and five typed characters, then ONE Cmd-Z in the editor
for (const lag of [0, 120]) {
  cases.push([`tick-then-type-undo-${lag}`, async () => {
    await load(GIANT); await track(10);
    await clickBox(3); await sleep(100); await clickBox(4); await sleep(lag);
    await editorClickEnd('Intro');
    const tType = Date.now();
    for (const ch of 'hello') { await page.keyboard.type(ch); await sleep(60); }
    const typeSpan = Date.now() - tType;
    await sleep(2500); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
    const s1 = await src();
    const focusEditor = await page.evaluate(() => window.__mdr.app.editor.view.hasFocus);
    await page.keyboard.press('Meta+z'); await sleep(400);
    const s2 = await src();
    await page.keyboard.press('Meta+z'); await sleep(400);
    const s3 = await src();
    const tr = await readTrack();
    const tail = (s) => s.slice(0, s.indexOf('\n'));
    report(`tick-then-type-undo-${lag}`, { target, typeSpan, after: { ticked: ticked(s1), tail: tail(s1) }, focusEditor, undo1: { ticked: ticked(s2), tail: tail(s2) }, undo2: { ticked: ticked(s3), tail: tail(s3) }, toasts: tr.toasts, trace: tr.trace });
  }]);
}
try {
  await boot();
  for (const [name, fn] of cases) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try { await fn(); } catch (err) { report(name, { error: String(err && err.message) }); }
  }
} finally {
  if (errs.length) console.log('pageerrors', J(errs.slice(0, 5)));
  await browser.close();
}
// a tick waits, then the discard question (Meta+o on a dirty document) is up when its block re-renders; then 取消
if (only.includes('modal-cancel')) {
  const b2 = await chromium.launch({ headless: true });
  const pg = await (await b2.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(URL, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await pg.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await sleep(500);
  for (const gap of [150, 300]) {
    await pg.evaluate((t) => window.__mdr.loadText(t, 'v.md'), GIANT); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(800);
    await pg.evaluate(() => { window.__rvkTrace = []; window.__ev = []; const bus = window.__mdr.app.bus; if (!window.__hooked && bus?.on) { window.__hooked = true; bus.on('toast', (e) => window.__ev.push('toast:' + e.text + '@' + Math.round(performance.now()))); } });
    const pt = async (k) => pg.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
    let p = await pt(3); await pg.mouse.click(p.x, p.y); await sleep(gap);
    p = await pt(4); await pg.mouse.click(p.x, p.y); await sleep(30);
    await pg.keyboard.press('Meta+o');
    await sleep(1500);
    const modal = await pg.evaluate(() => !!document.querySelector('[aria-modal="true"]'));
    await pg.keyboard.press('Escape'); await sleep(300);
    const modalAfter = await pg.evaluate(() => !!document.querySelector('[aria-modal="true"]'));
    await sleep(1500);
    const out = await pg.evaluate(() => ({ src: window.__mdr.app.getText(), trace: window.__rvkTrace, ev: window.__ev }));
    console.log('modal-cancel', target, gap, J({ modal, modalAfter, ticked: ticked(out.src), trace: out.trace, ev: out.ev }));
  }
  await b2.close();
}
// two lists in turn: a giant list C (slow re-render) and a small list A below the intro; alternate clicks
if (only.some((o) => o.startsWith('alt'))) {
  const gap = Number((only.find((o) => o.startsWith('alt')) || 'alt-120').split('-')[1] || 120);
  const b2 = await chromium.launch({ headless: true });
  const pg = await (await b2.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(URL, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await pg.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await sleep(500);
  const small = Array.from({ length: 12 }, (_, i) => `- [ ] small${i}`).join('\n');
  const DOC = 'Intro\n\n' + small + '\n\n' + GIANT.slice('Intro\n\n'.length);
  for (let run = 0; run < 4; run++) {
    await pg.evaluate((t) => window.__mdr.loadText(t, 'v.md'), DOC); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(800);
    await pg.evaluate(() => { window.__rvkTrace = []; window.__ev = []; const bus = window.__mdr.app.bus; if (!window.__hooked && bus?.on) { window.__hooked = true; bus.on('toast', (e) => window.__ev.push('toast@' + Math.round(performance.now()))); } });
    const pt = async (k) => pg.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
    // small list boxes 0..11, giant list boxes 12.. ; alternate giant k, small k
    for (let k = 0; k < 8; k++) {
      let p = await pt(12 + k); await pg.mouse.click(p.x, p.y); await sleep(gap);
      p = await pt(k); await pg.mouse.click(p.x, p.y); await sleep(gap);
    }
    await sleep(9000); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
    const out = await pg.evaluate(() => ({ src: window.__mdr.app.getText(), trace: window.__rvkTrace, ev: window.__ev }));
    const tg = (out.src.match(/^- \[x\] task(\d+)/gm) || []).length, ts = (out.src.match(/^- \[x\] small(\d+)/gm) || []).length;
    console.log('alt', target, gap, run, J({ giantTicked: tg, smallTicked: ts, want: '8+8', toasts: out.ev.length, waits: (out.trace || []).filter((x) => x.startsWith('wait')).length, replays: (out.trace || []).filter((x) => x.startsWith('replay')).length, giveups: (out.trace || []).filter((x) => x.startsWith('giveup')) }));
  }
  await b2.close();
}
// focusline: two ticks 150 ms apart (the 2nd waits), then a click on the text of the first paragraph 60 ms later;
// after the replay: the preview's focus line and the editor's peer line (0.1.1: both on the paragraph)
if (only.includes('focusline')) {
  const b2 = await chromium.launch({ headless: true });
  const pg = await (await b2.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await pg.goto(URL, { waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await pg.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 }); await sleep(500);
  const DOC = 'Intro paragraph here' + GIANT.slice('Intro'.length);
  for (let run = 0; run < 3; run++) {
    await pg.evaluate((t) => window.__mdr.loadText(t, 'v.md'), DOC); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(800);
    const pt = async (k) => pg.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
    let p = await pt(3); await pg.mouse.click(p.x, p.y); await sleep(150);
    p = await pt(4); await pg.mouse.click(p.x, p.y); await sleep(60);
    const q = await pg.evaluate(() => { const e = Array.from(document.querySelectorAll('.mdr-preview p')).find((x) => x.textContent.includes('Intro paragraph')); const r = e.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; });
    await pg.mouse.click(q.x, q.y);
    await sleep(2500);
    const out = await pg.evaluate(() => ({ previewFocus: document.querySelector('.mdr-preview .is-focus')?.textContent.slice(0, 20), editorPeer: document.querySelector('.cm-peerLine')?.textContent.slice(0, 20), task4Ticked: /- \[x\] task4 /.test(window.__mdr.app.getText()) }));
    console.log('focusline', target, run, J(out));
  }
  await b2.close();
}
// leave-edit / leave-scroll: seven boxes of the giant list 200 ms apart, then at once editor-only mode (__mdr.mode('edit'))
// or the preview scrolled to the bottom of a long document; 12 s later: how many ticks were written (0.1.1: 7 of 7)
if (only.some((o) => o === 'leave-edit' || o === 'leave-scroll')) {
  const b2 = await chromium.launch({ headless: true });
  const ctx = await b2.newContext({ viewport: { width: 1400, height: 900 } });
  const pg = await ctx.newPage();
  await pg.goto(URL, { waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await pg.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 }); await sleep(500);
  const TAIL = Array.from({ length: 600 }, (_, i) => `\nParagraph ${i} with some words to make it a line of text.\n`).join('');
  for (const how of ['leave-edit', 'leave-scroll'].filter((h) => only.includes(h))) {
    await pg.evaluate(() => window.__mdr.mode('split')); await sleep(300);
    await pg.evaluate(() => { const el = document.querySelector('.mdr-preview'); if (el) el.scrollTop = 0; });
    await pg.evaluate((t) => window.__mdr.loadText(t, 'v.md'), how === 'leave-scroll' ? GIANT + TAIL : GIANT); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(900);
    await pg.evaluate(() => { window.__rvkTrace = []; window.__ev = []; const bus = window.__mdr.app.bus; if (!window.__hooked2 && bus?.on) { window.__hooked2 = true; bus.on('toast', () => window.__ev.push('toast@' + Math.round(performance.now()))); } });
    const pt = async (k) => pg.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
    for (let k = 3; k < 10; k++) { const p = await pt(k); await pg.mouse.click(p.x, p.y); await sleep(200); }
    if (how === 'leave-edit') await pg.evaluate(() => window.__mdr.mode('edit'));
    else await pg.evaluate(() => { const el = document.querySelector('.mdr-preview'); el.scrollTop = el.scrollHeight; });
    await sleep(12000);
    const out = await pg.evaluate(() => ({ src: window.__mdr.app.getText(), trace: window.__rvkTrace, ev: window.__ev }));
    console.log(how, target, J({ ticked: ticked(out.src), want: [3, 4, 5, 6, 7, 8, 9], trace: out.trace, toasts: out.ev }));
  }
  await b2.close();
}
// dups-above / dups-own: five tasks with the same text ('- [ ] same', the 2nd of them clicked while the list re-renders
// after a tick of task3), then the editor pane deletes task5's line (above) or the clicked task's own line;
// sameRows shows which 'same' got ticked (0.1.1: above -> the 2nd one, own -> none)
if (only.some((o) => o === 'dups-above' || o === 'dups-own')) {
  const b2 = await chromium.launch({ headless: true });
  const pg = await (await b2.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await pg.goto(URL, { waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 });
  await pg.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForFunction(() => !!window.__mdr, null, { timeout: 90000 }); await sleep(500);
  const rows = Array.from({ length: 100 }, (_, i) => (i >= 10 && i < 15 ? '- [ ] same' : `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`));
  const DOC = 'Intro\n\n' + rows.join('\n') + '\n\nend\n';
  for (const variant of ['above', 'own'].filter((v) => only.includes('dups-' + v))) {
    for (let run = 0; run < 2; run++) {
      await pg.evaluate((t) => window.__mdr.loadText(t, 'v.md'), DOC); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(900);
      await pg.evaluate(() => { window.__rvkTrace = []; });
      const pt = async (k) => pg.evaluate((k) => { const r = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, k);
      let p = await pt(3); await pg.mouse.click(p.x, p.y); await sleep(150);
      p = await pt(11); await pg.mouse.click(p.x, p.y); await sleep(60);
      await pg.evaluate((variant) => {
        const v = window.__mdr.app.editor.view; const d = v.state.doc;
        const ln = variant === 'above' ? d.line(3 + 5) : d.line(3 + 11);
        v.dispatch({ changes: { from: ln.from, to: ln.to + 1 }, userEvent: 'delete' });
      }, variant);
      await sleep(3000); await pg.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
      const out = await pg.evaluate(() => ({ src: window.__mdr.app.getText(), trace: window.__rvkTrace }));
      const sameRows = out.src.split('\n').map((l, i) => [l, i]).filter(([l]) => /same$/.test(l)).map(([l, i]) => `${l.slice(0, 5)}@${i + 1}`);
      console.log('dups-' + variant, target, run, J({ sameRows, trace: out.trace }));
    }
  }
  await b2.close();
}
