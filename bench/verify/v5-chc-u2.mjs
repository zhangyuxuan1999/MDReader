// bench/verify/v5-chc-u2.mjs — challenge-c: variations of U2 as amended (fix-session-e B2, narrowed by fix-session-f A2):
// ⌘Z / ⇧⌘Z pressed outside the editor with the switch OFF, candidate against 0.1.1, every observation of
// v5-offd-lib.mjs compared except the event log `ev` (0.1.1 reaches CodeMirror through beforeinput, the candidate through
// the keydown: RVS-4). Extra step ops: ['blur'] (nothing focused), ['tool'] (a click on the toolbar's TOC button).
// Run: MDR_PORT=5487 MDR_BASE_PORT=5497 MDR_SCRATCH=<dir> node bench/verify/v5-chc-u2.mjs [case-prefix ...]
// Global timeout 25 min. Writes only into MDR_SCRATCH.
import * as L from './v5-offd-lib.mjs';

const only = process.argv.slice(2);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 25 * 60 * 1000);
const text = { inCss: 'p', o: 3 };
const task = { css: 'li input[type="checkbox"]' };
const ed2 = { edLine: 2, endOfLine: true };
const ed3 = { edLine: 3, endOfLine: true };
const CASES = [
  ['far-then-near', 'large', 'split', [['edit', { at: ed2, text: ' A1' }], ['scrollEd', 0.9], ['edit', { at: ed3, text: ' B2' }], ['scrollEd', 0], ['scrollPv', 0], ['click', text], ['key', 'Meta+z'], ['key', 'Meta+z']]],
  ['ten-presses', 'rich', 'split', [['edit', { at: ed2, text: ' a' }], ['edit', { at: ed3, text: ' b' }], ['click', text], ...Array.from({ length: 10 }, () => ['key', 'Meta+z'])]],
  ['ten-redo', 'rich', 'split', [['edit', { at: ed2, text: ' a' }], ['key', 'Meta+z'], ['click', text], ...Array.from({ length: 4 }, () => ['key', 'Meta+Shift+z'])]],
  ['nothing-then-tick-type', 'tasks', 'split', [['click', text], ['key', 'Meta+z'], ['click', task], ['wait', 300], ['edit', { at: ed2, text: ' t' }]]],
  ['nothing-then-tick-far', 'large', 'split', [['click', text], ['key', 'Meta+z'], ['scrollEd', 0.5], ['edit', { at: ed3, text: ' t' }]]],
  ['preview-mode-far', 'large', 'split', [['scrollEd', 0.9], ['edit', { at: ed3, text: ' F' }], ['mode', 'preview'], ['scrollPv', 0], ['click', text], ['key', 'Meta+z']]],
  ['preview-mode-redo', 'large', 'split', [['scrollEd', 0.9], ['edit', { at: ed3, text: ' F' }], ['key', 'Meta+z'], ['mode', 'preview'], ['scrollPv', 0], ['click', text], ['key', 'Meta+Shift+z']]],
  ['toolbar-far', 'large', 'split', [['scrollEd', 0.7], ['edit', { at: ed3, text: ' T' }], ['scrollEd', 0], ['scrollPv', 0], ['tool'], ['key', 'Meta+z']]],
  ['toc-far', 'large', 'split', [['scrollEd', 0.7], ['edit', { at: ed3, text: ' T' }], ['click', { toc: 2 }], ['key', 'Meta+z']]],
  ['nowhere-far', 'large', 'split', [['scrollEd', 0.7], ['edit', { at: ed3, text: ' N' }], ['scrollEd', 0], ['scrollPv', 0], ['blur'], ['key', 'Meta+z']]],
  ['nowhere-near', 'rich', 'split', [['edit', { at: ed2, text: ' N' }], ['blur'], ['key', 'Meta+z'], ['key', 'Meta+Shift+z']]],
  ['edit-mode-nowhere', 'rich', 'edit', [['edit', { at: ed2, text: ' E' }], ['blur'], ['key', 'Meta+z']]],
  ['paste-far', 'large', 'split', [['clip', 'p1\np2\np3\n'], ['scrollEd', 0.6], ['edit', { at: ed3, keys: ['Meta+v'] }], ['scrollEd', 0], ['scrollPv', 0], ['click', text], ['key', 'Meta+z']]],
  ['undo-then-type', 'rich', 'split', [['edit', { at: ed2, text: ' u' }], ['click', text], ['key', 'Meta+z'], ['edit', { at: ed3, text: ' v' }], ['key', 'Meta+z']]],
  ['tick-then-undo-edit', 'tasks', 'split', [['edit', { at: ed2, text: ' w' }], ['click', task], ['wait', 300], ['key', 'Meta+z']]],
  ['undo-redo-alternate', 'rich', 'split', [['edit', { at: ed2, text: ' a' }], ['click', text], ['key', 'Meta+z'], ['key', 'Meta+Shift+z'], ['key', 'Meta+z'], ['key', 'Meta+Shift+z']]],
];

