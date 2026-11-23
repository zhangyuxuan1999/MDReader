// src/preview/fidelity.ts — baseline fidelity gate for in-preview editing (CONTRACT §11, decision U12).
//
// Called once when a session starts, after the baseline serialization of the untouched block has been
// computed. It answers: does that Markdown render to what the block shows now? When it does not, the
// serializer cannot represent the block faithfully and the block is refused (此块请在源码中编辑) before
// anything is written.
//
// How: the baseline is rendered here, on the main thread, by md.ts's own markdown-it configuration with the
// options the worker runs with (DEFAULT_RENDER_OPTIONS: the app never changes them) and without
// highlight.js (createMarkdownWith(…, null)); the `$` rules are registered with a stub renderer that keeps
// each formula's TeX instead of calling KaTeX. The HTML is sanitized exactly as block HTML is. Then both
// DOMs are reduced to a canonical form (`canonicalForm`) and compared:
//  - kept: every element and its document attributes (a[href, title], img[src, alt, title], ol[start], cell
//    alignment, raw inline HTML with its attributes …), a checkbox's checked state, a code block's language
//    and exact text, a formula's kind (inline / display / block) and TeX, text with whitespace collapsed
//    the way `white-space: normal` collapses it (NBSP is not whitespace);
//  - ignored: what the app adds or the renderer derives — data-l, data-mdr-*, contenteditable / spellcheck,
//    classes md-* / mdr-* / hljs* / language-* / is-*, an a's target / rel, an img's loading, the
//    div.md-codewrap around a fence, [data-mdr-ui] elements, highlight.js's spans, KaTeX's markup;
//  - equal because they render the same: a space at the edge of an em / i / strong / b and the same space
//    just outside it; an inline element without attributes and without content (the HTML parser leaves
//    such copies of an unclosed <strong> or <a> behind when it reconstructs formatting after a block).
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_PLAIN, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED } from '../shared/types';
import { createMarkdownWith, type Markdown } from '../worker/md';
import { escapeHtml } from '../worker/math';
import { sanitizeToFragment } from './sanitize';

/** Switches the gate off (every block passes). */
export const FIDELITY_GATE = true;

/** The last refusal, for diagnostics (bench/verify/fix2-g-walk.mjs reads it through the dev server). */
export interface FidelityMismatch {
  /** The wrapper's data-id (the block id), when it has one. */
  id: string | null;
  kind: BlockKind;
  baseline: string;
  /** Canonical form of the block as shown, and of the baseline's rendering. */
  shown: string;
  rendered: string;
  /** Index of the first difference between the two canonical forms. */
  at: number;
}
let calls = 0;
let refusals = 0;
let last: FidelityMismatch | null = null;

/** Counters since load and the last refusal (diagnostics only). */
export function fidelityStats(): { calls: number; refusals: number; last: FidelityMismatch | null } {
  return { calls, refusals, last };
}

/**
 * True when `baseline` (the serializer's Markdown for the untouched `block`) renders to what `block`
 * shows. `block` is the mounted `section.md-block` wrapper; it must not be modified.
 */
export function baselineFaithful(block: Element, kind: BlockKind, baseline: string): boolean {
  if (!FIDELITY_GATE) return true;
  calls++;
  const shown = canonicalForm(block);
  const rendered = renderedForm(baseline);
  if (rendered !== null && rendered === shown) return true;
  refusals++;
  const r = rendered ?? '';
  let at = 0;
  while (at < shown.length && at < r.length && shown.charCodeAt(at) === r.charCodeAt(at)) at++;
  last = { id: block.getAttribute('data-id'), kind, baseline, shown, rendered: rendered ?? '(not rendered: plain / reserved)', at };
  return false;
}

// ---------------------------------------------------------------- rendering
let mdk: Markdown | null = null;

