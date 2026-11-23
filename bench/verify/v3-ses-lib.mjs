// bench/verify/v3-ses-lib.mjs — verify-session (0.2.0 stage 2c) shared helpers for bench/verify/v3-ses-*.mjs.
// Wraps v2-ses-lib.mjs (which never kills the port at exit and starts a detached Vite only when nothing answers).
// Defaults: MDR_PORT=5382, scratch dir /private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/<session>/scratchpad/v3-ses.
// Writes nothing into the tree.
process.env.MDR_PORT = process.env.MDR_PORT || '5382';
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v3-ses';
const L = await import('./v2-ses-lib.mjs');
export const { openB, sleep, globalTimeout, J, readRoot, rng, BASE, PORT, SCRATCH } = L;

export const NBSP = String.fromCharCode(0xa0);
export const IDSP = String.fromCharCode(0x3000);

export const results = { pass: 0, fail: 0, fails: [] };
export function check(name, ok, detail = '') {
  if (ok) results.pass++; else { results.fail++; results.fails.push(name); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
export function summary() {
  console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`);
}

/** Everything a check needs about the page right now. */
export async function view(page) {
  return page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const root = document.querySelector('.mdr-preview');
    const ed = root.querySelector('.is-editing');
    const ae = document.activeElement;
    const sel = getSelection();
    let caret = null;
    if (ed && sel.rangeCount && ed.contains(sel.anchorNode)) {
      const r = document.createRange(); r.setStart(ed, 0); r.setEnd(sel.focusNode, sel.focusOffset);
      caret = r.toString().length;
    }
    const sections = Array.from(root.querySelectorAll('section.md-block'));
    const ids = sections.map((s) => s.dataset.id);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    return {
      src: window.__mdr.app.getText(),
      editing: ed ? { id: Number(ed.dataset.id), text: ed.textContent, html: ed.innerHTML.slice(0, 400) } : null,
      active: ae ? String(ae.className || ae.tagName).slice(0, 40) : null,
      capFocused: !!(ae && ae.classList && ae.classList.contains('mdr-preview__edit-capture')),
      caret,
      resuming: pv && pv.inline ? undefined : undefined,
      dupIds: dup,
      ghost: !!root.querySelector('.md-ghost-holder'),
      stale: sections.filter((s) => s.classList.contains('is-stale')).length,
      pending: sections.filter((s) => s.classList.contains('is-pending') && s.getBoundingClientRect().height > 0 && s.getBoundingClientRect().bottom > 0 && s.getBoundingClientRect().top < innerHeight).length,
      blockCount: pv.blockCount(),
      toast: Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent).filter(Boolean).join(' | ').slice(0, 200),
    };
  });
}

/** Visible text of the preview's blocks in document order (UI elements, KaTeX MathML and the capture element left out). */
export async function shownText(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const out = [];
    for (const s of root.querySelectorAll('section.md-block')) {
      if (s.getBoundingClientRect().height === 0 && !s.classList.contains('is-editing')) continue;
      const c = s.cloneNode(true);
      for (const u of c.querySelectorAll('[data-mdr-ui], .katex-mathml, .md-code__lang, button')) u.remove();
      // a separator wherever the layout breaks a line (the session DOM has no newlines between its elements)
      for (const b of c.querySelectorAll('br, li, p, h1, h2, h3, h4, h5, h6, td, th, tr, pre, blockquote')) b.before(document.createTextNode(' '));
      out.push(c.textContent.replace(/\s+/g, ' ').trim());
    }
    return out.filter((x) => x !== '');
  });
}

/** Text-editor-like click: real mouse press + release on the character `needle[k]` (any block, any element). */
export async function clickText(page, needle, k = 0, opts = {}) {
  const pt = await pointOf(page, needle, k, opts.side ?? 'left');
  if (!pt) throw new Error(`clickText: "${needle}" not shown`);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down({ clickCount: opts.clickCount ?? 1 });
  if (opts.hold) await sleep(opts.hold);
  await page.mouse.up({ clickCount: opts.clickCount ?? 1 });
  return pt;
}

/** Viewport point at the left (or right) edge of character k of the first text occurrence of `needle` in the preview. */
export async function pointOf(page, needle, k = 0, side = 'left', scroll = true) {
  return page.evaluate(({ needle, k, side, scroll }) => {
    const root = document.querySelector('.mdr-preview');
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui], .katex-mathml') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const at = i + k;
      const r = document.createRange();
      r.setStart(n, at); r.setEnd(n, Math.min(n.data.length, at + 1));
      let rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      if (scroll && (rect.top < box.top + 10 || rect.bottom > box.bottom - 10)) {
        root.scrollTop += rect.top - (box.top + box.height / 2);
        rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      }
      const x = side === 'left' ? rect.left + Math.min(1.5, rect.width / 3) : rect.right - Math.min(1.5, rect.width / 3);
      return { x, y: rect.top + rect.height / 2 };
    }
    return null;
  }, { needle, k, side, scroll });
}

/** ⌘Z (inside whatever has the focus) until the source equals `orig`; at most `max` presses. */
export async function undoTo(B, orig, max = 20, gap = 150) {
  let now = await B.source();
  let n = 0;
  for (; n < max && now !== orig; n++) { await B.page.keyboard.press('Meta+z'); await sleep(gap); await B.settle(120); now = await B.source(); }
  return { ok: now === orig, n, now };
}
export async function redoTo(B, fin, max = 20, gap = 150) {
  let now = await B.source();
  let n = 0;
  for (; n < max && now !== fin; n++) { await B.page.keyboard.press('Meta+Shift+z'); await sleep(gap); await B.settle(120); now = await B.source(); }
  return { ok: now === fin, n, now };
}

/** Runs `fn(B)` per named case with a fresh document; prints PASS / FAIL lines. */
export async function runCases(B, cases, filter) {
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      const r = await c.run(B);
      check(c.name, r.ok, r.detail ?? '');
    } catch (e) {
      check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]);
    }
    try { await B.page.keyboard.press('Escape'); await B.settle(80); } catch { /* */ }
  }
}

/** loadDoc that also works on the 0.1.1 renderer (no edit session API). */
export async function loadDocAny(B, text, name = 'v.md') {
  await B.page.evaluate(() => window.__mdr.app.preview.endEditSession?.());
  await B.page.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
  await B.page.evaluate(() => window.__mdr.waitIdle());
  await sleep(250);
}