async function stepBoth(P, st) {
  if (st[0] === 'blur') {
    await Promise.all([P.cand, P.base].map((S) => S.page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body) a.blur(); getSelection().removeAllRanges(); })));
    await Promise.all([L.settle(P.cand, 200), L.settle(P.base, 200)]);
    return ['', ''];
  }
  if (st[0] === 'tool') {
    const r = await Promise.all([P.cand, P.base].map(async (S) => {
      const q = await S.page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-toolbar button')).find((x) => /目录|大纲|TOC/i.test((x.title || '') + (x.getAttribute('aria-label') || ''))) || document.querySelector('.mdr-toolbar button'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: b.title || b.getAttribute('aria-label') }; });
      await S.page.mouse.click(q.x, q.y); await L.settle(S, 400); return q.t;
    }));
    return r;
  }
  return Promise.all([L.step(P.cand, st).catch((e) => 'ERR ' + e.message), L.step(P.base, st).catch((e) => 'ERR ' + e.message)]);
}

const P = await L.openPair();
const out = [];
try {
  for (const [name, doc, mode, steps] of CASES) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try {
      await Promise.all([L.reset(P.cand, doc, mode, { fresh: true }), L.reset(P.base, doc, mode, { fresh: true })]);
      let res = 'SAME';
      for (let i = 0; i < steps.length; i++) {
        const [rc, rb] = await stepBoth(P, steps[i]);
        let [c, b] = await Promise.all([L.obs(P.cand), L.obs(P.base)]);
        let d = L.diff(c, b, { ignore: ['ev', 'pts'], intendedPrevent: steps[i][0] === 'key' && L.INTENDED_PREVENT.test(steps[i][1]), tol: 2 });
        if (d.length) { await L.sleep(900); [c, b] = await Promise.all([L.obs(P.cand), L.obs(P.base)]); d = L.diff(c, b, { ignore: ['ev', 'pts'], intendedPrevent: steps[i][0] === 'key' && L.INTENDED_PREVENT.test(steps[i][1]), tol: 2 }); }
        if (rc !== rb) d.unshift({ field: 'stepResult', cand: rc, base: rb, detail: '' });
        if (d.length) { res = `DIFF at ${i} ${JSON.stringify(steps[i])}: ` + L.fmtDiff(d); break; }
      }
      out.push([name, res]);
      console.log(name, res.slice(0, 900));
    } catch (e) { out.push([name, 'ERR']); console.log(name, 'ERR', String(e.message).slice(0, 200)); }
  }
} finally {
  clearTimeout(killer);
  console.log('summary', JSON.stringify({ cases: out.length, same: out.filter((x) => x[1] === 'SAME').length, diff: out.filter((x) => x[1] !== 'SAME').map((x) => x[0]) }));
  await L.closeAll();
  process.exit(0);
}