function renderer(): Markdown {
  if (mdk) return mdk;
  const m = createMarkdownWith(DEFAULT_RENDER_OPTIONS, null);
  if (DEFAULT_RENDER_OPTIONS.math) {
    // The worker renders a block with `$` only once KaTeX has loaded, so its rules are always on there.
    m.enableMath();
    const rules = m.md.renderer.rules;
    rules.math_inline = (t, i) => `<span class="md-math"><code>${escapeHtml(t[i].content)}</code></span>`;
    rules.math_display = (t, i) => `<span class="md-math md-math--display"><code>${escapeHtml(t[i].content)}</code></span>`;
    rules.math_block = (t, i) => `<div class="md-math md-math--block"><code>${escapeHtml(t[i].content)}</code></div>\n`;
  }
  // B1 / B2 of round 6 (CONTRACT §11, Checkpoint H): while `sink` is set (sourceRendered), the source texts of the bare
  // URLs and autolinks (the argument of normalizeLinkText, which shows them decoded) and the source text of the code
  // spans, code blocks and formulas (where no reference is read) are recorded.
  const rules = m.md.renderer.rules;
  for (const k of ['code_inline', 'code_block', 'fence', 'math_inline', 'math_display', 'math_block']) {
    const rule = rules[k];
    if (!rule) continue;
    rules[k] = (t, i, o, e, self) => {
      if (sink) sink.code.push(t[i].content);
      return rule(t, i, o, e, self);
    };
  }
  const linkText = m.md.normalizeLinkText;
  m.md.normalizeLinkText = (url: string): string => {
    if (sink) sink.links.push(url);
    return linkText.call(m.md, url);
  };
  mdk = m;
  return m;
}

interface SourceRendering { html: string; flags: number; links: string[]; code: string[] }
let sink: { links: string[]; code: string[] } | null = null;
let lastRendering: { markdown: string; r: SourceRendering } | null = null;
/** The gate's rendering of a block's SOURCE `markdown` (sourceHidden, sanitizerKept: the same source at one session start
 *  is rendered once), with what `sink` records. */
function sourceRendered(markdown: string): SourceRendering {
  if (lastRendering && lastRendering.markdown === markdown) return lastRendering.r;
  const s = { links: [] as string[], code: [] as string[] };
  sink = s;
  let r;
  try { r = renderer().renderBlock(markdown, { references: {} }); } finally { sink = null; }
  const out: SourceRendering = { html: r.html, flags: r.flags, links: s.links, code: s.code };
  lastRendering = { markdown, r: out };
  return out;
}

/** S1 (CONTRACT §11, Round-5 verification decisions; serialize.ts sourceHidden): what the block `markdown` shows as the
 *  gate renders it — `shows`: the texts and the attribute values of its sanitized HTML, joined by line feeds (formulas
 *  as their TeX); `links`: the source texts of its bare URLs and autolinks (B1 of Checkpoint H: a percent-escape in one
 *  of them is shown decoded); `code`: the source text of its code spans, code blocks and formulas (B2: a reference is not
 *  read there). null when it would not render as HTML (PLAIN, reserved). */
export function renderedShows(markdown: string): { shows: string; links: readonly string[]; code: string } | null {
  const r = sourceRendered(markdown);
  if (r.flags & (HTML_FLAG_PLAIN | HTML_FLAG_RESERVED)) return null;
  let out = '';
  const walk = (n: Node): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += (c as Text).data;
      else if (c.nodeType === 1) {
        for (const a of Array.from((c as Element).attributes)) out += '\n' + a.value;
        walk(c);
      }
    }
  };
  let f: DocumentFragment;
  try { f = sanitizeToFragment(r.html); } catch { return null; }   // (a processing instruction: rule T refuses the block)
  walk(f);
  return { shows: out, links: r.links, code: r.code.join('\n') };
}

