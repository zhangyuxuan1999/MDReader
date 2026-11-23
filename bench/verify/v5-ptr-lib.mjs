// bench/verify/v5-ptr-lib.mjs — verify-session-pointer (0.2.0 round-4 re-verification) shared helpers for
// bench/verify/v5-ptr-*.mjs. Wraps v4-sesb-lib.mjs (never kills the port at exit). Candidate: MDR_PORT (default 5482,
// a Vite dev server of the tree: nothing stored = 预览可编辑 ON). Baseline: MDR_BASE_PORT (default 5492, vite preview of
// release/baseline-0.1.1.noindex/dist, opened with ?perf=1). Writes nothing into the tree.
// Invisible characters are built from code points (never typed escapes).
process.env.MDR_PORT = process.env.MDR_PORT || '5482';
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-ptr';
const L = await import('./v4-sesb-lib.mjs');
export const { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, view, results, pointOf, pt } = L;
export const { clickText } = await import('./v3-ses-lib.mjs');

export const CP = Number(process.env.MDR_PORT || 5482);
export const BP = Number(process.env.MDR_BASE_PORT || 5492);
export const ch = (n) => String.fromCharCode(n);
export const ZW = ch(0x200b), FEFF = ch(0xfeff), NBSP = ch(0xa0);

/** Code points nobody sees: zero-width and format characters, NBSP, the marker ranges (U+E000-U+F8FF, U+FDD0-U+FDEF). */
export function isInvisible(c) {
  return c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff || c === 0xad || c === 0xa0 ||
    c === 0x180e || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f ||
    (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xfdd0 && c <= 0xfdef);
}
/** Counts of invisible code points in `s` that `allowed` (the source the user had, plus what they typed) does not hold
 *  as often: {"U+200B": n, ...}. */
export function invisibleExtra(s, allowed = '') {
  const count = (t) => { const m = {}; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (isInvisible(c)) { const k = 'U+' + c.toString(16).toUpperCase().padStart(4, '0'); m[k] = (m[k] || 0) + 1; } } return m; };
  const a = count(s), b = count(allowed), out = {};
  for (const k of Object.keys(a)) if (a[k] > (b[k] || 0)) out[k] = a[k] - (b[k] || 0);
  return out;
}
export const none = (o) => Object.keys(o).length === 0;
/** Shows invisible characters as <U+XXXX>. */
export function show(s) {
  if (s == null) return String(s);
  let o = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o += isInvisible(c) ? `<U+${c.toString(16).toUpperCase().padStart(4, '0')}>` : s[i]; }
  return J(o);
}

/** The clipboard now: text/plain and text/html (html '' when absent). */
export async function readClip(page) {
  return page.evaluate(async () => {
    const out = { plain: '', html: '' };
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/plain')) out.plain = await (await it.getType('text/plain')).text();
        if (it.types.includes('text/html')) out.html = await (await it.getType('text/html')).text();
      }
    } catch (e) { out.err = String(e); }
    return out;
  });
}
export async function clearClip(page) { await page.evaluate(() => navigator.clipboard.writeText('<<none>>')); }
/** ⌘C (or ⌘X) and the clipboard afterwards. */
export async function copyKey(page, key = 'Meta+c') {
  await clearClip(page);
  await page.keyboard.press(key);
  await sleep(180);
  return readClip(page);
}

/** Zero-width characters in the preview's DOM outside KaTeX's own markup and the app's UI: [{ctx, beforeAtom}]. */
export async function domZw(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const out = [];
    const tw = document.createTreeWalker(root, 4, { acceptNode: (n) => (n.parentElement?.closest('.katex, [data-mdr-ui], .mdr-preview__edit-capture') ? 2 : 1) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      for (let i = 0; i < n.data.length; i++) {
        const c = n.data.charCodeAt(i);
        if (c === 0x200b || c === 0xfeff) {
          const nx = n.nextSibling;
          out.push({ ctx: (n.data.slice(Math.max(0, i - 6), i) + '<ZW>' + n.data.slice(i + 1, i + 7)), beforeAtom: i === n.data.length - 1 && !!(nx && nx.nodeType === 1 && nx.matches('.md-math, img, input')), editing: !!n.parentElement?.closest('.is-editing') });
        }
      }
    }
    return out;
  });
}
/** Inline elements in the preview with no text and no atom (an empty link, bold, code ...), outside KaTeX. */
export async function emptyInline(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const out = [];
    for (const e of root.querySelectorAll('a, strong, em, del, s, code, b, i')) {
      if (e.closest('.katex, [data-mdr-ui], pre')) continue;
      const t = Array.from(e.textContent || '').filter((c) => c.charCodeAt(0) !== 0x200b && c.charCodeAt(0) !== 0xfeff).join('');
      if (t === '' && !e.querySelector('img, .md-math, input, br')) out.push(e.outerHTML.slice(0, 80));
    }
    return out;
  });
}
/** Pastes `text` into the editor pane at the end of the document (the user's ⌘V there). */
export async function pasteIntoEditor(page, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.evaluate(() => { const ev = window.__mdr.app.editor.view; ev.focus(); ev.dispatch({ selection: { anchor: ev.state.doc.length } }); });
  await page.keyboard.press('Meta+v');
  await sleep(250);
}
export async function sessionOn(page) { return page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')); }
