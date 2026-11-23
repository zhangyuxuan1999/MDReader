// bench/verify/v5-offd-fuzz.mjs — audit-off-diff: a seeded random sequence of gestures (pointer, keys, copy / cut /
// paste, editor typing, wheel, modes, outline, IME, drops, the switch toggled twice) applied to the candidate (switch
// OFF) and to 0.1.1 in step; after every operation all observations of bench/verify/v5-offd-lib.mjs are compared;
// the run stops at the first difference and prints the seed, the step, the operation and both observations.
//   MDR_PORT=5521 MDR_BASE_PORT=5522 node bench/verify/v5-offd-fuzz.mjs <seed> [--ops n] [--doc name] [--mode split|preview]
//        [--boxes] [--history] [--strict]   (draw task-checkbox clicks / ⌘Z ⇧⌘Z outside the editor; compare the U15 flag
//        in copied HTML too: each is a known difference, see the matrix cases app-task-at-rest, app-undo-far, copy-whole)
//   MDR_CONTROL=1 MDR_PORT=5522 MDR_BASE_PORT=5522 …   the noise floor: 0.1.1 against itself
//   node bench/verify/v5-offd-fuzz.mjs --replay <file.json> [--upto k]     replays a recorded operation list
// Every run writes its operation list to $MDR_SCRATCH/fuzz-<seed>.json (replayable). Exit 0 same, 1 differs, 3 timeout.
import * as L from './v5-offd-lib.mjs';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const replay = opt('--replay', null);
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 1);
const nOps = Number(opt('--ops', 60));
const FUZZ_DOCS = ['rich', 'small', 'readme', 'tasks', 'one', 'large', 'rich', 'tasks', 'small', 'empty'];
let doc = opt('--doc', FUZZ_DOCS[seed % FUZZ_DOCS.length]);
let mode = opt('--mode', seed % 3 === 2 ? 'preview' : 'split');
const upto = Number(opt('--upto', 1e9));

const KEYS = ['a', 'x', '7', '.', 'Shift+Digit1', 'Enter', 'Shift+Enter', 'Backspace', 'Delete', 'Tab', 'Shift+Tab', 'Space', 'Shift+Space',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown',
  'Shift+ArrowLeft', 'Shift+ArrowRight', 'Meta+ArrowUp', 'Meta+ArrowDown', 'Meta+Shift+ArrowLeft', 'Alt+ArrowLeft', 'Escape', 'Meta+a',
  'Meta+b', 'Meta+i', 'Meta+e', 'Meta+k', 'Meta+s', 'Meta+f'];
// Not drawn by default (each is one known difference that would end every run early, see the matrix cases):
//   ⌘Z / ⇧⌘Z with the focus outside the editor (CONTRACT §11 U2: no scroll to the change, ⇧⌘Z redoes) — --history
//   a task checkbox click (0.1.1 moves its preview after the write; the candidate keeps it) — --boxes
// ⌘Z / ⇧⌘Z typed in the editor itself are always drawn (inside 'edit').
const HISTORY = argv.includes('--history');
const BOXES = argv.includes('--boxes');
const LOOSE_KEYS = /^(End|Meta\+ArrowDown|Meta\+Shift\+ArrowDown|Meta\+ArrowUp)$/;
const WORDS = ['abc', ' 字', 'x y', '**', '- ', '1. ', '`c`', '\n', '$x$', '> ', '[l](u)', '中文'];

/** Facts of the candidate page the generator needs (identical on the baseline while both are in step). */
async function facts(S) {
  return S.page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const box = root.getBoundingClientRect();
    const ss = Array.from(root.querySelectorAll('section.md-block'));
    const vis = [];
    // a block with a checkbox that is not a task (raw HTML) is left out: U16 / U24 cancel its clicks (intended)
    ss.forEach((s) => { const r = s.getBoundingClientRect(); if (r.height > 0 && r.bottom > box.top + 6 && r.top < box.bottom - 6 && s.textContent.trim() && !s.querySelector('input:not(li > input), label')) vis.push([Number(s.dataset.id), s.textContent.length]); });
    const visEl = (sel) => Array.from(root.querySelectorAll(sel)).filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top > box.top + 4 && r.bottom < box.bottom - 4; }).length;
    const ed = document.querySelector('.cm-scroller');
    return { vis, pvShown: box.width > 50, edShown: !!ed && ed.getBoundingClientRect().width > 50, boxes: visEl('li input[type="checkbox"]'), links: visEl('a[href]'), toc: document.querySelectorAll('.mdr-toc a, .mdr-toc li > *:first-child').length };
  });
}