/** RULE T of round 6 (CONTRACT §11, Checkpoint H: what the sanitizer took, a session does not delete) — THE test, at a
 *  session start (inlineEdit.ts startAllowed), for a block whose source `markdown` can hold raw HTML: did the sanitizer
 *  leave the block's rendering as the renderer made it? The gate's rendering of the source is parsed inertly (a template
 *  element: nothing loads, nothing runs) and compared with the sanitized result: every element of the inert tree must
 *  have its counterpart at the same place of the sanitized tree (same name, same element children in the same order)
 *  with every attribute it had, name and value; attributes the sanitizer or the application adds are fine. A comment or
 *  processing instruction (`<?x?>`, which the HTML parser reads as a comment) needs its counterpart too: it renders
 *  nothing, but the session would delete it from the source just the same. False when not, when the sanitizer throws,
 *  or when the block would not render as HTML (PLAIN, reserved: the gate refuses it anyway). A block the worker renders
 *  from code alone (TRUSTED) is mounted without the sanitizer: true.
 *  Integrator, round 6: called for EVERY block (a Markdown-only one too: the sanitizer trims a title or alt with edge
 *  spaces and removes one holding `-->`). `shown`, the block as mounted, may not hold more links without a URL or images
 *  without a source than the inert rendering: the rendering here has no reference definitions, so only the mounted
 *  block shows a URL the sanitizer took from a definition in another block (`[x][r]` with `[r]: obsidian://open`). */
export function sanitizerKept(markdown: string, shown?: ParentNode): boolean {
  const r = sourceRendered(markdown);
  if (r.flags & (HTML_FLAG_PLAIN | HTML_FLAG_RESERVED)) return false;
  if (r.flags & HTML_FLAG_TRUSTED) return true;
  let clean: DocumentFragment;
  try { clean = sanitizeToFragment(r.html); } catch { return false; }
  const inert = document.createElement('template');
  inert.innerHTML = r.html;
  if (shown && shown.querySelectorAll(NO_URL).length > inert.content.querySelectorAll(NO_URL).length) return false;
  return sameNodes(inert.content, clean);
}
const NO_URL = 'a:not([href]), img:not([src])';
/** The elements, comments and processing instructions of the children of `a` (inert) are those of `b` (sanitized),
 *  one by one in order (text is not compared): see sanitizerKept. */
function sameNodes(a: Node, b: Node): boolean {
  const ka = kept(a), kb = kept(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i], y = kb[i];
    if (x.nodeType !== y.nodeType) return false;
    if (x.nodeType !== 1) { if ((x as CharacterData).data !== (y as CharacterData).data) return false; continue; }
    const ex = x as Element, ey = y as Element;
    if (ex.localName !== ey.localName || ex.namespaceURI !== ey.namespaceURI) return false;
    for (const at of Array.from(ex.attributes)) if (ey.getAttribute(at.name) !== at.value) return false;
    const tx = ex.localName === 'template' ? (ex as HTMLTemplateElement).content : ex;
    const ty = ey.localName === 'template' ? (ey as HTMLTemplateElement).content : ey;
    if (!sameNodes(tx, ty)) return false;
  }
  return true;
}
const kept = (n: Node): Node[] => Array.from(n.childNodes).filter((c) => c.nodeType === 1 || c.nodeType === 7 || c.nodeType === 8);

/** Canonical form of what `markdown` renders to as a block, or null when it would not render as HTML at all
 *  (PLAIN fallback) or would carry a name the app reserves (the worker would mark the block, U10 a). */
function renderedForm(markdown: string): string | null {
  const r = renderer().renderBlock(markdown, { references: {} });
  if (r.flags & (HTML_FLAG_PLAIN | HTML_FLAG_RESERVED)) return null;
  return canonicalForm(sanitizeToFragment(r.html));
}

// ---------------------------------------------------------------- canonical form
const OPEN = 0, CLOSE = 1, TEXT = 2, ATOM = 3, PRE = 4;
interface Part {
  k: number; s: string;
  /** a line boundary: whitespace next to it does not render */
  b: boolean;
  /** OPEN / CLOSE: the element's name; OPEN: it has no attributes */
  n?: string; bare?: boolean;
}

