// bench/verify/v4-sesa-lib.mjs — verify-session-a (0.2.0 stage 2d, round-3 re-verification) shared helpers for
// bench/verify/v4-sesa-*.mjs. Wraps v3-ses-lib.mjs (which never kills the port at exit; it starts a detached Vite
// only when nothing answers on MDR_PORT). Defaults: MDR_PORT=5431, scratch dir .../scratchpad/v4-sesa.
// Writes nothing into the tree.
process.env.MDR_PORT = process.env.MDR_PORT || '5431';
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v4-sesa';
const L = await import('./v3-ses-lib.mjs');
export const { openB, sleep, globalTimeout, J, rng, BASE, PORT, SCRATCH, view, shownText, clickText, pointOf, undoTo, redoTo, NBSP } = L;

export const results = { pass: 0, fail: 0, fails: [] };
export function check(name, ok, detail = '') {
  if (ok) results.pass++; else { results.fail++; results.fails.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
export function summary() {
  console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`);
}

/** Waits until a session is active (focus in it, not the capture element); returns view(). */
export async function waitSession(page, ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}

/** Starts a session by a real click on character k of `needle` (right half: caret after it). */
export async function startAt(B, needle, k = 0, side = 'right') {
  await clickText(B.page, needle, k, { side });
  const v = await waitSession(B.page);
  if (!v.editing) throw new Error(`no session on "${needle}" ${J(v)}`);
  return v;
}

/** Clicks the centre of the first element matching `sel` in the preview (formula block etc.). */
export async function clickSel(B, sel) {
  const p = await B.page.evaluate((sel) => {
    const m = document.querySelector('.mdr-preview ' + sel);
    if (!m) return null;
    m.scrollIntoView({ block: 'center' });
    const r = m.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!p) throw new Error('no element ' + sel);
  await B.page.mouse.click(p.x, p.y);
  return waitSession(B.page);
}

/** The caret as (text before it in the editing block, text after it) — visible text, UI and MathML left out. */
export async function caretCtx(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const s = getSelection();
    if (!el || !s.rangeCount || !el.contains(s.focusNode)) return null;
    const vis = (r) => {
      const frag = r.cloneContents();
      for (const u of frag.querySelectorAll('[data-mdr-ui], .katex-mathml')) u.remove();
      return frag.textContent;
    };
    const a = document.createRange(); a.setStart(el, 0); a.setEnd(s.focusNode, s.focusOffset);
    const b = document.createRange(); b.setStart(s.focusNode, s.focusOffset); b.setEnd(el, el.childNodes.length);
    return { before: vis(a).slice(-12), after: vis(b).slice(0, 12), collapsed: s.isCollapsed };
  });
}

/** Caret (or selection, mode 'select') by a needle in the editing block's EDITABLE visible text: text inside a
 *  formula, KaTeX, a [contenteditable=false] element or the app's UI is skipped, and at a boundary between two
 *  text nodes 'after' stays at the end of the earlier node, 'before' goes to the start of the later one (what a
 *  click on that side of the character gives). */
export async function caretTo(page, needle, mode = 'after') {
  await page.evaluate(({ needle, mode }) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, .katex, [contenteditable="false"], [data-mdr-ui]') ? 2 : 1) });
    const nodes = []; let all = '';
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const i = all.indexOf(needle);
    if (i < 0) throw new Error(`caretTo: "${needle}" not in editing block`);
    const at = (off, late) => {
      if (late) { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= off) return [nodes[k][0], off - nodes[k][1]]; }
      for (let k = 0; k < nodes.length; k++) if (off <= nodes[k][1] + nodes[k][0].data.length) return [nodes[k][0], off - nodes[k][1]];
      return [nodes[0][0], 0];
    };
    const r = document.createRange();
    if (mode === 'select') { const a = at(i, true); const b = at(i + needle.length, false); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); }
    else { const a = mode === 'after' ? at(i + needle.length, false) : at(i, true); r.setStart(a[0], a[1]); r.collapse(true); }
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }, { needle, mode });
}

export const settleFor = (B) => async (ms = 320) => { await sleep(ms); await B.settle(150); };

/** Loads `doc` and checks it loaded verbatim. */
export async function load(B, doc) {
  await B.loadDoc(doc);
  const s = await B.source();
  if (s !== doc) throw new Error('loaded ' + J(s));
  await sleep(500);
}