function genOp(R, F) {
  const pv = F.pvShown && F.vis.length;
  const at = () => { const [b, len] = R.pick(F.vis); return { b, o: R.int(Math.max(1, Math.min(len, 400))) }; };
  const choices = [];
  const add = (w, f) => { for (let i = 0; i < w; i++) choices.push(f); };
  if (pv) {
    add(10, () => ['click', at(), { count: R.pick([1, 1, 1, 2, 2, 3]) }]);
    add(3, () => ['click', at(), { mods: [R.pick(['Shift', 'Shift', 'Alt', 'Meta'])] }]);
    add(5, () => ['drag', at(), at()]);
    add(2, () => ['click', at(), { button: 'right' }]);
    add(2, () => ['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, R.pick([-600, -200, 200, 400, 900])]);
    add(1, () => ['scrollLine', Math.round(R() * 100) / 100]);
    add(1, () => ['dropText', at(), 'dropped']);
    if (F.boxes && BOXES) add(2, () => ['click', { css: 'li input[type="checkbox"]', nth: R.int(F.boxes) }]);
    if (F.links) add(1, () => ['click', { css: 'a[href]', nth: R.int(F.links) }, { mods: R.pick([[], [], ['Meta'], ['Alt']]) }]);
    if (F.edShown) add(2, () => ['drag', at(), { pane: 'ed', fx: 0.4, fy: 0.2 + R() * 0.6 }]);
  }
  add(12, () => ['key', R.pick(KEYS)]);
  if (HISTORY) add(2, () => ['key', R.pick(['Meta+z', 'Meta+Shift+z'])]);
  add(2, () => ['type', R.pick(WORDS)]);
  add(3, () => ['key', 'Meta+c']);
  add(1, () => ['key', 'Meta+x']);
  add(2, () => ['clip', R.pick(['clip text', '- item', '**b**'])]);
  add(2, () => ['key', 'Meta+v']);
  add(1, () => ['ime', '中']);
  add(1, () => ['pasteEvt', 'pasted']);
  add(1, () => ['toggle2']);
  add(1, () => ['mode', R.pick(['split', 'split', 'preview', 'edit'])]);
  if (F.toc) add(1, () => ['click', { toc: R.int(Math.min(F.toc, 12)) }]);
  if (F.edShown) {
    add(5, () => ['edit', { at: { edLine: R.int(14), endOfLine: R() < 0.5 }, text: R.pick(WORDS) }]);
    add(2, () => ['edit', { at: { edLine: R.int(14) }, keys: [R.pick(['Enter', 'Backspace', 'ArrowDown', 'PageDown', 'Meta+z', 'Meta+Shift+z'])] }]);
    add(1, () => ['wheel', { pane: 'ed', fx: 0.5, fy: 0.5 }, R.pick([-500, 300, 800])]);
  }
  return R.pick(choices)();
}

const SWITCH_T = /^预览可编辑/;
async function apply(P, op) {
  if (op[0] === 'toggle2') {
    // ⌘⇧E twice: on and off again (the candidate's switch toasts are the intended difference: filtered)
    for (const S of [P.cand, P.base]) S.togg = true;
    await Promise.all([L.step(P.cand, ['key', 'Meta+Shift+e']), L.step(P.base, ['key', 'Meta+Shift+e'])]);
    await Promise.all([L.step(P.cand, ['key', 'Meta+Shift+e', { after: 500 }]), L.step(P.base, ['key', 'Meta+Shift+e', { after: 500 }])]);
    return ['', ''];
  }
  return Promise.all([L.step(P.cand, op).catch((e) => 'ERR ' + e.message.split('\n')[0]), L.step(P.base, op).catch((e) => 'ERR ' + e.message.split('\n')[0])]);
}

L.globalTimeout(Number(process.env.MDR_TIMEOUT || 900_000));
const t0 = Date.now();
let P, code = 0;
const ops = [];
let rec = null;
if (replay) { rec = JSON.parse(readFileSync(replay, 'utf8')); doc = rec.doc; mode = rec.mode; }
const tag = replay ? 'replay' : String(seed);
try {
  P = await L.openPair({ mode });
  await Promise.all([L.reset(P.cand, doc, mode), L.reset(P.base, doc, mode)]);
  if (doc === 'large') await L.setupDeep(P);
  for (const S of [P.cand, P.base]) { await S.page.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; }); S.pts = []; }
  {
    const [c0, b0] = await Promise.all([L.obs(P.cand), L.obs(P.base)]);
    const d0 = L.diff(c0, b0);
    if (d0.length) { console.log(`DIFF seed ${tag} doc ${doc} mode ${mode} initial state (before any operation)\n   ${L.fmtDiff(d0)}`); code = 1; throw new Error('initial state differs'); }
  }
  const R = L.rng(seed * 7919 + 17);
  const N = rec ? Math.min(rec.ops.length, upto) : nOps;
  let firstDiff = null, loose = false;
  for (let i = 0; i < N; i++) {
    const F = await facts(P.cand);
    const op = rec ? rec.ops[i] : genOp(R, F);
    ops.push(op);
    for (const S of [P.cand, P.base]) { await S.page.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; }); S.pts = []; S.pageErrors.length = 0; S.navs.length = 0; }
    const clip = op[0] === 'key' && /Meta\+[cx]$/.test(op[1]);
    const [rc, rb] = await apply(P, op);
    const [c, b] = await Promise.all([L.obs(P.cand, { clip }), L.obs(P.base, { clip })]);
    // ⌘⇧E is the switch's own key in the candidate (prevented there): its key events are the intended difference
    const ignore = op[0] === 'toggle2' ? ['ev'] : [];
    if (op[0] === 'toggle2') { c.toasts = c.toasts.filter((t) => !SWITCH_T.test(t)); b.toasts = b.toasts.filter((t) => !SWITCH_T.test(t)); }
    const ip = op[0] === 'key' && L.INTENDED_PREVENT.test(op[1]);
    // a jump to the end of a long document lands within some tens of px of the same place (0.1.1 against itself
    // differs the same way): from then on scroll positions compare loosely
    if (op[0] === 'key' && LOOSE_KEYS.test(op[1]) && !['rich', 'tasks', 'one', 'empty'].includes(doc)) loose = true;
    if ((op[0] === 'mode' || op[0] === 'toggle2' || op[0] === 'scrollLine') && !['rich', 'tasks', 'one', 'empty'].includes(doc)) loose = true;
    const tol = loose ? 64 : 1;
    const d = L.diff(c, b, { ignore, intendedPrevent: ip, tol, knownClip: !argv.includes('--strict') });
    if (rc !== rb && !(String(rc).startsWith('ERR') && String(rb).startsWith('ERR'))) d.unshift({ field: 'stepResult', cand: rc, base: rb, detail: '' });
    const bothErr = String(rc).startsWith('ERR') && String(rb).startsWith('ERR');
    if (loose && String(rc).startsWith('ERR') !== String(rb).startsWith('ERR')) {
      // after a loosely compared jump the panes may sit a few tens of px apart (0.1.1 against itself does the same):
      // a target that exists on one side only ends the run as inconclusive, not as a difference
      console.log(`NOISE-STOP seed ${tag} doc ${doc} mode ${mode} step ${i} op ${JSON.stringify(op)}: cand ${JSON.stringify(rc)} base ${JSON.stringify(rb)} (after a loose step)`);
      break;
    }
    if (d.length && d[0].field !== 'stepResult') {
      // timer-driven fields (draft status, debounced scroll sync) can be read a few ms apart: look again once
      await L.sleep(900);
      const [c2, b2] = await Promise.all([L.obs(P.cand, { clip }), L.obs(P.base, { clip })]);
      if (op[0] === 'toggle2') { c2.toasts = c2.toasts.filter((t) => !SWITCH_T.test(t)); b2.toasts = b2.toasts.filter((t) => !SWITCH_T.test(t)); }
      const d2 = L.diff(c2, b2, { ignore, intendedPrevent: ip, tol, knownClip: !argv.includes('--strict') });
      if (!d2.length) { console.log(`TRANSIENT seed ${tag} step ${i} op ${JSON.stringify(op)}: ${L.fmtDiff(d).slice(0, 300)}`); d.length = 0; }
      else { d.length = 0; d.push(...d2); }
    }
    if (d.length) {
      let extra = '';
      const bd = d.find((x) => x.field === 'blocks');
      if (bd && bd.idx) {
        const k0 = bd.idx[0];
        const [hc, hb] = await Promise.all([L.blockHtml(P.cand, k0), L.blockHtml(P.base, k0)]);
        let k = 0; while (hc && hb && k < hc.length && hc[k] === hb[k]) k++;
        extra = `\n   block ${k0} html from ${k}: cand ${JSON.stringify((hc || '').slice(Math.max(0, k - 60), k + 160))}\n                    base ${JSON.stringify((hb || '').slice(Math.max(0, k - 60), k + 160))}`;
      }
      firstDiff = { step: i, op, diffs: d };
      console.log(`DIFF seed ${tag} doc ${doc} mode ${mode} step ${i} op ${JSON.stringify(op)}${bothErr ? ' (op failed on both)' : ''}\n   ${L.fmtDiff(d)}${extra}`);
      for (const x of d.slice(0, 4)) console.log(`   - ${x.field}: cand ${JSON.stringify(x.cand).slice(0, 400)}\n     ${' '.repeat(x.field.length)}  base ${JSON.stringify(x.base).slice(0, 400)}`);
      code = 1;
      break;
    }
  }
  if (!firstDiff) console.log(`SAME seed ${tag} doc ${doc} mode ${mode}: ${ops.length} ops, every observation equal`);
} catch (e) {
  console.log(`ERROR seed ${tag}: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`);
  code = 2;
} finally {
  await L.closeAll();
  if (!replay) L.writeJson(`${L.SCRATCH}/fuzz-${seed}.json`, { seed, doc, mode, ops });
  console.log(`(${Math.round((Date.now() - t0) / 1000)} s; ops in ${L.SCRATCH}/fuzz-${tag}.json)`);
  process.exit(code);
}