/** Elements that start and end a line box (whitespace at their edges does not render). */
const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'hr', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav',
  'main', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'address', 'fieldset', 'legend', 'center',
]);
const VOID = new Set(['br', 'hr', 'img', 'input', 'wbr', 'area', 'col', 'embed', 'source', 'track']);
/** Inline elements whose edge spaces render the same just outside them (no box, no line decoration). */
const HOIST = new Set(['em', 'i', 'strong', 'b']);
/** Inline elements that show something even when empty (q: quotation marks; code: a padded box). */
const KEEP_EMPTY = new Set(['q', 'code']);
/** Attributes the app or the session sets (data-l: a line map; data-mdr-*: markers). */
const APP_ATTR = /^(?:data-l|data-mdr-.*|contenteditable|spellcheck)$/s;
/** Class tokens the renderer derives or the app adds. */
const APP_CLASS = /^(?:md-|mdr-|hljs|language-|is-)/;
const WS = /[\t\n\f\r ]+/g;

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Canonical form of the content of `root` (a block wrapper or a fragment; the root's own attributes are not part of it). */
export function canonicalForm(root: Node): string {
  const walked: Part[] = [];
  walk(root, walked);
  const parts = hoist(walked);
  collapse(parts);
  let out = '';
  for (const p of dropEmpty(parts)) out += p.k === TEXT || p.k === PRE ? escText(p.s) : p.s;
  return out;
}

function walk(n: Node, out: Part[]): void {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) { out.push({ k: TEXT, s: (c as Text).data, b: false }); continue; }
    if (c.nodeType !== 1) continue;                       // comments render nothing
    const e = c as Element;
    if (e.hasAttribute('data-mdr-ui') || e.classList.contains('md-plain__note')) continue;
    const name = e.localName;
    if (name === 'div' && e.classList.contains('md-codewrap')) { walk(e, out); continue; }
    if (e.classList.contains('md-math') || e.classList.contains('md-math-src')) { out.push(mathAtom(e)); continue; }
    const tag = name + attrs(e);
    const block = BLOCK.has(name);
    if (name === 'pre') {
      out.push({ k: OPEN, s: `<${tag}>`, b: true }, { k: PRE, s: preText(e), b: false }, { k: CLOSE, s: '</pre>', b: true });
      continue;
    }
    if (VOID.has(name)) { out.push({ k: ATOM, s: `<${tag}/>`, b: block || name === 'br' }); continue; }
    out.push({ k: OPEN, s: `<${tag}>`, b: block, n: name, bare: tag === name });
    walk(name === 'template' ? (e as HTMLTemplateElement).content : e, out);
    out.push({ k: CLOSE, s: `</${name}>`, b: block, n: name });
  }
}

function attrs(e: Element): string {
  const name = e.localName;
  const list: string[] = [];
  for (const a of Array.from(e.attributes)) {
    const n = a.name.toLowerCase();
    if (APP_ATTR.test(n)) continue;
    if (n === 'class') {
      const v = Array.from(new Set(a.value.split(WS).filter((x) => x !== '' && !APP_CLASS.test(x)))).sort().join(' ');
      if (v) list.push(`class="${escAttr(v)}"`);
      continue;
    }
    if (n === 'data-lang') { if (name === 'pre') list.push(`lang="${escAttr(a.value)}"`); continue; }
    if (name === 'a' && (n === 'target' || n === 'rel')) continue;      // the sanitizer derives them from href
    if (name === 'img' && n === 'loading') continue;
    if (name === 'input' && n === 'checked') continue;                  // the state below, not the attribute
    list.push(`${n}="${escAttr(a.value)}"`);
  }
  if (name === 'input') list.push(`checked="${(e as HTMLInputElement).checked}"`);
  return list.length ? ' ' + list.sort().join(' ') : '';
}

/** A code block's text as shown (highlight.js's spans are styling only). */
function preText(e: Element): string {
  if (!e.querySelector('[data-mdr-ui]')) return e.textContent ?? '';
  const c = e.cloneNode(true) as Element;
  for (const u of Array.from(c.querySelectorAll('[data-mdr-ui]'))) u.remove();
  return c.textContent ?? '';
}

/** A formula: its kind and its TeX (KaTeX's annotation in the preview, the stub's code here, a KaTeX error's
 *  text, or a session's source element). Leading whitespace and unescaped trailing whitespace do not render. */
