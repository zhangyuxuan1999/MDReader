// bench/verify/v4-sesb-ident.mjs — verify-session-b: H20 / block identity variations. A session types and then
// empties its block (⌘A Backspace) while the worker's answers are late (structure + HTML delayed by `ms`), or the
// editor pane / a document replacement changes the source around the deletion. A sampler records the visible block
// texts every animation frame. After the deletion: the deleted text never shows again, every neighbour shows in
// every frame exactly once, nothing stays dimmed at the end, and the session goes on ('N' typed lands where the
// deleted block stood).
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-ident.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, shownText, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });

async function slowWorker(page, ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__orig) {
      window.__orig = { s: pv.applyStructure.bind(pv), d: pv.applyStructureDelta.bind(pv), h: pv.applyHtml.bind(pv) };
      pv.applyStructure = (m) => { if (window.__delayMs) { setTimeout(() => window.__orig.s(m), window.__delayMs); return true; } return window.__orig.s(m); };
      pv.applyStructureDelta = (m) => { if (window.__delayMs) { setTimeout(() => window.__orig.d(m), window.__delayMs); return true; } return window.__orig.d(m); };
      pv.applyHtml = (m) => { if (window.__delayMs) setTimeout(() => window.__orig.h(m), window.__delayMs); else window.__orig.h(m); };
    }
    window.__delayMs = ms;
  }, ms);
}
const startSampler = (page) => page.evaluate(() => {
  window.__snaps = []; window.__last = null; window.__sampling = true;
  const tick = () => {
    if (!window.__sampling) return;
    const out = [];
    for (const s of document.querySelectorAll('.mdr-preview section.md-block')) {
      const r = s.getBoundingClientRect();
      if (r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
      const t = s.textContent.replace(/\s+/g, ' ').trim();
      if (t) out.push((s.classList.contains('is-stale') ? '~' : '') + t);
    }
    const j = JSON.stringify(out);
    if (window.__last !== j) { window.__last = j; window.__snaps.push(j); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopSampler = (page) => page.evaluate(() => { window.__sampling = false; return window.__snaps.map((x) => JSON.parse(x)); });
async function clickIn(page, needle) {
  const p = await pointOf(page, needle, needle.length - 1, 'right');
  if (!p) throw new Error('not shown ' + needle);
  await page.mouse.click(p.x, p.y); await sleep(350);
  const v = await view(page);
  if (!v.editing) throw new Error('no session on ' + needle);
}
const C = [];
const def = (name, fn) => C.push({ name, fn });
// generic: doc, block to empty (needle), typed before, delay, neighbours that must show in every frame,
// the deleted text, expected source after the deletion and after 'N'
for (const ms of [80, 300, 700]) {
  def(`type-then-empty-mid-${ms}`, () => ({ doc: 'aaa\n\nmid\n\nzzz\n', needle: 'mid', typed: 'X', ms, keep: ['aaa', 'zzz'], gone: 'mid', after: 'aaa\n\nzzz\n', afterN: 'aaa\n\nN\n\nzzz\n' }));
}
def('type2-then-empty-mid-300', () => ({ doc: 'aaa\n\nmid\n\nzzz\n', needle: 'mid', typed: 'XY', ms: 300, keep: ['aaa', 'zzz'], gone: 'mid', after: 'aaa\n\nzzz\n', afterN: 'aaa\n\nN\n\nzzz\n' }));
def('type-then-empty-last-300', () => ({ doc: 'aaa\n\nbbb\n\nlast\n', needle: 'last', typed: 'X', ms: 300, keep: ['aaa', 'bbb'], gone: 'last', after: 'aaa\n\nbbb\n', afterN: 'aaa\n\nbbb\n\nN\n' }));
def('type-then-empty-first-300', () => ({ doc: 'first\n\nbbb\n\nzzz\n', needle: 'first', typed: 'X', ms: 300, keep: ['bbb', 'zzz'], gone: 'first', after: 'bbb\n\nzzz\n', afterN: 'N\n\nbbb\n\nzzz\n' }));
def('type-then-empty-tight-heading-300', () => ({ doc: 'aaa\n# head\n\nzzz\n', needle: 'head', typed: 'X', ms: 300, keep: ['zzz'], gone: 'head', after: null, afterN: null }));
def('type-then-empty-same-next-300', () => ({ doc: 'aaa\n\nsame\n\nsame\n\nzzz\n', needle: 'same', typed: 'X', ms: 300, keep: ['aaa', 'zzz'], gone: 'sameX', after: 'aaa\n\nsame\n\nzzz\n', afterN: 'aaa\n\nN\n\nsame\n\nzzz\n', once: ['same'] }));
def('type-then-empty-item-300', () => ({ doc: 'aaa\n\n- it one\n- it two\n\nzzz\n', needle: 'it two', typed: 'X', ms: 300, keep: ['aaa', 'zzz'], gone: 'it one', after: 'aaa\n\nzzz\n', afterN: 'aaa\n\nN\n\nzzz\n' }));
def('type-then-empty-code-300', () => ({ doc: 'aaa\n\n```\ncode x\n```\n\nzzz\n', needle: 'code x', typed: 'X', ms: 300, keep: ['aaa', 'zzz'], gone: 'code x', after: null, afterN: null }));
def('type-then-empty-editor-above-below-300', () => ({ doc: 'aaa\n\nmid\n\nzzz\n', needle: 'mid', typed: 'X', ms: 300, keep: [], gone: 'mid', after: 'AAA\n\nZZZ\n', afterN: 'AAA\n\nN\n\nZZZ\n',
  then: async (page) => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc; v.dispatch({ changes: [{ from: d.line(1).from, to: d.line(1).to, insert: 'AAA' }, { from: d.line(d.lines - 1).from, to: d.line(d.lines - 1).to, insert: 'ZZZ' }] }); }); } }));

// replace-all in the editor pane right after the deletion (all lines change while the old structures are late)
def('empty-then-replace-all-300', () => ({ doc: 'para one\n\npara mid\n\npara two\n', needle: 'para mid', typed: 'X', ms: 300, keep: [], gone: 'para mid', after: 'PARA one\n\nPARA two\n', afterN: 'PARA one\n\nN\n\nPARA two\n',
  then: async (page) => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = v.state.doc.toString(); v.dispatch({ changes: { from: 0, to: t.length, insert: t.replace(/para/g, 'PARA') } }); }); } }));
