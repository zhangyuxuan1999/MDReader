// @vitest-environment jsdom
// test/r3-s-fidelity-linear.test.ts — fix-serial (stage 2d, fix round 3), H29 (REV-3).
//
// fidelity.ts's hoist() and mathAtom() trimmed trailing whitespace with /[\t\n\f\r ]+$/ and
// /(?<!\\)[\t\n\f\r ]+$/: quadratic in an inner whitespace run. Round 3 replaced both by a backward loop
// (wsTail). This file keeps a verbatim copy of the OLD canonical form (pre-r3 fidelity.ts, the two
// expressions included; only the zero-width class is built in code) and checks that the new
// canonicalForm gives the same string on several thousand random blocks: random DOM trees of
// em / i / strong / b / span / code / a with whitespace-heavy text and formulas (KaTeX-shaped, stub-shaped
// and session-source-shaped, TeX with backslashes before trailing whitespace), and random Markdown rendered
// by the app's own markdown-it + KaTeX. Plus the timing: N = 60 000 spaces stays well under 100 ms.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { canonicalForm } from '../src/preview/fidelity';

const ZW = new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g');

// ======== OLD implementation (pre-r3 src/preview/fidelity.ts, canonical-form section, verbatim) ========
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
function oldCanonicalForm(root: Node): string {
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
  tex = tex.replace(ZW, '').replace(/^[\t\n\f\r ]+/, '').replace(/(?<!\\)[\t\n\f\r ]+$/, '');
  return { k: ATOM, s: `<math ${v}>${escText(tex)}</math>`, b: v === 'block' };
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
        const m = /[\t\n\f\r ]+$/.exec(p.s);
        if (m) { p.s = p.s.slice(0, -m[0].length); out.push(p, q, { k: TEXT, s: m[0], b: false }); i++; changed = true; continue; }
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

// ======== end of the old implementation ========

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NBSP = String.fromCharCode(0xa0);
const BS = String.fromCharCode(92);
const ALPHA = [' ', ' ', ' ', '\t', '\n', '\r', '\f', 'a', 'b', BS, BS, NBSP, String.fromCharCode(0x200b), String.fromCharCode(0xfeff), 'x', '{', '}'];

function text(r: () => number): string {
  let s = '';
  const n = Math.floor(r() * 9);
  for (let i = 0; i < n; i++) {
    const c = ALPHA[Math.floor(r() * ALPHA.length)];
    s += r() < 0.15 ? c.repeat(1 + Math.floor(r() * 6)) : c;
  }
  return s;
}

function formula(r: () => number): Element {
  const tex = text(r) + (r() < 0.5 ? BS + text(r) : '') + (r() < 0.5 ? ' '.repeat(Math.floor(r() * 4)) : '');
  const kind = ['', ' md-math--display', ' md-math--block'][Math.floor(r() * 3)];
  const shape = Math.floor(r() * 3);
  if (shape === 0) {                                           // a session's source element
    const e = document.createElement('span');
    e.className = 'md-math-src';
    e.textContent = tex;
    return e;
  }
  const e = document.createElement(kind.includes('block') ? 'div' : 'span');
  e.className = 'md-math' + kind;
  if (shape === 1) {                                           // KaTeX's annotation
    const k = document.createElement('span');
    k.innerHTML = '<span class="katex"><math><semantics><mrow></mrow><annotation encoding="application/x-tex"></annotation></semantics></math></span>';
    k.querySelector('annotation')!.textContent = tex;
    e.appendChild(k);
  } else {                                                     // the gate's stub
    const c = document.createElement('code');
    c.textContent = tex;
    e.appendChild(c);
  }
  return e;
}

const TAGS = ['em', 'i', 'strong', 'b', 'em', 'strong', 'span', 'code', 'a', 'br'];
function fill(e: Element, r: () => number, depth: number): void {
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.45 || depth > 4) e.appendChild(document.createTextNode(text(r)));
    else if (x < 0.6) e.appendChild(formula(r));
    else {
      const t = TAGS[Math.floor(r() * TAGS.length)];
      const c = document.createElement(t);
      if (t === 'a' && r() < 0.5) c.setAttribute('href', 'https://e.com/');
      if (t !== 'br') fill(c, r, depth + 1);
      e.appendChild(c);
    }
  }
}

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

describe('H29: the new canonical form equals the old one', () => {
  it('3000 random DOM blocks', () => {
    const r = rng(20261120);
    let diff = 0;
    const first: string[] = [];
    for (let k = 0; k < 3000; k++) {
      const w = document.createElement('section');
      w.className = 'md-block';
      const p = document.createElement(r() < 0.7 ? 'p' : 'li');
      fill(p, r, 0);
      w.appendChild(p);
      const a = oldCanonicalForm(w), b = canonicalForm(w);
      if (a !== b) { diff++; if (first.length < 3) first.push(JSON.stringify({ html: w.innerHTML, a, b })); }
    }
    expect({ diff, first }).toEqual({ diff: 0, first: [] });
  });

  it('2000 random Markdown blocks rendered by markdown-it + KaTeX', () => {
    const r = rng(7);
    const piece = (): string => {
      const x = r();
      const t = text(r).replace(/[\r\f]/g, ' ');
      if (x < 0.2) return '*' + t + '*';
      if (x < 0.35) return '**' + t + '**';
      if (x < 0.5) return '$' + t + '$';
      if (x < 0.6) return '_x' + t + 'y_';
      if (x < 0.7) return '<em>' + t + '</em>';
      return t;
    };
    let diff = 0, formulas = 0;
    const first: string[] = [];
    for (let k = 0; k < 2000; k++) {
      let src = r() < 0.1 ? '$$\n' + text(r) + '\n$$' : 'p ' + piece() + piece() + ' q ' + piece() + piece();
      if (r() < 0.2) src = '- ' + src;
      const w = document.createElement('section');
      w.className = 'md-block';
      w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
      wrapCodeFences(w);
      formulas += w.querySelectorAll('.md-math').length;
      const a = oldCanonicalForm(w), b = canonicalForm(w);
      if (a !== b) { diff++; if (first.length < 3) first.push(JSON.stringify({ src, a, b })); }
    }
    expect({ diff, first }).toEqual({ diff: 0, first: [] });
    expect(formulas).toBeGreaterThan(200);
  });

  it('a 60 000-space run inside emphasis and inside a formula is linear', () => {
    const N = 60000;
    for (const src of [`a *x${' '.repeat(N)}y* b`, `a **x${' '.repeat(N)}y${' '.repeat(N)}** b`, `$$\nx${' '.repeat(N)}y\n$$`, `a <em>${' '.repeat(N)}y${' '.repeat(N)}</em> b`, `p $x${' '.repeat(N)}${BS}${' '.repeat(N)}$ q`]) {
      const w = document.createElement('section');
      w.className = 'md-block';
      w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
      const t = performance.now();
      canonicalForm(w);
      const ms = performance.now() - t;
      expect(ms, src.slice(0, 12)).toBeLessThan(100);
    }
  });
});