function mathAtom(m: Element): Part {
  const cl = m.classList;
  const v = cl.contains('md-math--block') ? 'block' : cl.contains('md-math--display') ? 'display' : 'inline';
  let tex: string;
  if (cl.contains('md-math-src')) tex = m.textContent ?? '';
  else {
    const ann = m.querySelector('annotation[encoding="application/x-tex"]');
    tex = ann ? ann.textContent ?? '' : (m.querySelector('code') ?? m).textContent ?? '';
  }
  tex = tex.replace(/[\u200b\ufeff]/g, '').replace(/^[\t\n\f\r ]+/, '');
  // the trailing run, except one whitespace character right after a backslash (`\ ` is TeX's control space);
  // a loop, not /(?<!\\)[\t\n\f\r ]+$/, which retries at every position of an inner run (H29)
  let e = wsTail(tex);
  if (e > 0 && e < tex.length && tex.charCodeAt(e - 1) === 92) e++;
  if (e < tex.length) tex = tex.slice(0, e);
  return { k: ATOM, s: `<math ${v}>${escText(tex)}</math>`, b: v === 'block' };
}

/** Start of the run of whitespace (tab, LF, FF, CR, space) that ends `s`; s.length when `s` does not end in
 *  whitespace. Linear in the run, so the gate stays linear in a whitespace run's length (H29). */
function wsTail(s: string): number {
  let e = s.length;
  for (;;) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13) return e;
    e--;
  }
}

/** Moves whitespace at the inner edges of an em / i / strong / b just outside it (inner elements first). */
function hoist(parts: Part[]): Part[] {
  for (;;) {
    let changed = false;
    const out: Part[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], q = parts[i + 1];
      if (q && p.k === OPEN && HOIST.has(p.n!) && q.k === TEXT) {
        const m = /^[\t\n\f\r ]+/.exec(q.s);
        if (m) { out.push({ k: TEXT, s: m[0], b: false }); q.s = q.s.slice(m[0].length); changed = true; }
      } else if (q && p.k === TEXT && q.k === CLOSE && HOIST.has(q.n!)) {
        const e = wsTail(p.s);                            // a loop, not /[\t\n\f\r ]+$/ (H29)
        if (e < p.s.length) { const m = p.s.slice(e); p.s = p.s.slice(0, e); out.push(p, q, { k: TEXT, s: m, b: false }); i++; changed = true; continue; }
      }
      out.push(p);
    }
    if (!changed) return out;
    parts = out;
  }
}

/** The parts without empty text and without inline elements that have neither attributes nor content. */
function dropEmpty(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.k === TEXT && p.s === '') continue;
    if (p.k === CLOSE && !p.b && !KEEP_EMPTY.has(p.n!)) {
      const o = out[out.length - 1];
      if (o && o.k === OPEN && o.bare && o.n === p.n) { out.pop(); continue; }
    }
    out.push(p);
  }
  return out;
}

/** Whitespace as `white-space: normal` renders it: runs collapse to one space, a space after a space (also
 *  across inline element boundaries) and spaces at a line boundary (block edges, <br>) disappear. */
function collapse(parts: Part[]): void {
  let space = true;                                        // the start counts as a line boundary
  for (const p of parts) {
    if (p.k === OPEN || p.k === CLOSE) { if (p.b) space = true; continue; }
    if (p.k === ATOM) { space = p.b; continue; }
    if (p.k === PRE) { space = false; continue; }
    p.s = p.s.replace(WS, ' ');
    if (space && p.s.charCodeAt(0) === 32) p.s = p.s.slice(1);
    if (p.s !== '') space = p.s.charCodeAt(p.s.length - 1) === 32;
  }
  let boundary = true;                                     // the end too
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.k === OPEN || p.k === CLOSE) { if (p.b) boundary = true; continue; }
    if (p.k === ATOM) { boundary = p.b; continue; }
    if (p.k === PRE) { boundary = false; continue; }
    if (boundary && p.s.charCodeAt(p.s.length - 1) === 32) p.s = p.s.slice(0, -1);
    if (p.s !== '') boundary = false;
  }
}