// a second block emptied within 50 ms of the first (click into it while the first deletion is on its way)
def('two-emptied-within-50ms-300', () => ({ doc: 'aaa\n\none\n\ntwo\n\nzzz\n', needle: 'one', typed: '', ms: 300, keep: ['aaa', 'zzz'], gone: 'one', after: 'aaa\n\nzzz\n', afterN: null,
  then: async (page) => {
    await sleep(30);
    const p = await pointOf(page, 'two', 2, 'right'); await page.mouse.click(p.x, p.y); await sleep(20);
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
  } }));
// the document is replaced right after the deletion (an open while the deletion's structures are late)
def('empty-then-load-doc-300', () => ({ doc: 'aaa\n\nmid\n\nzzz\n', needle: 'mid', typed: 'X', ms: 300, keep: [], gone: 'mid', after: 'new one\n\nnew two\n', afterN: null,
  then: async (page) => { await sleep(20); await page.evaluate(() => window.__mdr.loadText('new one\n\nnew two\n', 'n.md')); } }));

let bad = 0;
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    const k = c.fn();
    try {
      await slowWorker(page, 0);
      await prepare(A, k.doc);
      await clickIn(page, k.needle);
      await slowWorker(page, k.ms);
      if (k.typed) await page.keyboard.type(k.typed);
      await sleep(40);
      await startSampler(page);
      await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
      await page.evaluate(() => window.__snaps.push('"---"'));
      if (k.then) { await sleep(10); await k.then(page); }
      await sleep(k.ms * 3 + 700);
      const snaps = (await stopSampler(page));
      await slowWorker(page, 0);
      await A.settle(300);
      const src1 = await A.source();
      const sh1 = await shownText(page);
      const v1 = await view(page);
      await page.keyboard.type('N'); await sleep(500); await A.settle(300);
      const src2 = await A.source();
      const sh2 = await shownText(page);
      const v2 = await view(page);
      const after = snaps.slice(snaps.findIndex((x) => x === '---') + 1);
      const showsGone = after.filter((s) => s.some((t) => t.replace(/^~/, '').includes(k.gone)));
      const missing = after.filter((s) => k.keep.some((n) => s.filter((t) => t.replace(/^~/, '') === n).length !== 1));
      const dupOnce = k.once ? after.filter((s) => k.once.some((n) => s.filter((t) => t.replace(/^~/, '') === n).length > 1)) : [];
      const okSrc = (k.after === null || src1 === k.after) && (k.afterN === null || src2 === k.afterN);
      const ok = showsGone.length === 0 && missing.length === 0 && dupOnce.length === 0 && okSrc && v2.stale === 0 && v2.dupIds.length === 0 && src2.includes('N');
      if (!check(c.name, ok, `goneFrames=${showsGone.length} ${J(showsGone.slice(0, 2))} missingFrames=${missing.length} ${J(missing.slice(0, 2))} dup=${dupOnce.length} src1=${J(src1)} src2=${J(src2)} shown=${J(sh2)} stale=${v2.stale} dupIds=${J(v2.dupIds)} ghostSession=${!!v1.editing}`)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    try { await slowWorker(page, 0); await page.evaluate(() => { window.__sampling = false; }); await page.keyboard.press('Escape'); await A.settle(80); } catch { /* */ }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = bad ? 1 : 0;
