// src/preview/serialize.ts — block DOM → Markdown for in-preview editing (CONTRACT §11).
//
// `serializeBlock(el, kind)` turns the DOM of ONE mounted block (its `section.md-block`, or any element
// whose children are the block's content) back into Markdown. It is pure: the element is cloned, never
// touched, and the result depends only on the DOM (plus the optional hints). Built on turndown +
// turndown-plugin-gfm; almost every rule is ours, because turndown's defaults are tuned for arbitrary web
// pages while this has to reproduce what OUR markdown-it (src/worker/md.ts + math.ts) renders, byte for
// byte after normalisation (test/serialize.roundtrip.test.ts is the acceptance gate).
//
// What turndown still does for us: the node walk, inline whitespace collapsing, flanking whitespace
// around inline elements, and the newline bookkeeping between blocks. Everything context-sensitive —
// escaping, math, fences, task items, soft line breaks — is prepared on the clone BEFORE turndown sees it:
//   · text is escaped here, with the context turndown cannot give its `escape` hook (line start, the
//     neighbouring characters, table cell, heading, link, the whole inline context). Escaping is minimal:
//     `snake_case`, `a * b`, `5 $`, `C:\dir`, a paragraph's only `$` (`$5`), a lone `[`, a `]` outside a
//     link, the only `~` run of a paragraph stay as typed; `**`, `` ` ``, `[…]`, `$x … $`, a leading
//     `# ` / `- ` / `1. ` / `>` / `~~~` are escaped.
//   · soft line breaks ("\n" inside a paragraph) are kept as line breaks (turndown would join the lines),
//     so editing a hard-wrapped paragraph does not reflow its source.
//   · atoms whose text must survive verbatim (fenced code, inline code, KaTeX, task markers) are replaced
//     by placeholder elements carrying their final Markdown in `data-md`.
//
// Accepted normalisations (the source may change on the first edit of a block; rendering does not):
//   `_em_`/`__strong__` → `*em*`/`**strong**`; `+`/`*` bullets → `-`; `1)` → `1.` (and ordered lists are
//   renumbered from their start); setext headings → ATX; reference links → inline; `<br>` → two spaces;
//   tables → `| a | b |` with `---` delimiters (the source's own delimiter row with the `tableDelim` hint
//   while columns and alignment are unchanged); indented code → a fence (unless the source fence is passed
//   as a hint); list continuation indent = marker width; a non-breaking space next to a space or at a text
//   node's edge → a space (one between two characters stays `&nbsp;`); trailing non-breaking spaces
//   dropped; `<b>`/`<i>`/`<s>` → `**`/`*`/`~~`; blocks inside a block are separated by one blank line
//   (none under an ATX heading with the `tightHeadings` hint). A link whose text is its URL (U11): bare only where
//   markdown-it's linkify provably reads back exactly that link, `<url>` only as a valid autolink showing the same
//   text, else `[text](destination)`; an autolink the block's source writes `<url>` stays one.
import markdownIt, { type MarkdownIt } from 'markdown-it';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../shared/types';
import { mathPlugin } from '../worker/math';
import { renderedShows } from './fidelity';
import { ownTaskBox } from './interactions';

/** Marks the caret in `serializeBlockWithCaret` output (Private Use Area). The document's own U+E001
 *  characters are replaced by U+FFFD in that output (and only there), so the mark is unique in it. */
export const CARET_MARK = '\uE001';
// Internal markers: single Private Use Area characters, chosen per serialization among those the block
// does not contain (`pickMarkers`; U+E000…U+E003 when it holds none), so no character of the document can
// be taken for one and every document character survives as it is (G4).
/** A soft line break inside inline text, protected from turndown's whitespace collapsing. */
let NL = '\uE000';
/** The caret while it travels through the conversion (CARET_MARK in the result). */
let CARET = '\uE001';
/** Table cell separator between the cell rule and the table rule. */
let CELL = '\uE002';
/** "A Markdown delimiter comes next" (an inline element's `**`, `[`, `` ` ``…) for the escaping context. */
let MARKUP = '\uE003';

const MARKER_RANGES: ReadonlyArray<readonly [number, number]> = [[0xe000, 0xf8ff], [0xfdd0, 0xfdef]];
const MARKER_CHARS = /[\uE000-\uF8FF\uFDD0-\uFDEF]/;

/** The marker-range characters the block's source writes raw (`SerializeHints.puaRaw`), for `linkDest`: set by
 *  `pickMarkers`, like the markers. */
let PUA_RAW = '';
/** J19 extended: href → the block source's own spelling of it (`SerializeHints.urlSpellings`), for `linkDest` and the
 *  link rule: set with the markers (`ownUrls`). */
let OWN_URLS: ReadonlyMap<string, string> = new Map();
/** The hrefs `ownUrls` left out of OWN_URLS for the DOM at hand ('' when none): part of the list cache's key. */
let OWN_DROPPED = '';

/** J19 extended (CONTRACT §11, Round-4 verification decisions): the letters and symbols that render blank (M2 of round 6:
 *  U+FFFC as well; bench/verify/v6-vr-blank.mjs). */
const BLANK_GLYPHS: ReadonlySet<number> = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xfffc]);
const VISIBLE_CP = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
/** J19 extended — THE test of whether a URL the serializer writes (a link destination, an image source, a bare URL, an
 *  autolink) may hold the code point `c` raw where its href holds the percent-escape: only a plainly visible one (a
 *  letter, digit, punctuation or symbol, L / N / P / S, but not one of BLANK_GLYPHS). Every control, format character,
 *  space separator, line / paragraph separator, mark, private-use, unassigned or non-character code point stays an
 *  escape — except a marker-range character the block's source writes raw (PUA_RAW, J19 of round 4) and U+0020, which
 *  the callers' own whitespace rules handle as before (a destination with one is kept whole, a URL text with one is
 *  neither bare nor an autolink). */
function rawInUrl(c: string): boolean {
  if (c === ' ') return true;
  if (MARKER_CHARS.test(c)) return PUA_RAW.includes(c);
  return VISIBLE_CP.test(c) && !BLANK_GLYPHS.has(c.codePointAt(0)!);
}

/** S1 / the guard (CONTRACT §11, Round-5 verification decisions): `c` (one code point) is plainly visible — the visibility
 *  of `rawInUrl`: a letter, digit, punctuation or symbol with ink. A marker-range character (private use) never is. */
export function plainlyVisible(c: string): boolean {
  return c !== ' ' && !MARKER_CHARS.test(c) && rawInUrl(c);
}
const ONLY_LNPS = /^[\p{L}\p{N}\p{P}\p{S} \n\t]*$/u;
const BLANK_CHARS = Array.from(BLANK_GLYPHS, (cp) => String.fromCodePoint(cp));
/** The guard's quick test: may `s` hold a character that is neither plainly visible nor U+0020, a line feed or a tab? */
export function holdsInvisible(s: string): boolean {
  return !ONLY_LNPS.test(s) || BLANK_CHARS.some((b) => s.includes(b));
}
const NBSP = String.fromCharCode(0xa0);
/** S1: a character that can be in HIDDEN — not plainly visible, and not U+0020, a line feed, a tab or U+00A0 (K26). */
const hideable = (c: string): boolean => c !== '\n' && c !== '\t' && c !== NBSP && c !== ' ' && !plainlyVisible(c);

/** S1 / S2: HIDDEN of the block being serialized (SerializeHints.hidden): character → the reference it is written as. Set
 *  with the markers (`pickMarkers`). */
const NO_HIDDEN: ReadonlyMap<string, string> = new Map();
let HIDDEN: ReadonlyMap<string, string> = NO_HIDDEN;
/** The reference HIDDEN gives the code point starting at `i` of `s`, or undefined. */
function hiddenAt(s: string, i: number): string | undefined {
  return HIDDEN.get(String.fromCodePoint(s.codePointAt(i)!));
}
/** Is the code point ending right before `i` of `s` in HIDDEN? */
function hiddenBefore(s: string, i: number): boolean {
  let k = i - 1;
  const lo = s.charCodeAt(k);
  if (k > 0 && lo >= 0xdc00 && lo <= 0xdfff) { const hi = s.charCodeAt(k - 1); if (hi >= 0xd800 && hi <= 0xdbff) k--; }
  return hiddenAt(s, k) !== undefined;
}
/** S2: `s` with every HIDDEN character written as its reference (for an output that reads character references and has
 *  no other escaping of them to do: alt, titles, attribute values, a raw `<code>`, a fence's language). */
function hiddenRefs(s: string): string {
  if (HIDDEN.size === 0) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    const r = HIDDEN.get(String.fromCodePoint(cp));
    const len = cp > 0xffff ? 2 : 1;
    if (r !== undefined) { out += s.slice(last, i) + r; last = i + len; }
    i += len - 1;
  }
  return last === 0 ? s : out + s.slice(last);
}
/** B3 (CONTRACT §11, Checkpoint H): the block source's own reference spelling of U+00A0 outside code
 *  (SerializeHints.nbspRef), or null. Set with the markers (`pickMarkers`). */
let NBSP_REF: string | null = null;
/** S2 + B3, for the image alt, the link and image titles and the attribute values of raw HTML: `s` with every HIDDEN
 *  character and, when the source spells it as a reference (NBSP_REF), every U+00A0 written as its reference (the text
 *  writer keeps keepNbsp, K26). */
function attrRefs(s: string): string {
  const t = hiddenRefs(s);
  return NBSP_REF !== null && t.includes(NBSP) ? t.split(NBSP).join(NBSP_REF) : t;
}

/** The marker-range characters of `s`, each once ('' when none). */
function markerCharsOf(s: string): string {
  if (!MARKER_CHARS.test(s)) return '';
  const seen = new Set<string>();
  for (const c of s) if (MARKER_CHARS.test(c)) seen.add(c);
  return [...seen].join('');
}

/** Sets NL / CARET / CELL / MARKUP to four characters that occur nowhere in what the serialization of `el` can hold
 *  (text, attribute values, link destinations as `linkDest` writes them; `puaRaw`: see SerializeHints). False when
 *  there are not four such characters (the block is refused). */
function pickMarkers(el: Element, puaRaw = '', urls: ReadonlyArray<[string, string, number]> = [], hidden: ReadonlyMap<string, string> = NO_HIDDEN, nbspRef: string | null = null): boolean {
  PUA_RAW = puaRaw;
  HIDDEN = hidden;
  NBSP_REF = nbspRef;
  OWN_URLS = ownUrls(el, urls);
  // The HTML serialization holds every text and attribute value; it escapes none of these characters. A link's
  // href and an image's src are percent-encoded there, but `linkDest` may write them decoded (J19): what it
  // writes counts too.
  let html = el.innerHTML;
  for (const e of Array.from(el.querySelectorAll('[href*="%"], [src*="%"]'))) {
    for (const a of ['href', 'src']) {
      const v = e.getAttribute(a);
      if (v !== null && v.includes('%')) html += decodedDest(v);
    }
  }
  for (const [, u] of OWN_URLS) html += u;   // (a URL the serializer writes in the source's spelling)
  if (!MARKER_CHARS.test(html)) { NL = '\uE000'; CARET = '\uE001'; CELL = '\uE002'; MARKUP = '\uE003'; return true; }
  const u = new Set<number>();
  for (let i = 0; i < html.length; i++) u.add(html.charCodeAt(i));
  const free: string[] = [];
  for (const [lo, hi] of MARKER_RANGES) for (let c = lo; c <= hi && free.length < 4; c++) if (!u.has(c)) free.push(String.fromCharCode(c));
  if (free.length < 4) return false;
  [NL, CARET, CELL, MARKUP] = free;
  return true;
}

/** C1 / C2 (CONTRACT §11, checkpoint F): the source spellings (`sourceUrls`: [href, spelling, the links and images of
 *  the source's own rendering with that href]) the writer may use for the block DOM `el`. A spelling that holds a
 *  character `rawInUrl` rejects is left out when more links and images of `el` carry its href than the source's own
 *  rendering has: one of them is not spelled by this block's source (a reference link defined in another block, a link
 *  made or split in the session), and the spelling must not reach it. Sets OWN_DROPPED. */
function ownUrls(el: Element, urls: ReadonlyArray<[string, string, number]>): Map<string, string> {
  const own = new Map<string, string>();
  const dropped: string[] = [];
  let dom: Map<string, number> | null = null;
  for (const [href, spell, n] of urls) {
    if (Array.from(spell).every(rawInUrl)) { own.set(href, spell); continue; }
    if (dom === null) {
      dom = new Map();
      for (const e of Array.from(el.querySelectorAll('a[href], img[src]'))) {
        const u = e.getAttribute(e.tagName === 'IMG' ? 'src' : 'href') ?? '';
        dom.set(u, (dom.get(u) ?? 0) + 1);
      }
    }
    if ((dom.get(href) ?? 0) <= n) own.set(href, spell);
    else dropped.push(href);
  }
  OWN_DROPPED = dropped.join('\n');
  return own;
}

/**
 * Thrown by `serializeBlock` and `serializeBlockWithCaret` when the block holds so many marker code points
 * that no four of them are free (`pickMarkers` fails; H15): nothing is serialized, because the stale markers
 * of an earlier call are characters of this block. The block is refused (reason 'markers', as
 * `unsupportedReason` says at a session start) and nothing is written.
 */
export class NoMarkersError extends Error {
  constructor() {
    super('serialize: no free internal marker set in this block');
    this.name = 'NoMarkersError';
  }
}

/**
 * P-G (b): thrown by `serializeBlock` and `serializeBlockWithCaret` when the Markdown of an atom of the block cannot be
 * established (a formula holding KaTeX output with neither the session's stamp nor KaTeX's annotation: its TeX is never
 * guessed from the rendered text). A NoMarkersError, so every caller takes the refusal path that exists: nothing is
 * written for the block (at a session start the block is refused; in a session the session ends, the block re-renders
 * from its unchanged source and the toast 此块请在源码中编辑 shows).
 */
export class AtomUnknownError extends NoMarkersError {
  constructor() {
    super();
    this.message = 'serialize: an atom of this block has no Markdown that survived the browser (P-G)';
    this.name = 'AtomUnknownError';
  }
}

// ---------------------------------------------------------------- P-G: atoms survive the browser
// Chromium's own editing inside a session block re-creates the nodes it moves (MoveParagraph serializes them to markup
// and parses it again): attributes survive that; descendants that are not rendered (KaTeX's <annotation>) and live
// properties do not, and computed styles are baked into style attributes. So a session STAMPS its block's atoms when it
// prepares the DOM (stampAtoms, at every session start), and the serializer reads the stamps first when the hints say
// the DOM was stamped (`SerializeHints.stamped`). A stamp is the session's own statement: the sanitizer removes every
// data-md* / data-mdr-* name a document carries and the worker flags such a block (U10, U15); stampAtoms clears any it
// still finds before it stamps; the session clears them when it ends (clearStamps) and keeps them off the clipboard.
/** A formula's TeX, from the intact rendering (KaTeX's annotation, the `<code>` fallback, a KaTeX error's text). */
const TEX_STAMP = 'data-mdr-tex';
/** The presentation attributes (style, align, bgcolor, color, face, size, the Apple- class tokens) an element carried
 *  when the session prepared the DOM, as JSON: with `stamped`, exactly these are written (P-G c). */
const PRES_STAMP = 'data-mdr-ps';
/** The stamp attributes (for the session's clean-up and its clipboard path). */
export const STAMP_ATTRS: readonly string[] = [TEX_STAMP, PRES_STAMP];
export const STAMP_SELECTOR = '[data-mdr-tex], [data-mdr-ps]';
const PRES_ATTRS = ['style', 'align', 'bgcolor', 'color', 'face', 'size'];
const PRES_SELECTOR = '[style], [align], [bgcolor], [color], [face], [size], [class*="Apple-"]';
const APPLE_CLASS = /^Apple-/;

/** Removes every stamp inside `root`. */
export function clearStamps(root: Element): void {
  for (const e of Array.from(root.querySelectorAll(STAMP_SELECTOR))) for (const a of STAMP_ATTRS) e.removeAttribute(a);
}

/** P-G (a): stamps the atoms of a block's DOM as the session prepares it (the DOM is the worker's intact rendering):
 *  every formula with its TeX (where the rendering gives it: else none, and the serializer refuses the block), every
 *  element with its presentation attributes. Any stamp already present is cleared first (never a document's). */
export function stampAtoms(root: Element): void {
  clearStamps(root);
  for (const m of Array.from(root.querySelectorAll('.md-math'))) {
    if (m.parentElement?.closest('.md-math, .md-math-src') || !isFormula(m)) continue;
    const tex = formulaTex(m, false);
    if (tex !== null) m.setAttribute(TEX_STAMP, tex);
  }
  for (const e of Array.from(root.querySelectorAll(PRES_SELECTOR))) {
    if (e.closest('.md-math')) continue;        // KaTeX's own markup is never written (its formula is)
    const rec: Record<string, string> = {};
    for (const a of PRES_ATTRS) { const v = e.getAttribute(a); if (v !== null) rec[a] = v; }
    const apple = (e.getAttribute('class') ?? '').split(/\s+/).filter((t) => APPLE_CLASS.test(t));
    if (apple.length > 0) rec.class = apple.join(' ');
    e.setAttribute(PRES_STAMP, JSON.stringify(rec));
  }
}

/** M3 (CONTRACT §11, Round-5 verification decisions): the declarations a format command of the session takes off an element
 *  (Chromium's bold and italic commands: un-bold / un-italic remove them from the element, or from the part of it they
 *  split off, and leave its style attribute in place, `style=""` when nothing else is left). */
const FORMAT_PROPS = ['font-weight', 'font-style'] as const;
type FormatProp = (typeof FORMAT_PROPS)[number];
/** M3: the recorded style `rec` of an element `e` (inside the serialized `root`) whose live style attribute is `live`, less
 *  every FORMAT_PROPS declaration the record has and the live attribute no longer has (the user's un-bold / un-italic) —
 *  '' when nothing is left; null when that is none (the record is written as it is). An absent attribute takes nothing off
 *  (the browser's own clean-up of a join removes the attribute; a command leaves it).
 *  P2 (round 7, CONTRACT §11 Round-7 decisions): a property the command did not change for the element (its recorded value
 *  is the one the element now inherits: Chromium took a `normal` off that blocked the bold it put inside) leaves the
 *  record alone; and when the record's value comes from the CSS font shorthand, the shorthand's own word is edited
 *  (shorthandAfterFormat) instead of the shorthand being expanded into its longhands. */
function afterFormat(rec: string, live: string | null, e: Element, root: Element): string | null {
  if (live === null || live === rec) return null;
  const doc = e.ownerDocument;
  const lv = doc.createElement('span');
  lv.setAttribute('style', live);
  const rv = doc.createElement('span');
  rv.setAttribute('style', rec);
  const short = shorthandAfterFormat(rec, live, lv, e, root);
  if (short !== undefined) return short;
  let off = false;
  for (const p of FORMAT_PROPS) {
    const was = rv.style.getPropertyValue(p);
    if (was !== '' && lv.style.getPropertyValue(p) === '') {
      const now = inheritedFont(e, p, root);
      if (now !== null && sameFont(p, was, now)) continue;   // (P2: not changed for this element)
      rv.style.removeProperty(p);
      off = true;
    }
  }
  return off ? (rv.getAttribute('style') ?? '').trim() : null;
}

// ---------------------------------------------------------------- P2: the CSS font shorthand (round 7)
/** The declarations of a style text, split at the semicolons outside quotes and parentheses: each with its own text and
 *  its lower-cased property name ('' when it has no colon). Joined with ';' they give the text back. */
function styleDecls(text: string): Array<{ raw: string; name: string }> {
  const out: Array<{ raw: string; name: string }> = [];
  let q = '', depth = 0, from = 0;
  const push = (to: number): void => {
    const raw = text.slice(from, to);
    const colon = raw.indexOf(':');
    out.push({ raw, name: colon < 0 ? '' : raw.slice(0, colon).trim().toLowerCase() });
    from = to + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; }
    else if (c === ';' && depth === 0) push(i);
  }
  push(text.length);
  return out;
}
const declValue = (raw: string): string => raw.slice(raw.indexOf(':') + 1).trim();
const IMPORTANT = /!\s*important\s*$/i;
const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const FONT_STYLE_WORD = /^(?:italic|oblique)$/i;
const FONT_ANGLE = new RegExp(`^${NUM}(?:deg|grad|rad|turn)$`, 'i');
const FONT_WEIGHT_WORD = new RegExp(`^(?:bold|bolder|lighter|${NUM})$`, 'i');
const FONT_OTHER_WORD = /^(?:normal|small-caps|(?:ultra-|extra-|semi-)?(?:condensed|expanded))$/i;
const FONT_SIZE_WORD = new RegExp(`^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|math|${NUM}(?:[a-z]+|%))(?:/|$)`, 'i');
/** A `font` declaration read as its words before the size (style, variant, weight, stretch: at most four; `oblique` with its
 *  angle is one word) and the rest from the size on, as written. Null when it is not one this edit reads (a system font
 *  keyword, a global keyword, var(), !important, no size). */
interface FontShorthand { head: string; lead: string; words: string[]; rest: string; trail: string }
function fontShorthand(raw: string): FontShorthand | null {
  const colon = raw.indexOf(':');
  const value = raw.slice(colon + 1);
  const v = value.trim();
  if (colon < 0 || v === '' || IMPORTANT.test(v)) return null;
  const words: string[] = [];
  let rest: string | null = null;
  for (const m of v.matchAll(/\S+/g)) {
    const t = m[0];
    const last = words.length > 0 ? words[words.length - 1] : '';
    if (FONT_ANGLE.test(t) && /^oblique$/i.test(last)) words[words.length - 1] = last + ' ' + t;
    else if (FONT_STYLE_WORD.test(t) || FONT_WEIGHT_WORD.test(t) || FONT_OTHER_WORD.test(t)) words.push(t);
    else if (FONT_SIZE_WORD.test(t)) { rest = v.slice(m.index); break; }
    else return null;
  }
  if (rest === null || words.length > 4) return null;
  const lead = value.slice(0, value.length - value.trimStart().length);
  const trail = value.slice(value.trimEnd().length);
  return { head: raw.slice(0, colon + 1), lead, words, rest, trail };
}
const isWordOf = (p: FormatProp, w: string): boolean => (p === 'font-weight' ? FONT_WEIGHT_WORD.test(w) : FONT_STYLE_WORD.test(w.split(' ')[0]));
/** The shorthand's value of `p`: its own word, else 'normal' (the shorthand sets every font property). */
const shorthandWord = (sh: FontShorthand, p: FormatProp): string => sh.words.find((w) => isWordOf(p, w)) ?? 'normal';
/** Sets the shorthand's word of `p` to `v`: taken out when `v` is the initial value, else replacing it or put in. */
function setShorthandWord(sh: FontShorthand, p: FormatProp, v: string): boolean {
  sh.words = sh.words.filter((w) => !isWordOf(p, w));
  if (sameFont(p, v, 'normal')) return true;
  if (p === 'font-style') sh.words.unshift(v); else sh.words.push(v);
  if (sh.words.length > 4) {
    const k = sh.words.findIndex((w) => /^normal$/i.test(w));
    if (k < 0) return false;
    sh.words.splice(k, 1);
  }
  return true;
}
const shorthandText = (sh: FontShorthand): string => sh.head + sh.lead + [...sh.words, sh.rest].join(' ') + sh.trail;
/** The value of `p` a style text declares (the last declaration of `p` or of the font shorthand), '' when none; null when
 *  this edit does not read it (!important, a shorthand fontShorthand does not read). */
function declaredFont(text: string, p: FormatProp): string | null {
  let v = '';
  for (const d of styleDecls(text)) {
    if (d.name !== p && d.name !== 'font') continue;
    if (IMPORTANT.test(d.raw)) return null;
    if (d.name === p) { v = declValue(d.raw); continue; }
    const sh = fontShorthand(d.raw);
    if (sh === null) return null;
    v = shorthandWord(sh, p);
  }
  return v;
}
const BOLD_TAGS = /^(?:B|STRONG|TH|H[1-6])$/;
const ITALIC_TAGS = /^(?:I|EM|CITE|VAR|DFN|ADDRESS)$/;
const PLAIN_WEIGHT = new RegExp(`^(?:normal|bold|${NUM})$`, 'i');
const PLAIN_STYLE = new RegExp(`^(?:normal|italic|oblique(?: ${NUM}(?:deg|grad|rad|turn))?)$`, 'i');
/** What `e` inherits for `p` from the elements around it inside `root` (their style attributes as they will be written,
 *  else what their kind gives: bold for b, strong, th and the headings; italic for i, em, cite, var, dfn, address), 'normal'
 *  at the root; null when that is not a plain value (bolder, lighter, inherit, var(), unread). */
function inheritedFont(e: Element, p: FormatProp, root: Element): string | null {
  for (let a = e.parentElement; a !== null; a = a === root ? null : a.parentElement) {
    const st = a.getAttribute('style');
    if (st !== null) {
      const v = declaredFont(st, p);
      if (v === null) return null;
      if (v !== '') return (p === 'font-weight' ? PLAIN_WEIGHT : PLAIN_STYLE).test(v.replace(/\s+/g, ' ')) ? v : null;
    }
    if (p === 'font-weight' ? BOLD_TAGS.test(a.tagName) : ITALIC_TAGS.test(a.tagName)) return p === 'font-weight' ? 'bold' : 'italic';
  }
  return 'normal';
}
/** Two values of `p` are the same value (normal = 400, bold = 700; case and spaces aside). */
function sameFont(p: FormatProp, a: string, b: string): boolean {
  const n = (v: string): string => {
    const x = v.trim().toLowerCase().replace(/\s+/g, ' ');
    if (p !== 'font-weight') return x;
    if (x === 'normal') return '400';
    if (x === 'bold') return '700';
    return new RegExp(`^${NUM}$`).test(x) ? String(Number(x)) : x;
  };
  return n(a) === n(b);
}
/** P2: afterFormat for a record whose last `font` declaration is a shorthand fontShorthand reads. For every FORMAT_PROPS
 *  property the live attribute no longer has: left alone when the record's value is what the element now inherits (the
 *  command did not change it for the element); else the longhands of it after the shorthand go and the shorthand's word is
 *  set to the inherited value (taken out for normal: what un-bold and un-italic do; `bold` / `italic` where the element
 *  now takes them from around it). Undefined = not that case, or a value this edit cannot write (afterFormat's longhand
 *  path then, as in round 6). */
function shorthandAfterFormat(rec: string, live: string, lv: HTMLElement, e: Element, root: Element): string | null | undefined {
  const decls = styleDecls(rec);
  let at = -1;
  for (let k = 0; k < decls.length; k++) if (decls[k].name === 'font') at = k;
  if (at < 0) return undefined;
  const sh = fontShorthand(decls[at].raw);
  if (sh === null || decls.some((d) => (d.name === 'font' || (FORMAT_PROPS as readonly string[]).includes(d.name)) && IMPORTANT.test(d.raw))) return undefined;
  const drop = new Set<number>();
  let off = false;
  for (const p of FORMAT_PROPS) {
    if (lv.style.getPropertyValue(p) !== '' || declaredFont(live, p) !== '') continue;   // (the live attribute still has it)
    let was = shorthandWord(sh, p);
    for (let k = at + 1; k < decls.length; k++) if (decls[k].name === p) was = declValue(decls[k].raw);
    const now = inheritedFont(e, p, root);
    if (now === null) return undefined;
    if (sameFont(p, was, now)) continue;
    for (let k = at + 1; k < decls.length; k++) if (decls[k].name === p) drop.add(k);
    if (!setShorthandWord(sh, p, now)) return undefined;
    off = true;
  }
  if (!off) return null;
  return decls.map((d, k) => (k === at ? shorthandText(sh) : d.raw)).filter((_, k) => !drop.has(k)).join(';').trim();
}

/** P-G (c), on the clone of a stamped DOM: every element's presentation attributes are the ones its stamp records (none
 *  without a stamp: the browser invented them), on every element kind; Apple- class tokens likewise. M3: less the
 *  declarations a format command took off (afterFormat). */
function presentationAsPrepared(root: Element): void {
  for (const e of Array.from(root.querySelectorAll(PRES_SELECTOR + ', [data-mdr-ps]'))) {
    let rec: Record<string, unknown> = {};
    const raw = e.getAttribute(PRES_STAMP);
    if (raw !== null) { try { const v: unknown = JSON.parse(raw); if (v && typeof v === 'object') rec = v as Record<string, unknown>; } catch { /* none */ } }
    for (const a of PRES_ATTRS) {
      const v = rec[a];
      const w = typeof v === 'string' && a === 'style' ? afterFormat(v, e.getAttribute('style'), e, root) : null;
      if (w === '') e.removeAttribute(a);
      else if (w !== null) e.setAttribute(a, w);
      else if (typeof v === 'string') e.setAttribute(a, v); else e.removeAttribute(a);
    }
    const cls = e.getAttribute('class');
    if (cls !== null) {
      const own = typeof rec.class === 'string' ? rec.class.split(' ') : [];
      const kept = cls.split(/\s+/).filter((t) => t !== '' && (!APPLE_CLASS.test(t) || own.includes(t)));
      if (kept.length === 0) e.removeAttribute('class'); else if (kept.join(' ') !== cls) e.setAttribute('class', kept.join(' '));
    }
    e.removeAttribute(PRES_STAMP);
  }
}

export interface SerializeHints {
  /** Code blocks: the block's own source fence, reproduced verbatim when the block is one fence
   *  (`close: null` = the fence was never closed). `indent` = an indented code block's indentation. */
  fence?: { open: string; close: string | null } | { indent: string };
  /** `$` is escaped in text (the math rules are on). Default true. */
  math?: boolean;
  /** The DOM is being edited: inline wrappers the browser invents (a bare `<span style>` / `<font>`
   *  without `data-mdr-o`, a `<div>` paragraph) are unwrapped instead of kept as raw HTML. */
  editing?: boolean;
  /** The block's source puts content directly under its ATX headings (no blank line in between): the
   *  serialization keeps it that way instead of inserting one (which would also split the block). */
  tightHeadings?: boolean;
  /** The block's own table delimiter row (`|---|:-:|`), reused verbatim while the serialized table has
   *  the same columns and alignment. */
  tableDelim?: string;
  /** The block's source writes non-breaking spaces (`&nbsp;`): every one in the DOM is kept as `&nbsp;`
   *  (a run of spaces keeps its NBSPs), except one at a line end and a lone one at a text node's edge.
   *  Without it only a single NBSP between two non-space characters is kept (typing never makes one). */
  keepNbsp?: boolean;
  /** Bypass the per-item list cache and serialize the block in one pass (tests and benchmarks compare
   *  the two; the output must be byte-identical). */
  uncached?: boolean;
  /** The texts of the autolinks the block's source writes as `<url>` / `<a@b.c>` (sourceStyleHints, always
   *  set there): such a link is written `<url>` again while that is still a valid autolink for it, any other
   *  link whose text is its URL bare wherever that is proven (U11, INV 2). Without the hint (the source is not
   *  known) a URL with a Markdown character in it (`*_~$&<\` …) prefers `<url>`. */
  autolinks?: string[];
  /** J19 extended: the URLs the block's source writes, [href, the source's literal spelling, the links and images of
   *  the source's own rendering with that href] (sourceStyleHints, sourceUrls; C1 and C2: only an href every place of
   *  the source spells literally and alike has one): a link destination, image source, autolink or bare URL whose href
   *  is one of them is written in the source's own spelling (while that reads back as the same link), so none of its
   *  escapes or characters changes. */
  urlSpellings?: Array<[string, string, number]>;
  /** P-G: the session stamped the block's DOM when it prepared it (stampAtoms): a formula's TeX is its stamp, and only
   *  the presentation attributes the stamps record are written. */
  stamped?: boolean;
  /** The marker-range characters (Private Use Area, U+FDD0…U+FDEF) the block's source writes raw (sourceStyleHints):
   *  a link or image destination's percent-escape of one of them is written as that character, any other stays an
   *  escape (the same href; an invisible character the source does not hold is never written; J19). */
  puaRaw?: string;
  /** S1 (CONTRACT §11, Round-5 verification decisions): HIDDEN — the characters that are not plainly visible and that the
   *  block's rendering shows more often than its source holds them raw (the source spells them as a character reference,
   *  or as a percent-escape of a bare URL or autolink the rendering shows decoded), each with the reference it is written
   *  as: the source's own first spelling, else `&#xHHHH;` (sourceStyleHints, sourceHidden). S2: every writer whose output
   *  reads character references (text, link text included; image alt; link and image titles; attribute values of raw
   *  HTML; a raw `<code>`; a fence's language) writes every occurrence of one as its reference. URL texts keep their
   *  percent-escapes (urlText); code and TeX are not changed. B1 (Checkpoint H): also every such character the source,
   *  outside code, spells as a reference or as a percent-escape a bare URL or autolink shows decoded, whatever its raw
   *  count, when the rendering shows it. */
  hidden?: ReadonlyMap<string, string>;
  /** B2 (CONTRACT §11, Checkpoint H): for the HIDDEN characters the block's source holds raw inside code (code spans,
   *  code blocks, formula TeX: where no reference is read), how many times (sourceStyleHints). The session's guard lets
   *  its Markdown hold a HIDDEN character raw no more often than that plus what the user put in (inlineEdit.ts). */
  hiddenCode?: ReadonlyMap<string, number>;
  /** B3 (CONTRACT §11, Checkpoint H): the block source's own first reference spelling of U+00A0 outside code
   *  (sourceStyleHints): the image alt, the link and image titles and the attribute values of raw HTML write every
   *  U+00A0 in it (the text keeps keepNbsp, K26). */
  nbspRef?: string;
}

// ---------------------------------------------------------------- element classes
const BLOCK_CONTAINERS = new Set(['SECTION', 'ARTICLE', 'DIV', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);
/** Elements a text line starts in (Markdown block constructs are recognised at their start). */
const LINE_CONTAINERS = new Set(['P', 'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'DIV']);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CELLS = new Set(['TD', 'TH']);
const LINKS = new Set(['A']);
const BLOCKISH = new Set([...BLOCK_CONTAINERS, ...LINE_CONTAINERS, ...HEADINGS, ...CELLS, 'PRE', 'HR', 'LI', 'P']);
/** Inline elements with a Markdown rule of their own. Everything else inline is kept as raw HTML. */
const MD_INLINE = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'DEL', 'S', 'STRIKE', 'IMG', 'BR', 'INPUT']);
/** Block elements the serializer understands; any other block element makes a block non-editable. */
const MD_BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR']);
/** Inline HTML that markdown-it passes through and the serializer re-emits verbatim (sanitized tag set). */
const RAW_INLINE_OK = new Set(['KBD', 'SUP', 'SUB', 'MARK', 'U', 'SMALL', 'ABBR', 'INS', 'Q', 'CITE', 'SPAN', 'VAR', 'SAMP', 'TIME', 'DFN', 'BDI', 'BDO', 'RUBY', 'RT', 'RP', 'WBR', 'FONT', 'BIG', 'TT', 'EM', 'STRONG', 'B', 'I', 'S', 'DEL', 'A', 'IMG', 'CODE', 'BR', 'INPUT']);

const isWsChar = (c: string): boolean => c === '' || /\s/.test(c);
/** A code language containing one of these is not written into the fence line (U10 e). */
const UNSAFE_LANG = /[\s\p{Cc}]/u;
/** C0 controls but the tab, and DEL: a numeric character reference gives them back unchanged. */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const CONTROLS = /[\x00-\x08\x0a-\x1f\x7f]/g;
const isAlnum = (c: string): boolean => c !== '' && /[\p{L}\p{N}]/u.test(c);
const isPunct = (c: string): boolean => c !== '' && /[\p{P}\p{S}]/u.test(c);
/** First / last code point of a string ('' when empty) — emoji are surrogate pairs. */
const firstCp = (s: string): string => (s.length === 0 ? '' : String.fromCodePoint(s.codePointAt(0)!));
const lastCp = (s: string): string => {
  if (s.length === 0) return '';
  const lo = s.charCodeAt(s.length - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && s.length > 1 ? s.slice(-2) : s.slice(-1);
};
/** `s` without its trailing characters from `chars`. A loop: a `/[…]+$/` regex retries at every position of
 *  an inner run of those characters, which is quadratic in the run's length (G6). */
function trimEndOf(s: string, chars: string): string {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return e === s.length ? s : s.slice(0, e);
}
function trimStartOf(s: string, chars: string): string {
  let b = 0;
  while (b < s.length && chars.includes(s[b])) b++;
  return b === 0 ? s : s.slice(b);
}

// ---------------------------------------------------------------- guard
/**
 * Why this block cannot be edited in the preview (null = it can). The serializer reproduces the
 * block's rendering only for the element set above; a block containing anything else (raw block-level
 * HTML such as `<details>`, a PLAIN fallback, a render error) is left to the source editor, as are
 * sources the DOM cannot express (HTML comments, reference definitions — they render to nothing).
 */
export function unsupportedReason(el: Element, source?: string): string | null {
  // The block's raw HTML carries a name the app reserves (CONTRACT §11, U10 c): set by createPreview.
  if (el.closest('[data-mdr-x]')) return 'reserved';
  if (el.querySelector('.md-error, .md-plain, .md-plain__note, .md-code--plain')) return 'plain';
  if (!pickMarkers(el, source !== undefined ? markerCharsOf(source) : '')) return 'markers';
  const walk = (n: Element): string | null => {
    for (const c of Array.from(n.children)) {
      if (c.classList.contains('md-math') || c.classList.contains('md-math-src')) continue;
      if (c.classList.contains('md-codewrap')) { const r = walk(c); if (r) return r; continue; }
      const t = c.tagName;
      if (MD_BLOCK.has(t)) {
        // a code language goes into the fence line: one that could break out of it is not written (U10 e)
        if (t === 'PRE') { if (UNSAFE_LANG.test(c.getAttribute('data-lang') ?? '')) return 'lang'; continue; }
        const r = walk(c);
        if (r) return r;
        continue;
      }
      if (RAW_INLINE_OK.has(t)) {
        if (t === 'INPUT' && (c as HTMLInputElement).type !== 'checkbox') return 'input';
        const r = walk(c);
        if (r) return r;
        continue;
      }
      return `element:${t.toLowerCase()}`;
    }
    return null;
  };
  const r = walk(el);
  if (r) return r;
  if (source !== undefined) {
    if (stripCode(source).includes('<!--')) return 'comment';
    // A link reference definition renders to nothing, so a serialization would silently delete it.
    if (/^[ \t>*+\-\d.)]*\[(?:\\.|[^\]\\\n])+\]:/m.test(source)) return 'reference';
  }
  return null;
}

/** `source` without its fenced code and code spans (their `<!--` is literal text, not a comment). */
function stripCode(source: string): string {
  if (!source.includes('`') && !source.includes('~~~')) return source;
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of source.split('\n')) {
    const m = /^[ \t>*+\-\d.)]*?(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^[ \t>]*[`~]+[ \t]*$/.test(line)) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return dropCodeSpans(out.join('\n'));
}

/**
 * `s.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, '')` in linear time (that regex retries every shorter opener at every
 * position of a backtick run without a closer: quadratic, J20). Same result for every input: an attempt at `p`
 * (the rest of its run is L backticks) takes the longest k ≤ L that has a closer — the next k backticks, which
 * are its own run's when 2k ≤ L, else the start of the first later run of at least k — and removes up to the
 * closer's end; it fails only when L = 1 and no backtick follows.
 */
export function dropCodeSpans(s: string): string {
  const starts: number[] = [], lens: number[] = [];
  for (let i = s.indexOf('`'); i >= 0 && i < s.length; i = s.indexOf('`', i)) {
    let j = i;
    while (j < s.length && s.charCodeAt(j) === 96) j++;
    starts.push(i);
    lens.push(j - i);
    i = j;
  }
  if (starts.length === 0) return s;
  const laterMax: number[] = new Array(starts.length + 1).fill(0);   // the longest run after run r
  for (let r = starts.length - 1; r > 0; r--) laterMax[r - 1] = Math.max(lens[r], laterMax[r]);
  let out = '';
  let kept = 0;   // start of the text not removed yet
  let r = 0;
  let p = starts[0];
  while (r < starts.length) {
    if (p < starts[r]) p = starts[r];
    const L = starts[r] + lens[r] - p;
    const k = Math.max(L >> 1, Math.min(L, laterMax[r]));
    if (k === 0) break;
    let q = p + k;
    if (2 * k > L) {
      r++;
      while (lens[r] < k) r++;
      q = starts[r];
    }
    out += s.slice(kept, p);
    kept = p = q + k;
    if (p >= starts[r] + lens[r]) r++;
  }
  return out + s.slice(kept);
}

// ---------------------------------------------------------------- text escaping
interface TextCtx {
  lineStart: boolean; inCell: boolean; inHeading: boolean; headingEnd: boolean; prev: string; next: string; math: boolean;
  /** The text is inside a link (its `]` would end the link text). */
  inLink: boolean;
  /** Counts over the whole inline context (see `inlineInfo`): `$` characters, `~` characters. */
  dollars: number; tildes: number;
  /** The context has no `]` and no link / image: a `[` cannot start a link, reference or task marker. */
  bracketFree: boolean;
}

/** A real space: a non-breaking space may become `&nbsp;` (not whitespace to the Markdown parser). */
const isSp = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === NL;
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/** Escapes one line segment of inline text so markdown-it reads it back as the same literal text. */
function escapeSegment(s: string, c: TextCtx, prev: string, next: string, lineStart: boolean, lineEnd: boolean, edgeLead = false, edgeTrail = false): string {
  let out = '';
  // the run of tildes around `i`, found once per run (rescanning it for each of its tildes was quadratic, G6)
  let ta = 0, tb = 0;
  // `edgeLead` / `edgeTrail`: the segment starts / ends an inline element's content. turndown moves (or
  // collapses) the whitespace at those edges out of the element, so the character next to that whitespace
  // ends up next to the element's delimiter: it is escaped as such (`*a * b*` with the `b` deleted, check item 7).
  let lead = -1, trail = -1;
  if (edgeLead) { lead = 0; while (lead < s.length && /\s/.test(s[lead])) lead++; }
  if (edgeTrail) { trail = s.length - 1; while (trail >= 0 && /\s/.test(s[trail])) trail--; }
  // S2: a HIDDEN character goes out as its reference: next to it the Markdown has the reference's `;` / `&`
  const hid = HIDDEN.size > 0;
  if (hid && HIDDEN.has(prev)) prev = ';';
  if (hid && HIDDEN.has(next)) next = '&';
  const pAt = (i: number): string => (i === lead ? MARKUP : i > 0 ? (hid && hiddenBefore(s, i) ? ';' : s[i - 1]) : prev);
  const nAt = (i: number): string => (i === trail ? MARKUP : i + 1 < s.length ? (hid && hiddenAt(s, i + 1) !== undefined ? '&' : s[i + 1]) : next);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const p = pAt(i);
    const n = nAt(i);
    switch (ch) {
      case '\\':
        out += n === '' || n === NL || n === MARKUP || n === '\n' || n === '\r' || n === '\u00a0' || ASCII_PUNCT.test(n) ? '\\\\' : '\\';
        break;
      case '`': out += '\\`'; break;
      case '*': out += isSp(p) && isSp(n) ? '*' : '\\*'; break;
      case '_': out += isAlnum(p) && isAlnum(n) ? '_' : '\\_'; break;
      case '~': {
        // A run of tildes is a strikethrough delimiter only with a second run (or a <del>'s `~~`) in the
        // same inline context, a fence only at a line start: the context's ONLY run stays as typed.
        if (i >= tb) { ta = i; tb = i + 1; while (tb < s.length && s[tb] === '~') tb++; }
        const a = ta, b = tb;
        const before = pAt(a), after = nAt(b - 1);
        const sole = !c.inLink && c.tildes === b - a && before !== MARKUP && after !== MARKUP;
        const fence = lineStart && i === a && b - a >= 3 && /^[ \t]*$/.test(s.slice(0, a));
        out += !sole ? (p === '~' || n === '~' || p === MARKUP || n === MARKUP ? '\\~' : '~') : fence ? '\\~' : '~';
        break;
      }
      // With every `[` escaped a `]` cannot close anything — except the text of a link it is inside.
      case '[': out += c.bracketFree ? '[' : '\\['; break;
      case ']': out += c.inLink ? '\\]' : ']'; break;
      case '!': out += n === MARKUP ? '\\!' : '!'; break;   // `!` + a link's `[` would be an image
      case '<': out += n === '' || /[A-Za-z/!?]/.test(n) ? '\\<' : '<'; break;
      case '&': out += ENTITY.test(s.slice(i)) ? '\\&' : '&'; break;
      // Math needs two `$` in one inline context (`$…$`, `$$…$$`, a `$$` block line): the only one stays.
      case '$': out += c.math && c.dollars > 1 && n !== '' && !isSp(n) ? '\\$' : '$'; break;
      case '|': out += c.inCell ? '\\|' : '|'; break;
      default: {
        const r = hid ? hiddenAt(s, i) : undefined;
        if (r === undefined) { out += ch; break; }
        out += r;
        if (s.codePointAt(i)! > 0xffff) i++;
      }
    }
  }
  if (lineStart && !c.inCell && !c.inHeading) {
    out = out
      .replace(/^([ \t]*)(#{1,6})(?=[ \t\u00a0]|$)/, '$1\\$2')
      .replace(/^([ \t]*)>/, '$1\\>')
      .replace(/^([ \t]*)([-+])(?=[ \t\u00a0]|$)/, '$1\\$2')
      .replace(/^([ \t]*)(\d{1,9})([.)])(?=[ \t\u00a0]|$)/, '$1$2\\$3')
      .replace(/^([ \t]*)(=+|-+)([ \t\u00a0]*)$/, '$1\\$2$3')
      // three or more `-` (`*`, `_` left unescaped) with spaces between them are a thematic break (`-- -`, G18)
      .replace(/^([ \t]*)([-*_])(?=(?:[ \t\u00a0]*\2){2,}[ \t\u00a0]*$)/, '$1\\$2')
      // a table delimiter row (`:-`, `|--|`) would turn the line above into a table header
      // (`(?=([ \t]*))\1`: the indentation taken whole, no backtracking into it \u2014 that retried the lookahead at
      // every position of a long run of tabs or spaces, quadratic, J20; the same matches, the same groups)
      .replace(/^(?=([ \t]*))\1(?=\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t\u00a0]*$)(\S)/, '$1\\$3');
  }
  // a closing `#` sequence; a non-breaking space next to it becomes a space or goes at the line end (fixNbsp, G19)
  if (lineEnd && c.headingEnd) out = out.replace(/(^|[ \t\u00a0])(#+)([ \t\u00a0]*)$/, '$1\\$2$3');
  return out;
}

/** Non-breaking spaces. The browser uses them to keep typed spaces visible — next to another space, at a
 *  line edge, at the end of a text node — but never between two non-space characters of one text node
 *  (Chromium rebalances those to a plain space; bench/verify/fixC-nbsp.mjs). So a single NBSP between two
 *  non-space characters is the document's own (`&nbsp;`) and is kept; a run of them or one at a line start
 *  is kept as `&nbsp;` too, one at a line end is dropped, any other single one (next to a space or at a
 *  text node's edge) is a space. */
function fixNbsp(s: string, lineStart: boolean, lineEnd: boolean, keepAll = false): string {
  if (s.indexOf('\u00a0') < 0) return s;
  // A whole line (paragraph, cell) that is only non-breaking spaces is the document's spacer: dropping
  // them would delete the line (G9).
  if (keepAll && lineStart && lineEnd && /^[ \u00a0]+$/.test(s)) return trimEndOf(trimStartOf(s, ' '), ' ').replace(/\u00a0/g, '&nbsp;');
  let t = s;
  if (lineEnd) t = trimEndOf(t, '\u00a0 ');
  if (lineStart) t = t.replace(/^[\u00a0]+/, (m) => '&nbsp;'.repeat(m.length));
  return t.replace(/[ \u00a0]+/g, (m, off: number, str: string) => {
    if (m.indexOf('\u00a0') < 0) return m;
    if (keepAll) return m === '\u00a0' && (off === 0 || off + 1 === str.length) ? ' ' : m.replace(/\u00a0/g, '&nbsp;');
    if (/^\u00a0{2,}$/.test(m)) return '&nbsp;'.repeat(m.length);
    if (m === '\u00a0' && off > 0 && off + 1 < str.length && !isWsChar(str[off - 1]) && !isWsChar(str[off + 1])) return '&nbsp;';
    return ' ';
  });
}

// ---------------------------------------------------------------- DOM helpers
function isBlockEl(n: Node | null): boolean {
  return !!n && n.nodeType === 1 && (BLOCKISH.has((n as Element).tagName) || (n as Element).hasAttribute('data-md-block'));
}

/** The first / last visible character next to `node` inside its line container ('' = a line edge). */
function neighbourChar(node: Node, dir: -1 | 1): string {
  let cur: Node | null = node;
  while (cur) {
    let sib: Node | null = dir < 0 ? cur.previousSibling : cur.nextSibling;
    while (sib) {
      if (sib.nodeType === 3) {
        const d = (sib as Text).data;
        if (d.length > 0) return dir < 0 ? lastCp(d) : firstCp(d);
      } else if (sib.nodeType === 1) {
        const e = sib as Element;
        if (isBlockEl(e) || e.tagName === 'BR') return '';
        if (e.hasAttribute('data-md')) return 'x';
        if (e.tagName === 'IMG' || e.tagName === 'INPUT') return 'x';
        const t = e.textContent ?? '';
        if (t.length > 0) return dir < 0 ? lastCp(t) : firstCp(t);
      }
      sib = dir < 0 ? sib.previousSibling : sib.nextSibling;
    }
    const parent: Node | null = cur.parentNode;
    if (!parent || parent.nodeType !== 1 || isBlockEl(parent)) return '';
    cur = parent;
  }
  return '';
}

/** The Markdown character next to a text node: its neighbour's text, MARKUP where an inline element's
 *  delimiter sits (the element next to it, or the end of the element it is in), '' at a line edge. */
function mdNeighbour(node: Node, dir: -1 | 1): string {
  const sib = dir < 0 ? node.previousSibling : node.nextSibling;
  if (sib) {
    if (sib.nodeType === 3) { const d = (sib as Text).data; return d.length ? (dir < 0 ? d[d.length - 1] : d[0]) : ''; }
    if (sib.nodeType !== 1) return '';
    const e = sib as Element;
    return isBlockEl(e) || e.tagName === 'BR' ? '' : MARKUP;
  }
  const parent = node.parentNode;
  if (!parent || parent.nodeType !== 1 || isBlockEl(parent)) return '';
  return MARKUP;
}

/** Does the text node start a Markdown line (nothing but inline wrappers between it and its line container)? */
function startsLine(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    let sib = cur.previousSibling;
    while (sib && sib.nodeType === 3 && (sib as Text).data.length === 0) sib = sib.previousSibling;
    if (sib) return sib.nodeType === 1 && ((sib as Element).tagName === 'BR' || isBlockEl(sib));
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1) return true;
    const t = (parent as Element).tagName;
    if (LINE_CONTAINERS.has(t) || isBlockEl(parent)) return true;
    cur = parent;
  }
}

function closestTag(node: Node, tags: Set<string>, stop: Element): Element | null {
  let cur = node.parentNode;
  while (cur && cur !== stop && cur.nodeType === 1) {
    if (tags.has((cur as Element).tagName)) return cur as Element;
    cur = cur.parentNode;
  }
  return null;
}

/** Text of a `pre` as the browser shows it: text nodes, `<br>` and block children as line breaks. */
export function codeText(pre: Element): string {
  let out = '';
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) out += (c as Text).data;
      else if (c.nodeType === 1) {
        const t = (c as Element).tagName;
        if (t === 'BR') out += '\n';
        else if (t === 'DIV' || t === 'P') {
          if (out.length > 0 && !out.endsWith('\n')) out += '\n';
          walk(c);
          if (!out.endsWith('\n')) out += '\n';
        } else walk(c);
      }
    }
  };
  walk(pre);
  return out.replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ');
}

/** TeX of a formula (`isFormula`): an edit-mode source element's text; the session's stamp (`stamped`, P-G a); KaTeX's
 *  annotation; the escaped `<code>` fallback markdown-it emits before KaTeX loads; a KaTeX error's text (the TeX as
 *  it shows). null when none of them is there (P-G b: never the rendered text of KaTeX output). */
export function formulaTex(m: Element, stamped: boolean): string | null {
  if (m.classList.contains('md-math-src')) return codeText(m).replace(/[\u200b\ufeff]/g, '');
  if (stamped && m.hasAttribute(TEX_STAMP)) return m.getAttribute(TEX_STAMP);
  const ann = m.querySelector('annotation[encoding="application/x-tex"]');
  if (ann) return ann.textContent ?? '';
  const code = m.querySelector('code');
  if (code) return code.textContent ?? '';
  if (m.querySelector('.katex')) return null;
  return m.querySelector('.katex-error') ? m.textContent ?? '' : null;
}

/** A formula as the worker renders it (KaTeX output, a KaTeX error, or the `<code>` fallback) or as a
 *  session swaps it in (`.md-math-src`); a `.md-math` element of any other shape is not one. */
function isFormula(m: Element): boolean {
  if (m.classList.contains('md-math-src')) return true;
  if (m.querySelector('.katex, .katex-error')) return true;
  return m.childElementCount === 1 && m.firstElementChild!.tagName === 'CODE' && (m.textContent ?? '') === (m.firstElementChild!.textContent ?? '');
}

function mathMarkdown(m: Element, stamped: boolean): { md: string; block: boolean } {
  const tex = formulaTex(m, stamped);
  if (tex === null) throw new AtomUnknownError();
  if (m.classList.contains('md-math--block')) return { md: `$$\n${trimEndOf(tex, '\n')}\n$$`, block: true };
  if (m.classList.contains('md-math--display')) return { md: `$$${tex}$$`, block: false };
  return { md: `$${inlineTex(tex)}$`, block: false };
}

/**
 * J22: the TeX of an inline `$…$` as it can be written. The worker's math rule (src/worker/math.ts) does not close
 * on a `$` that follows whitespace or a backslash, and no spelling of such TeX reads back: trailing whitespace
 * (space, tab, line feed: invisible at the end of a formula) is left out, and a TeX that then ends in a backslash
 * gets an empty group after it (`\ ` + `{}` for a lone one, which KaTeX renders like the control space the user
 * left; `{}` after `\\`). Only when that spelling is proven to read back as a formula with exactly that TeX;
 * a TeX the worker reads back as it is (every rendered formula's) is returned unchanged.
 */
function inlineTex(tex: string): string {
  const last = tex.charCodeAt(tex.length - 1);
  if (last !== 32 && last !== 9 && last !== 10 && last !== 92) return tex;
  let t = trimEndOf(tex, ' \t\n');
  if (t === '' || t.charCodeAt(0) === 32 || t.charCodeAt(0) === 9 || t.charCodeAt(0) === 10) return tex;
  let b = t.length;
  while (b > 0 && t.charCodeAt(b - 1) === 92) b--;
  if (b < t.length) t += (t.length - b) % 2 === 1 ? ' {}' : '{}';
  return formulaFirst(`$${t}$x`, `$${t}$`) ? t : tex;   // (`x`: the currency rule is currencySafe's to settle)
}

function fenceFor(code: string, lang: string): string {
  const ch = lang.includes('`') ? '~' : '`';
  let len = 3;
  const re = ch === '`' ? /^ {0,3}(`{3,})/gm : /^ {0,3}(~{3,})/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) len = Math.max(len, m[1].length + 1);
  return ch.repeat(len);
}

function fencedCode(code: string, lang: string, hint: SerializeHints['fence'] | undefined): string {
  const body = code === '' ? '' : code.endsWith('\n') ? code : code + '\n';
  if (hint && 'indent' in hint) {
    const lines = body.replace(/\n$/, '').split('\n');
    if (lines.length > 0 && lines.some((l) => l.trim() !== '')) return lines.map((l) => (l.trim() === '' ? '' : hint.indent + l)).join('\n');
  }
  if (hint && 'open' in hint) {
    const m = /^( {0,3})(`{3,}|~{3,})/.exec(hint.open);
    if (m) {
      const closeRe = new RegExp(`^ {0,3}${m[2][0] === '`' ? '`' : '~'}{${m[2].length},}[ \\t]*$`, 'm');
      if (!closeRe.test(body)) return hint.open + '\n' + (hint.close === null ? body.replace(/\n$/, '') : body + hint.close);
    }
  }
  const fence = fenceFor(body, lang);
  return fence + hiddenRefs(lang) + '\n' + body + fence;   // (S2: an info string reads references)
}

function inlineCode(text: string, inCell: boolean): string {
  let t = text.replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\r?\n|\r/g, ' ');
  if (inCell) t = t.replace(/\|/g, '\\|');
  if (t === '') return '';
  let delim = '`';
  const runs: string[] = t.match(/`+/g) ?? [];
  while (runs.includes(delim)) delim += '`';
  // markdown-it strips one space from each end of content that starts and ends with one and is not only spaces
  // (a test, not the regex `/^ .*[^ ].* $/`: quadratic on a long span, G6)
  const pad = /^`|`$/.test(t) || (t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) ? ' ' : '';
  return delim + pad + t + pad + delim;
}

/** Text inside raw inline HTML is still parsed as Markdown: every significant character becomes an entity. */
const literalHtml = (v: string): string => v.replace(/[\\`*_[\]$~<>&|!#+\-.()]/g, (c) => `&#${c.charCodeAt(0)};`);
// A line break (or another control character) in an attribute value is written as a character reference:
// the tag stays on its line and the attribute keeps its value (U10 e).
// S2: a HIDDEN character as its reference (after `&` and `"` are escaped, before the other controls are).
const attrEscape = (v: string): string => attrRefs(v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')).replace(CONTROLS, (c) => `&#${c.charCodeAt(0)};`);   // (B3: and U+00A0)
function openTag(e: Element, skip: (name: string) => boolean = () => false): string {
  let s = '<' + e.tagName.toLowerCase();
  for (const a of Array.from(e.attributes)) {
    if (a.name === 'data-l' || a.name.startsWith('data-mdr') || skip(a.name)) continue;
    s += a.value === '' && a.name !== 'alt' ? ` ${a.name}` : ` ${a.name}="${attrEscape(a.value)}"`;
  }
  return s + '>';
}

/** markdown-it's link normalisation (mdurl.encode with its default keep-set). */
function mdurlEncode(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { out += s.slice(i, i + 3); i += 2; continue; }
    if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(c)) { out += c; continue; }
    const cp = s.codePointAt(i)!;
    const chr = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    try { out += encodeURIComponent(chr); } catch { out += chr; }
  }
  return out;
}

/** The link destination as the user would have typed it: percent-escapes of non-ASCII text decoded when
 *  markdown-it re-encodes the result to exactly the same href. */
function linkDest(href: string): string {
  const d = urlText(OWN_URLS.get(href) ?? decodedDest(href), href);   // (J19 extended: the source's own spelling when it has one)
  if (d === '' ) return '<>';
  if (/[\s<>]/.test(d) || /[()]/.test(d) && !balancedParens(d)) return '<' + d.replace(/([<>\\])/g, '\\$1') + '>';
  return d.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
}
/** `href` with its percent-escapes of non-ASCII text decoded when markdown-it re-encodes the result to exactly the
 *  same href — only those that decode to a character `rawInUrl` lets through (J19 extended: an invisible character
 *  stays an escape; a marker-range character only when the source writes it raw, J19). Since mdurl re-encodes the
 *  result to `href`, every character decoded here came from an escape spelled as encodeURIComponent spells it. */
function decodedDest(href: string): string {
  if (!href.includes('%')) return href;
  try {
    const dec = decodeURI(href);
    if (dec === href || mdurlEncode(dec) !== href || /[\s<>()\\]/.test(dec)) return href;
    let out = '';
    for (const c of dec) out += rawInUrl(c) ? c : encodeURIComponent(c);
    return out;
  } catch { return href; }
}

/** J19 extended: the URL text `shown` (a link's text, which markdown-it's normalizeLinkText decoded) as it can be
 *  written — every character `rawInUrl` keeps escaped written as its percent-escape (encodeURIComponent's spelling);
 *  null when that is impossible (a lone surrogate). The callers prove the spelling reads back as the same link. */
function urlSpelling(shown: string): string | null {
  let out = '';
  try {
    for (const c of shown) out += rawInUrl(c) ? c : encodeURIComponent(c);
  } catch { return null; }
  return out;
}
/** C1 / C2, the second line: THE one place where the text of a URL is handed to the writer (`linkDest`: link
 *  destinations, image sources, reference links written inline; the link rule: bare URLs and autolinks). `spell` may
 *  hold a character `rawInUrl` rejects only when it is the block source's own literal, agreed spelling of `href`
 *  (OWN_URLS, without the `mailto:` an e-mail link's text leaves out); anywhere else each such character is written as
 *  its percent-escape (encodeURIComponent's spelling, the one markdown-it encodes it to: the same href). */
function urlText(spell: string, href: string): string {
  const own = OWN_URLS.get(href);
  if (own !== undefined && (spell === own || 'mailto:' + spell === own)) return spell;
  let out = '';
  for (const c of spell) {
    if (rawInUrl(c)) { out += c; continue; }
    try { out += encodeURIComponent(c); } catch { out += '%EF%BF%BD'; }   // (a lone surrogate: mdurl's own escape for it)
  }
  return out;
}
function balancedParens(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
// a line break in a title is written as a character reference: the link stays on its line (U10 e); S2: so is a HIDDEN
// character
const linkTitle = (t: string | null): string => (t ? ` "${attrRefs(t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;'))}"` : '');   // (B3: and U+00A0)

// ---------------------------------------------------------------- a link whose text is its URL (U11)
/** markdown-it with the worker's linkify configuration (src/worker/md.ts sets no linkify-it options): the
 *  oracle for the bare and `<url>` spellings — its linkify-it instance and its link normalisers. */
let oracle: MarkdownIt | null = null;
const mdi = (): MarkdownIt => (oracle ??= markdownIt({ html: true, linkify: true }));

/** Characters markdown-it's inline linkify rule reads back as part of a scheme (`isSchemeChar`). */
const SCHEME_CHAR = /^[A-Za-z0-9+.-]$/;
/** An e-mail address that is plain text to the inline parser (core linkify runs after it): `_` only between
 *  letters or digits, where it cannot open or close emphasis. */
const EMAIL_TEXT = /^(?:[A-Za-z0-9.%+-]|(?<=[A-Za-z0-9])_(?=[A-Za-z0-9]))+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** CommonMark / markdown-it 15 autolinks. */
const AUTOLINK_URL = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*$/;
const AUTOLINK_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** What markdown-it's inline linkify rule (markdown-it 15) makes of `src` (a scheme URL and the Markdown after
 *  it): the length it consumes, the href and the shown text; null when it makes no link. */
function inlineLinkify(src: string): { len: number; href: string; text: string } | null {
  const m = mdi();
  const link = m.linkify.matchAtStart(src);
  if (!link) return null;
  let url = link.url;
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 42) end--;   // trailing `*` are left to emphasis
  url = url.slice(0, end);
  const href = m.normalizeLink(url);
  if (!m.validateLink(href)) return null;
  return { len: url.length, href, text: m.normalizeLinkText(url) };
}

/** The Markdown character just before the link `a` (turndown's clone, text already escaped): '' at a line
 *  start (also after a break or a block), ' ' for whitespace, a text's last character, '>' after an enclosing
 *  inline element's opening delimiter or tag (a token of its own: the text run starts after it), null after
 *  another inline element (its closing delimiter's flanking was decided for a `[` or `<` here, FID-1d). */
function charBeforeLink(a: Element): string | null {
  let sib = a.previousSibling;
  while (sib && sib.nodeType === 3 && (sib as Text).data === '') sib = sib.previousSibling;
  if (!sib) {
    const p = a.parentElement;
    return !p || isBlockEl(p) || p.hasAttribute('data-mdr-top') ? '' : '>';
  }
  if (sib.nodeType === 3) {
    const c = lastCp((sib as Text).data);
    return c === NL || /^\s$/.test(c) ? ' ' : c;
  }
  if (sib.nodeType === 1 && ((sib as Element).tagName === 'BR' || isBlockEl(sib))) return '';
  return null;
}

/** Closing delimiters an enclosing element may be written with (its rule runs after the link's). */
const LINK_CLOSERS: Record<string, string[]> = {
  STRONG: ['**', '</strong>'], B: ['**', '</strong>'], EM: ['*', '_', '</em>'], I: ['*', '_', '</em>'],
  DEL: ['~~', '</del>'], S: ['~~', '</del>'], STRIKE: ['~~', '</del>'],
};

/** Every Markdown text that may follow the link `a`, up to and including the first whitespace after it or to
 *  the end of its line (linkify never reads past a whitespace), one per way the enclosing elements may be
 *  written; null when that is not known here (another inline element follows). */
function textsAfterLink(a: Element): string[] | null {
  let alts = [''];
  let node: Element = a;
  const lineEnd = (n: Node | null, parent: Element | null): boolean =>
    n === null ? !parent || isBlockEl(parent) || parent.hasAttribute('data-mdr-top') : n.nodeType === 1 && ((n as Element).tagName === 'BR' || isBlockEl(n));
  for (;;) {
    let sib = node.nextSibling;
    while (sib && sib.nodeType === 3 && (sib as Text).data === '') sib = sib.nextSibling;
    if (sib && sib.nodeType === 3) {
      const d = (sib as Text).data.split(NL).join('\n');
      if (/\s/.test(d)) return alts.map((x) => x + d);
      let next = sib.nextSibling;
      while (next && next.nodeType === 3 && (next as Text).data === '') next = next.nextSibling;
      return lineEnd(next, node.parentElement) ? alts.map((x) => x + d + '\n') : null;
    }
    if (sib) return lineEnd(sib, null) ? alts.map((x) => x + '\n') : null;
    const p = node.parentElement;
    if (lineEnd(null, p)) return alts;
    const close = LINK_CLOSERS[p!.tagName] ?? [`</${p!.tagName.toLowerCase()}>`];
    alts = alts.flatMap((x) => close.map((c) => x + c));
    if (alts.length > 27) return null;
    node = p!;
  }
}

/** U11: does markdown-it read `text` written bare at the place of `a` back as exactly this link — linkify
 *  starts at its first character, stops at its last, links to `href` and shows `shown` (the link's text; `text` is
 *  its spelling with the escapes J19 keeps, `urlSpelling`)? Anything not proven here answers false (the caller
 *  writes `<url>` or `[text](destination)`, which render the same link). */
function bareProven(a: Element, text: string, href: string, shown = text): boolean {
  if (!DEFAULT_RENDER_OPTIONS.linkify || text === '' || /[\s\p{Cc}|]/u.test(text)) return false;
  const before = charBeforeLink(a);
  if (before === null) return false;
  const m = mdi();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    // The inline rule fires at the `:` of `://` and reads the scheme back over the pending text: a letter,
    // digit, `+`, `-` or `.` right before the URL would become part of it (版本v2https://…: no link, FID-1a).
    // A `<` before would make `<url>…>` an autolink or a tag with the text after it.
    if (SCHEME_CHAR.test(before) || before === '<') return false;
    const after = textsAfterLink(a);
    return after !== null && after.every((tail) => {
      const r = inlineLinkify(text + tail);
      return r !== null && r.len === text.length && r.href === href && r.text === shown;
    });
  }
  // An e-mail address is linkified by the core rule, on the text token, only after a separator: here a line
  // start or whitespace (请联系support@…: no link, FID-1c; 编号Aa@…: another address, FID-1b).
  if (!EMAIL_TEXT.test(text) || (before !== '' && before !== ' ')) return false;
  const after = textsAfterLink(a);
  return after !== null && after.every((tail) => {
    const links = m.linkify.match(' ' + text + tail);
    const f = links?.[0];
    if (!f || f.index !== 1 || f.lastIndex !== 1 + text.length || f.schema !== 'mailto:') return false;
    const full = m.normalizeLink(f.url);
    return m.validateLink(full) && full === href && m.normalizeLinkText('mailto:' + f.text).replace(/^mailto:/, '') === shown;
  });
}

/** U11: is `<text>` a CommonMark autolink that markdown-it reads as this link, showing `shown`? */
function autolinkProven(a: Element, text: string, href: string, shown = text): boolean {
  const m = mdi();
  let full: string;
  if (AUTOLINK_URL.test(text)) full = m.normalizeLink(text);
  else if (AUTOLINK_EMAIL.test(text)) full = m.normalizeLink('mailto:' + text);
  else return false;
  // a table row is split at `|` before its cells are parsed, and an autolink reads no escape
  if (text.includes('|') && a.closest('td, th')) return false;
  return full === href && m.validateLink(full) && m.normalizeLinkText(text) === shown;
}

/** The texts of the autolinks (`<url>`, `<a@b.c>`) a block's source writes, as markdown-it shows them. */
function sourceAutolinks(content: string): string[] {
  if (!content.includes('<')) return [];
  const out: string[] = [];
  for (const mm of content.matchAll(/<([^<>\x00-\x20]+)>/g)) {
    const raw = mm[1];
    if (AUTOLINK_URL.test(raw) || AUTOLINK_EMAIL.test(raw)) out.push(mdi().normalizeLinkText(raw));
  }
  return out;
}

/** J19 extended: the URLs a block's source writes (link destinations, image sources, autolinks, bare URLs, reference
 *  definitions) as [href, spelling, occurrences], found by parsing the source with markdown-it's own rules (the
 *  worker's: html, linkify, the math rule) and watching every url it normalizes to an href.
 *  C1 (checkpoint F): a spelling is the literal text of the source, or it is nothing. A destination's url is what
 *  markdown-it decoded (entities, backslash escapes): it counts only when it is exactly the destination's own text
 *  between its delimiters (tied to its place through parseLinkDestination). An autolink's or bare URL's url is the
 *  source's text (with the `mailto:` / `http://` markdown-it puts before an address or a www. link). Every spelling must
 *  also occur in the source as it stands.
 *  C2: an href gets a spelling only when every place of the source that normalizes to it spells it the same way; when
 *  one place has no literal spelling or two places differ, the href gets none (the predicate decides each of them).
 *  `occurrences`: the links and images of the source's own rendering with that href (see `ownUrls`). */
let urlRecorder: MarkdownIt | null = null;
function sourceUrls(content: string): Array<[string, string, number]> {
  // (no destination, autolink, scheme, e-mail address or www. link without one of these: no parse)
  if (!/[(:<@]|www\./i.test(content)) return [];
  const m = (urlRecorder ??= markdownIt({ html: true, linkify: true }).use(mathPlugin));
  const spelled = new Map<string, string | null>();   // href → the one literal spelling of all its places; null: none
  const literal = (s: string): boolean => content.includes(s) || (/^(?:mailto:|http:\/\/)/.test(s) && content.includes(s.slice(7)));
  const norm = m.normalizeLink;
  const parseDest = m.helpers.parseLinkDestination;
  let dest: { str: string; raw: string } | null = null;   // the destination markdown-it has just read
  m.helpers.parseLinkDestination = (str: string, start: number, max: number) => {
    const r = parseDest(str, start, max);
    dest = r.ok ? { str: r.str, raw: str.slice(start, r.pos) } : null;
    return r;
  };
  m.normalizeLink = (url: string): string => {
    const h = norm.call(m, url);
    let spell: string | null = url;
    if (dest !== null && dest.str === url) {
      const raw = dest.raw.length >= 2 && dest.raw.startsWith('<') && dest.raw.endsWith('>') ? dest.raw.slice(1, -1) : dest.raw;
      if (raw !== url) spell = null;   // (an entity or a backslash escape: not the source's text)
    }
    dest = null;
    if (spell !== null && !literal(spell)) spell = null;
    spelled.set(h, spelled.has(h) && spelled.get(h) !== spell ? null : spell);
    return h;
  };
  const count = new Map<string, number>();
  try {
    for (const t of m.parse(content, {})) {
      for (const c of t.children ?? []) {
        const u = c.type === 'link_open' ? c.attrGet('href') : c.type === 'image' ? c.attrGet('src') : null;
        if (u !== null) count.set(String(u), (count.get(String(u)) ?? 0) + 1);
      }
    }
  } catch { spelled.clear(); } finally { m.normalizeLink = norm; m.helpers.parseLinkDestination = parseDest; }
  const out: Array<[string, string, number]> = [];
  for (const [h, s] of spelled) if (s !== null) out.push([h, s, count.get(h) ?? 0]);
  return out;
}

// ---------------------------------------------------------------- preprocessing (on the clone)
const FORMAT_CLASS: Record<string, string> = { STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', DEL: 'del', S: 'del', STRIKE: 'del' };

/** Text the session leaves around the caret (zero-width), not content. */
const isVoidText = (n: Node | null): boolean => n !== null && n.nodeType === 3 && /^[\u200b\ufeff]*$/.test((n as Text).data);

/** `code` with `<br>` inside → the code parts and the breaks, in order (empty parts dropped). */
function splitCodeAtBreaks(code: Element): void {
  const parts: Node[] = [];
  let text = '';
  const part = (): void => {
    if (text.replace(/[\u200b\ufeff]/g, '') !== '') { const c = code.cloneNode(false) as Element; c.textContent = text; parts.push(c); }
    text = '';
  };
  const walk = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3) text += (c as Text).data;
      else if (c.nodeType === 1 && (c as Element).tagName === 'BR') { part(); parts.push(code.ownerDocument.createElement('br')); }
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(code);
  part();
  code.replaceWith(...parts);
}

/** Elements a line break at whose edge is moved outside (`**x  \n**` does not read back as emphasis). */
const HOIST = new Set(['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE', 'A']);

/** A `<br>` first or last in bold / italic / strikethrough / a link moves out of it (repeatedly, through
 *  nested formatting); an element left without content disappears. `<b>x<br></b>y` → `**x**` + break + `y`
 *  instead of raw `<strong>` HTML, and the break stays a break (G5). */
function hoistBreaks(root: Element): void {
  const brs = Array.from(root.querySelectorAll('br'));
  for (let moved = true, rounds = 0; moved && rounds < 64; rounds++) {
    moved = false;
    for (const br of brs) {
      const p = br.parentElement;
      if (!p || p === root || !HOIST.has(p.tagName)) continue;
      let before = br.previousSibling;
      while (isVoidText(before)) before = before!.previousSibling;
      let after = br.nextSibling;
      while (isVoidText(after)) after = after!.nextSibling;
      if (before === null) p.before(br);
      else if (after === null) p.after(br);
      else continue;
      moved = true;
      if (p.childElementCount === 0 && /^[\u200b\ufeff]*$/.test(p.textContent ?? '')) p.remove();
    }
  }
}

/** Does this `<br>` start its line (nothing before it on the line: the line start, another break, a soft
 *  line break)? There a trailing-spaces break would be a blank line; the backslash form is not. */
function brAtLineStart(br: Element): boolean {
  let cur: Node = br;
  for (;;) {
    let sib = cur.previousSibling;
    while (sib && sib.nodeType === 3 && (sib as Text).data === '') sib = sib.previousSibling;
    if (sib) {
      if (sib.nodeType === 3) return (sib as Text).data.endsWith(NL) || (sib as Text).data.endsWith('\n');
      return sib.nodeType === 1 && ((sib as Element).tagName === 'BR' || isBlockEl(sib));
    }
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1 || isBlockEl(parent) || LINE_CONTAINERS.has((parent as Element).tagName)) return true;
    cur = parent;
  }
}

/** Is a block element the next thing after `br` (whitespace text aside)? */
function brBeforeBlock(br: Element): boolean {
  let n = br.nextSibling;
  while (n && n.nodeType === 3 && /^[ \t\r\n]*$/.test((n as Text).data)) n = n.nextSibling;
  return n !== null && isBlockEl(n);
}

/** `<strong>a</strong><strong>b</strong>` → one element: back-to-back delimiters (`**a****b**`) would not
 *  read back. Editing produces such pairs (bolding two adjacent selections, splitting a run). */
function mergeAdjacentFormatting(root: Element): void {
  const all = Array.from(root.querySelectorAll('strong, b, em, i, del, s, strike'));
  for (const e of all) {
    if (!e.parentNode) continue;
    const prev = e.previousSibling;
    if (!prev || prev.nodeType !== 1) continue;
    const pe = prev as Element;
    if (FORMAT_CLASS[pe.tagName] !== FORMAT_CLASS[e.tagName] || pe.attributes.length > 0 || e.attributes.length > 0) continue;
    while (e.firstChild) pe.appendChild(e.firstChild);
    e.remove();
  }
}

/** The delimiter character a formatting class is written with (`em` may also be `_`, which never glues to `*`
 *  any more than `~` does: counted as `*` to stay on the safe side). */
const DELIM_CHAR: Record<string, string> = { strong: '*', em: '*', del: '~' };
/** An emphasis element glued to another one written with the same delimiter character (`**a***b*`): its
 *  delimiters would join the neighbour's run. A neighbour of another kind (`**a**~~b~~`) is its own run (G21). */
function gluedToFormatting(e: Element, ch?: string): boolean {
  const prev = e.previousSibling;
  if (prev === null || prev.nodeType !== 1) return false;
  const a = FORMAT_CLASS[(prev as Element).tagName];
  // `data-mdr-u`: the rule wrote that element with `_` (it runs before this one's)
  return a !== undefined && ((prev as Element).hasAttribute('data-mdr-u') ? '_' : DELIM_CHAR[a]) === (ch ?? DELIM_CHAR[FORMAT_CLASS[e.tagName]]);
}

/** The nearest ancestor of `e` of formatting class `cls` in its line (a block element ends the search). */
function formatAncestor(e: Element, cls: string): Element | null {
  for (let p = e.parentElement; p && !isBlockEl(p) && !p.hasAttribute('data-mdr-top'); p = p.parentElement) if (FORMAT_CLASS[p.tagName] === cls) return p;
  return null;
}
/** Nothing but whitespace between `e` and the start (-1) / end (1) of its parent. */
function atEdge(e: Element, dir: -1 | 1): boolean {
  for (let n = dir < 0 ? e.previousSibling : e.nextSibling; n; n = dir < 0 ? n.previousSibling : n.nextSibling) {
    if (n.nodeType === 3 && /^\s*$/.test((n as Text).data)) continue;
    return false;
  }
  return true;
}
/** May the formatting element `p` be written with `_` delimiters (`__x__` inside bold, `_x_` in or filling
 *  emphasis)? Over-answering only writes raw HTML more often. */
function mayUseUnderscore(p: Element): boolean {
  const cls = FORMAT_CLASS[p.tagName];
  if (cls === 'strong') return formatAncestor(p, 'strong') !== null;
  if (cls === 'em') { const pp = p.parentElement; return formatAncestor(p, 'em') !== null || (pp !== null && FORMAT_CLASS[pp.tagName] === 'strong'); }
  return false;
}
/** Does `_` + content + `_` (or `__`) read back as this element here? At the edge of a formatting parent the
 *  neighbour is that parent's `*` delimiter; a parent itself written with `_` would join the runs. */
function underscoreOk(e: Element, c: string): boolean {
  const p = e.parentElement;
  const fmt = p !== null && FORMAT_CLASS[p.tagName] !== undefined;
  const start = fmt && atEdge(e, -1), end = fmt && atEdge(e, 1);
  if ((start || end) && mayUseUnderscore(p!)) return false;
  return flankOk(e, c, '_', start ? '*' : undefined, end ? '*' : undefined) && !gluedToFormatting(e, '_');
}

/** Elements whose Markdown is one inline context (or a superset of one: over-counting only escapes more). */
const INLINE_CONTEXT = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE']);
interface InlineInfo { dollars: number; tildes: number; bracketFree: boolean }

/** Counts over everything the inline context of `t` contains: text, the Markdown of placeholders
 *  (`data-md`: code, math) and attribute values (link destinations are part of the inline source). */
function inlineInfo(t: Text, root: Element, memo: Map<Element, InlineInfo>): InlineInfo {
  let ctx: Element = root;
  for (let cur = t.parentElement; cur && cur !== root; cur = cur.parentElement) if (INLINE_CONTEXT.has(cur.tagName)) { ctx = cur; break; }
  const hit = memo.get(ctx);
  if (hit) return hit;
  let all = ctx.textContent ?? '';
  let links = false;
  for (const e of Array.from(ctx.querySelectorAll('*'))) {
    if (e.tagName === 'A' || e.tagName === 'IMG') links = true;   // they emit `[…]`
    for (const a of Array.from(e.attributes)) all += '\n' + a.value;
  }
  const count = (ch: string): number => { let n = 0; for (let i = all.indexOf(ch); i >= 0; i = all.indexOf(ch, i + 1)) n++; return n; };
  // a <del> emits `~~`: counted as two tildes so a text run is never the context's only one
  const dels = ctx.querySelectorAll('del, s, strike').length;
  const info: InlineInfo = { dollars: count('$'), tildes: count('~') + 2 * dels, bracketFree: count(']') === 0 && !links };
  memo.set(ctx, info);
  return info;
}

// Every `\n` with the spaces / tabs around it (and a `\r` right before it) → NL: the regex
// `/[ \t]*\r?\n[ \t]*/g` as a split, since the regex retries at every space of a long run (quadratic, G6).
function softBreaks(d: string): string {
  if (d.indexOf('\n') < 0) return d;
  const parts = d.split('\n');
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i];
    if (i < parts.length - 1) p = trimEndOf(p.endsWith('\r') ? p.slice(0, -1) : p, ' \t');
    if (i > 0) p = trimStartOf(p, ' \t');
    parts[i] = p;
  }
  return parts.join(NL);
}

function prepare(root: Element, h: SerializeHints, kind: BlockKind): void {
  const doc = root.ownerDocument;
  const mathOn = h.math !== false;
  // UI-only elements the preview adds around the rendered HTML.
  for (const e of Array.from(root.querySelectorAll('.md-plain__note, [data-mdr-ui]'))) e.remove();
  // P-G: the session's stamps count only on a DOM the session stamped (stampAtoms); anywhere else they are dropped.
  if (!h.stamped) clearStamps(root);
  // The serializer's own attributes are honoured only where this call sets them: one already in the DOM
  // (the sanitizer removes them from documents, U10 d) is dropped, its value never becomes Markdown (U10 e).
  for (const e of Array.from(root.querySelectorAll('[data-md], [data-md-block], [data-mdr-task], [data-mdr-top], [data-mdr-al], [data-mdr-u]'))) {
    for (const a of ['data-md', 'data-md-block', 'data-mdr-task', 'data-mdr-top', 'data-mdr-al', 'data-mdr-u']) e.removeAttribute(a);
  }
  // Editing: the browser copies computed styles onto elements it creates (insertHTML, createLink,
  // bold after a paste …). On a Markdown-mappable element such a `style` is noise, not content — kept,
  // the element would go out as raw HTML with the light theme's colours baked in. Elements that came
  // from the document itself carry `data-mdr-o` (set when the session starts) and keep theirs.
  if (h.editing) {
    for (const e of Array.from(root.querySelectorAll('a[style], strong[style], b[style], em[style], i[style], code[style], del[style], s[style], strike[style]'))) {
      if (!e.hasAttribute('data-mdr-o')) e.removeAttribute('style');
    }
  }
  for (const w of Array.from(root.querySelectorAll('.md-codewrap'))) {
    while (w.firstChild) w.parentNode!.insertBefore(w.firstChild, w);
    w.remove();
  }
  const place = (old: Element, md: string, block: boolean): void => {
    const e = doc.createElement(block ? 'div' : 'span');
    e.setAttribute('data-md', md);
    if (block) e.setAttribute('data-md-block', '');
    e.textContent = 'x';   // non-blank, or turndown drops it
    old.replaceWith(e);
  };
  // Formulas (rendered KaTeX, or the source form an edit session swapped in).
  for (const m of Array.from(root.querySelectorAll('.md-math, .md-math-src'))) {
    if (!root.contains(m)) continue;
    if (m.parentElement?.closest('.md-math, .md-math-src')) continue;
    if (!isFormula(m)) continue;   // a document's own `class="md-math"` element: ordinary HTML (U10 e)
    const r = mathMarkdown(m, h.stamped === true);
    // In a table cell every `|` of the TeX needs a backslash (the row is split before the cell is parsed,
    // and `\|` becomes `|`), as in inline code: `$\|x\|$` stays `$\|x\|$` (G3).
    place(m, !r.block && closestTag(m, CELLS, root) !== null ? r.md.replace(/\|/g, '\\|') : r.md, r.block);
  }
  // Fenced / indented code.
  const pres = Array.from(root.querySelectorAll('pre'));
  const onlyPre = pres.length === 1 && kind === BlockKind.Code
    && Array.from(root.children).filter((c) => c.tagName !== 'PRE').length === 0;
  for (const pre of pres) {
    if (!root.contains(pre)) continue;
    const lang = (pre.getAttribute('data-lang') ?? '').split(UNSAFE_LANG)[0];   // refused by unsupportedReason; never past its first word
    place(pre, fencedCode(codeText(pre), lang, onlyPre ? h.fence : undefined), true);
  }
  // A line break inside inline code (Shift+Enter, a pasted line): the span is split around it, so the
  // break is kept and both parts stay code (G5).
  for (const code of Array.from(root.querySelectorAll('code'))) if (root.contains(code) && code.querySelector('br')) splitCodeAtBreaks(code);
  // Inline code.
  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (!root.contains(code)) continue;
    const md = inlineCode(code.textContent ?? '', closestTag(code, CELLS, root) !== null);
    if (md === '') { code.remove(); continue; }
    // Two code spans back to back would merge their backtick runs: the second one goes out as HTML.
    const prev = code.previousSibling;
    const glued = prev !== null && prev.nodeType === 1 && ((prev as Element).tagName === 'CODE' || ((prev as Element).getAttribute('data-md') ?? '').endsWith('`'));
    place(code, glued ? '<code>' + hiddenRefs(literalHtml(code.textContent ?? '')) + '</code>' : md, false);   // (S2: raw HTML reads references)
  }
  // P-G (c): presentation the browser invented while editing a stamped DOM is not written (after the formulas went:
  // KaTeX's own styled markup is not walked).
  if (h.stamped) { presentationAsPrepared(root); clearStamps(root); }
  // Task list items: the item's own leading checkbox (ownTaskBox: THE definition) becomes the `[ ]` / `[x]` marker of
  // its item. Any other checkbox (P-G d: a join moved the next item's box in) is dropped and never sets the marker; the
  // text after it keeps the space that stood there.
  // (Decided for every box before any is removed: a removal would make the next box its item's first.)
  const inputs = Array.from(root.querySelectorAll('input'));
  const own = inputs.map((input) => {
    const li = input.closest('li');
    return input.type === 'checkbox' && li !== null && root.contains(li) && ownTaskBox(input) ? li : null;
  });
  inputs.forEach((input, k) => {
    const li = own[k];
    if (li) {
      li.setAttribute('data-mdr-task', input.checked ? 'x' : ' ');
      const after = input.nextSibling;
      if (after && after.nodeType === 3) (after as Text).data = (after as Text).data.replace(/^[ \u00a0]+/, '');
    }
    input.remove();
  });
  // Editing leftovers: bare style wrappers the browser invents while typing are unwrapped. Last first: the
  // result is the same, and in document order Chromium's removals made a paragraph of n wrappers O(n²) (G6).
  if (h.editing) {
    const wrappers = Array.from(root.querySelectorAll('span, font'));
    for (let k = wrappers.length - 1; k >= 0; k--) {
      const e = wrappers[k];
      if (e.hasAttribute('data-mdr-o') || e.hasAttribute('data-md')) continue;
      if (Array.from(e.attributes).some((a) => a.name !== 'style' && a.name !== 'color' && a.name !== 'face' && a.name !== 'size')) continue;
      while (e.firstChild) e.parentNode!.insertBefore(e.firstChild, e);
      e.remove();
    }
  }
  hoistBreaks(root);
  mergeAdjacentFormatting(root);
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const text = a.textContent ?? '';
    a.setAttribute('data-mdr-text', text);
    if (h.autolinks) a.setAttribute('data-mdr-al', h.autolinks.includes(text) ? '1' : '0');   // the source writes `<url>` (U11)
  }
  // <br>: trailing ones (the browser's placeholder in an empty line) go, in headings / cells they stay HTML.
  // "Only blank text and breaks follow" is found once per run of breaks (each break of a run rescanned the
  // rest of it: quadratic, G6); removing a trailing break or replacing a kept one does not change the answer
  // for the nodes before it.
  const blankTail = new Map<Node, boolean>();
  const onlyBlankAfter = (n: Node): boolean => {
    const walked: Node[] = [];
    let cur: Node = n;
    let r: boolean | undefined;
    for (;;) {
      r = blankTail.get(cur);
      if (r !== undefined) break;
      walked.push(cur);
      const sib: Node | null = cur.nextSibling;
      if (sib === null) { r = true; break; }
      if (!((sib.nodeType === 3 && /^[\s\u200b]*$/.test((sib as Text).data)) || (sib.nodeType === 1 && (sib as Element).tagName === 'BR'))) { r = false; break; }
      cur = sib;
    }
    for (const w of walked) blankTail.set(w, r);
    return r;
  };
  for (const br of Array.from(root.querySelectorAll('br'))) {
    const parent = br.parentElement;
    const lineEnd = onlyBlankAfter(br) && parent !== null && (isBlockEl(parent) || parent === root);
    if (lineEnd) {
      if (parent!.tagName === 'LI') parent!.setAttribute('data-mdr-br', '');   // an item the browser emptied (underText)
      br.remove();
      continue;
    }
    if (closestTag(br, HEADINGS, root) || closestTag(br, CELLS, root)) place(br, '<br>', false);
  }
  // Text nodes: whitespace between blocks goes, the rest is escaped with its context. Adjacent text
  // nodes (editing splits them all the time) are merged first so every character sees its real neighbours.
  root.normalize();
  const texts: Text[] = [];
  const infoMemo = new Map<Element, InlineInfo>();
  const tw = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const parent = t.parentElement;
    if (!parent) continue;
    if (parent.closest('[data-md]')) continue;
    let d = t.data.replace(/[\u200b\ufeff]/g, '');
    const pb = t.previousSibling, nb = t.nextSibling;
    const parentBlock = isBlockEl(parent) || parent === root;
    if (/^[ \t\r\n]*$/.test(d) && (BLOCK_CONTAINERS.has(parent.tagName) || parent === root || isBlockEl(pb) || isBlockEl(nb) || (parentBlock && (!pb || !nb)))) {
      t.remove();
      continue;
    }
    if (isBlockEl(pb) || (!pb && parentBlock) || (pb && pb.nodeType === 1 && (pb as Element).tagName === 'BR')) d = d.replace(/^[ \t\r\n]+/, '');
    if (isBlockEl(nb) || (!nb && parentBlock)) d = trimEndOf(d, ' \t\r\n');
    // Soft line breaks survive as NL; spaces around them are markdown-it's to strip.
    d = softBreaks(d);
    const cell = closestTag(t, CELLS, root) !== null;
    const heading = closestTag(t, HEADINGS, root);
    if (cell || heading) d = d.split(NL).join(' ');
    const info: InlineInfo = /[$~[\]]/.test(d) ? inlineInfo(t, root, infoMemo) : { dollars: 0, tildes: 0, bracketFree: true };
    const ctx: TextCtx = {
      lineStart: startsLine(t), inCell: cell, inHeading: heading !== null,
      headingEnd: heading !== null && neighbourChar(t, 1) === '',
      prev: mdNeighbour(t, -1), next: mdNeighbour(t, 1), math: mathOn,
      inLink: closestTag(t, LINKS, root) !== null, ...info,
    };
    const segs = d.split(NL);
    const out: string[] = [];
    for (let k = 0; k < segs.length; k++) {
      const first = k === 0, last = k === segs.length - 1;
      const ls = first ? ctx.lineStart : true;
      const le = last ? ctx.next === '' : true;
      let seg = fixNbsp(escapeSegment(segs[k], ctx, first ? ctx.prev : '', last ? ctx.next : '', ls, le, first && !pb && !parentBlock, last && !nb && !parentBlock), ls, le, h.keepNbsp === true);
      // A literal backslash that ended up last on a line (spaces after it trimmed) would be a hard break.
      // (a loop: `/\\+$/` retries at every position of an inner run of backslashes, quadratic, J20)
      if (le) {
        let b = seg.length;
        while (b > 0 && seg.charCodeAt(b - 1) === 92) b--;
        if ((seg.length - b) % 2 === 1) seg += '\\';
      }
      out.push(seg);
    }
    t.data = out.join(NL);
    // An inline formula's closing `$` followed by a digit is not a closer (src/worker/math.ts): the digit right
    // after one is written as a character reference, which renders the same digit (G20).
    if (pb !== null && pb.nodeType === 1 && /(?:^|[^$])\$$/.test((pb as Element).getAttribute('data-md') ?? '') && !(pb as Element).hasAttribute('data-md-block') && /^[0-9]/.test(t.data)) {
      t.data = `&#${t.data.charCodeAt(0)};` + t.data.slice(1);
    }
    if (t.data === '') t.remove();
  }
  if (mathOn) for (const ph of Array.from(root.querySelectorAll('[data-md]'))) currencySafe(ph, root);
}

// ---------------------------------------------------------------- H17: a formula stays a formula
/** markdown-it with the worker's own math rule (src/worker/math.ts), for the proofs of `currencySafe`. */
let mathOracle: MarkdownIt | null = null;

/** Does markdown-it's math rule read `src` as starting with the inline formula `md` (`$tex$`, exactly)? */
function formulaFirst(src: string, md: string): boolean {
  mathOracle ??= markdownIt({ html: true }).use(mathPlugin);
  const kids = mathOracle.parseInline(src, {})[0]?.children ?? [];
  return kids.length > 0 && kids[0].type === 'math_inline' && kids[0].content === md.slice(1, -1);
}

/** Inline elements whose Markdown always ends in a delimiter that is not whitespace (`*`, `~~`, `]…)`, `</x>`). */
const NON_WS_CLOSERS = new Set(['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE', 'A']);

/** What follows the formula placeholder `ph` in the Markdown: the text node that follows it (starting with
 *  whitespace or a soft break), 'end' (a line end: the end of its block, cell or heading, a hard break, a
 *  block), 'lead' (an inline element whose leading whitespace turndown writes before it), 'other' (a character
 *  that is not whitespace) or null when that is not known here. */
function afterFormula(ph: Node, root: Element): Text | 'end' | 'br' | 'lead' | 'other' | null {
  let n: Node = ph;
  for (;;) {
    let s = n.nextSibling;
    while (s && ((s.nodeType === 3 && (s as Text).data === '') || s.nodeType === 8)) s = s.nextSibling;
    if (s && s.nodeType === 3) {
      const c = (s as Text).data.charAt(0);
      // also a text of other whitespace only (U+3000 …): at a line end it is trimmed away (J21)
      return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === NL || trimmedAway((s as Text).data) ? (s as Text) : 'other';
    }
    if (s && s.nodeType === 1) {
      const e = s as Element;
      if (e.tagName === 'BR') return 'br';   // a hard break: whitespace before it stays
      if (isBlockEl(e)) return 'end';
      const md = e.getAttribute('data-md');
      if (md !== null) return md !== '' && !/^\s/.test(md) ? 'other' : null;
      if (e.tagName === 'CODE' || e.tagName === 'IMG' || e.tagName === 'INPUT') return 'other';   // `…`, ![…], [ ]
      const tx = e.textContent ?? '';
      // an empty inline element turndown writes as nothing (its blank rule): what follows it decides
      if (tx === '' && turndownBlank(e)) { n = e; continue; }
      if (tx === '') return null;
      // turndown moves an inline element's leading whitespace out in front of it (flankingWhitespace)
      return /^[ \t\r\n]/.test(tx) ? 'lead' : 'other';
    }
    if (s) return null;
    const p = n.parentElement;
    if (!p || p === root || isBlockEl(p) || p.hasAttribute('data-mdr-top')) return 'end';
    // any other inline element is raw HTML ending in its closing tag (the mdrRawInline rule)
    return NON_WS_CLOSERS.has(p.tagName) || (!MD_INLINE.has(p.tagName) && !p.hasAttribute('data-md')) ? 'other' : null;
  }
}

/** Is `s` only whitespace that the final trim, the cell and heading rules and markdown-it's paragraph trim remove
 *  at a line end (JavaScript's `\s`: U+3000, U+2003 … as well as ASCII; J21)? No soft break in it. */
function trimmedAway(s: string): boolean {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) if (s[i] === NL || !/\s/.test(s[i])) return false;
  return true;
}

/**
 * H17: an inline formula whose TeX starts and ends with a digit (`$3\times4$`, `$10$`) is not closed by a `$`
 * that is followed by whitespace or the end of the text (math.ts's currency rule: `$5 and 6$ each` is plain
 * text), so the compact spelling of a formula the session shows can re-render as literal text once an edit
 * left whitespace or the line end behind it. Then the whitespace right after the closing `$` is written as a
 * character reference (`&#32;`, the same space; `$10$&#32;x`), or one is added where a line end follows
 * (`$10$&#32;`, a space before a line end renders nothing, a space before whitespace is that whitespace):
 * the closer is followed by `&`, the TeX stays
 * exactly as it was. Both spellings are proven by parsing with the worker's math rule; a formula whose compact
 * spelling reads back (every other one) keeps its bytes.
 */
function currencySafe(ph: Element, root: Element): void {
  const md = ph.getAttribute('data-md') ?? '';
  if (ph.hasAttribute('data-md-block') || md.length < 3 || md.charCodeAt(0) !== 36 || md.charCodeAt(1) === 36 || md.charCodeAt(md.length - 1) !== 36) return;
  const digit = (c: number): boolean => c >= 48 && c <= 57;
  if (!digit(md.charCodeAt(1)) || !digit(md.charCodeAt(md.length - 2))) return;   // the currency rule needs both
  const next = afterFormula(ph, root);
  if (next === null || next === 'other') return;
  // a text of non-ASCII whitespace only (U+3000, U+2003 …) at a line end: trimmed away there, as the line end itself
  const gone = typeof next !== 'string' && trimmedAway(next.data) && !/^[ \t\r\n]/.test(next.data) && afterFormula(next, root) === 'end';
  if (next === 'end' || next === 'br' || next === 'lead' || gone) {
    const tail = next === 'lead' ? ' x' : '';
    if (formulaFirst(md + tail, md) || !formulaFirst(md + '&#32;' + tail, md)) return;
    ph.setAttribute('data-md', md + '&#32;');
    return;
  }
  if (typeof next === 'string') return;
  const d = next.data;
  // only the character after the `$` decides; the rest of the tail cannot change either answer
  const tail = d.slice(0, 64).split(NL).join('\n');
  if (formulaFirst(md + tail, md)) return;
  const c = d.charCodeAt(0);
  const spelled = c === 32 || c === 9 || c === 13 ? `&#${c};` + d.slice(1) : '&#32;' + d;
  if (!formulaFirst(md + spelled.slice(0, 64).split(NL).join('\n'), md)) return;
  next.data = spelled;
}

// ---------------------------------------------------------------- turndown rules
type TNode = HTMLElement & { isBlock?: boolean };

function trimNl(s: string): string { return trimEndOf(trimStartOf(s, '\n'), '\n'); }

/** Per-run memos (the clone does not change while turndown walks it): without them every item of a list
 *  rescanned all its siblings, which made one pass over an n-item list O(n²). Reset by `run()`. */
let looseMemo = new WeakMap<Element, boolean>();
let indexMemo = new WeakMap<Element, Map<Element, number>>();

function isLooseList(list: Element): boolean {
  const hit = looseMemo.get(list);
  if (hit !== undefined) return hit;
  let loose = list.hasAttribute('data-mdr-loose');
  for (let li = list.firstElementChild; li && !loose; li = li.nextElementSibling) {
    if (li.tagName !== 'LI') continue;
    for (let c = li.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === 'P') { loose = true; break; }
  }
  looseMemo.set(list, loose);
  return loose;
}

function itemIndex(list: Element, li: Element): number {
  let m = indexMemo.get(list);
  if (!m) {
    m = new Map();
    let i = 0;
    for (let c = list.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === 'LI') m.set(c, i++);
    indexMemo.set(list, m);
  }
  return m.get(li) ?? -1;
}

function listMarker(li: Element): string {
  const list = li.parentElement!;
  const prevList = list.previousElementSibling;
  const alt = prevList !== null && prevList.tagName === list.tagName;
  if (list.tagName === 'OL') {
    const start = Number(list.getAttribute('start') ?? '1');
    return `${(Number.isFinite(start) ? start : 1) + itemIndex(list, li)}${alt ? ')' : '.'}`;
  }
  return alt ? '*' : '-';
}

/** May the line above `li`'s marker be paragraph text? It is the first item of a list nested in a tight
 *  item right under that item's text, or an item emptied in the session (`data-mdr-br`: the browser's
 *  placeholder) that is the first of the block's own top-level list: the line above the block is not the
 *  serializer's to see. `data-mdr-cont` marks the item-wise path's shell list of a later item. */
function underText(li: Element): boolean {
  const list = li.parentElement;
  const parent = list?.parentElement;
  if (!list || !parent || itemIndex(list, li) !== 0 || list.hasAttribute('data-mdr-cont')) return false;
  const before = (): boolean => {
    for (let n = list.previousSibling; n; n = n.previousSibling) {
      if (n.nodeType === 3) { if (/[^ \t\r\n]/.test((n as Text).data)) return true; continue; }
      if (n.nodeType === 1) return !isBlockEl(n);
    }
    return false;
  };
  if (parent.parentElement === null || parent.hasAttribute('data-mdr-top')) return li.hasAttribute('data-mdr-br') && !before() && list.previousElementSibling === null;   // the block root (in run's box: data-mdr-top)
  if (parent.tagName !== 'LI' || !parent.parentElement || isLooseList(parent.parentElement)) return false;
  return parent.hasAttribute('data-mdr-task') || before();
}

function listMarkdown(c: string, n: Element): string {
  const inner = trimNl(c);
  const parent = n.parentElement;
  if (parent && parent.nodeName === 'LI') return (isLooseList(parent.parentElement!) ? '\n\n' : '\n') + inner + '\n';
  return '\n\n' + inner + '\n\n';
}

function listItemMarkdown(content: string, li: Element): string {
  const marker = listMarker(li);
  const task = li.getAttribute('data-mdr-task');
  let body = trimNl(content).replace(/^[ \t]+/, '');
  // A task item without text: `[x]` alone is not a task marker (markdown-it-task-lists wants `[x] ` and
  // content), it would show as the text "[x]"; the space the browser leaves after the checkbox keeps it one.
  if (task !== null) body = `[${task}]` + (body ? ' ' + body : ' &nbsp;');
  // An empty item cannot interrupt a paragraph: under paragraph text a bare marker line would make that
  // text a setext heading (`-`) or paragraph text (`1.`). Written with the line break the browser leaves in
  // an emptied item, it stays an item wherever it is and shows what the session showed (G8).
  if (body === '' && underText(li)) body = '<br>';
  const indent = ' '.repeat(marker.length + 1);
  body = body.replace(/\n(?=[^\n])/g, '\n' + indent);
  const line = body === '' ? marker : marker + ' ' + body;
  const list = li.parentElement!;
  return isLooseList(list) ? '\n\n' + line + '\n\n' : line + '\n';
}

/** The Markdown character just outside an inline element being converted: whitespace turndown moved out
 *  of it, a neighbouring text's (already escaped) character, MARKUP for a neighbouring element's delimiter
 *  or the enclosing element's own delimiter, '' at a line edge. */
function outsideChar(node: Element, dir: -1 | 1): string {
  const ws = (node as Element & { flankingWhitespace?: { leading: string; trailing: string } }).flankingWhitespace;
  if (ws && (dir < 0 ? ws.leading : ws.trailing)) return ' ';
  return mdNeighbour(node, dir);
}

/** Would `delim` + content + `delim` read back as emphasis here (CommonMark §6.2 flanking rules)?
 *  `content` is the converted Markdown between the delimiters, so nested delimiters count as punctuation. */
function flankOk(node: Element, content: string, delim: string, beforeOverride?: string, afterOverride?: string): boolean {
  if (content === '') return true;
  const P = (c: string): boolean => c === MARKUP || isPunct(c);
  const W = (c: string): boolean => c !== MARKUP && isWsChar(c);
  const before = beforeOverride ?? outsideChar(node, -1), after = afterOverride ?? outsideChar(node, 1);
  const first = firstCp(content), last = lastCp(content);
  const leftFlank = !W(first) && (!P(first) || W(before) || P(before));
  const rightFlank = !W(last) && (!P(last) || W(after) || P(after));
  if (delim[0] === '_') return leftFlank && rightFlank && !isAlnum(before) && !isAlnum(after);
  return leftFlank && rightFlank;
}

/** `c.replace(/[ \t]+$/gm, …)` in linear time (the regex is quadratic on a long run of spaces inside a line,
 *  G6): spaces / tabs at a line end go, except two or more before `\n` (a hard break). */
function dropLineEndSpaces(c: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < c.length;) {
    if (c[i] !== ' ' && c[i] !== '\t') { i++; continue; }
    let j = i + 1;
    while (j < c.length && (c[j] === ' ' || c[j] === '\t')) j++;
    const after = j < c.length ? c[j] : '';
    // the line terminators of `$` with the m flag
    if ((after === '' || after === '\n' || after === '\r' || after === '\u2028' || after === '\u2029') && !(after === '\n' && j - i >= 2)) {
      out += c.slice(last, i);
      last = j;
    }
    i = j;
  }
  return last === 0 ? c : out + c.slice(last);
}

/** The block root's Markdown, kept by the `mdrTop` rule (see run). */
let topOut: string | null = null;

/** Could `delim` + content + `delim` here also close (its opener) or open (its closer) another run? A
 *  strikethrough inside a strikethrough is written with `~~` only when neither can: then the inner pair
 *  cannot take the outer one's delimiters (`~~~~x~~~~` reads back, `~~a~~b~~c~~` does not). */
function delimBothWays(node: Element, content: string): boolean {
  const P = (c: string): boolean => c === MARKUP || isPunct(c);
  const W = (c: string): boolean => c !== MARKUP && isWsChar(c);
  const before = outsideChar(node, -1), after = outsideChar(node, 1);
  const first = firstCp(content), last = lastCp(content);
  return (!W(before) && (!P(before) || W(first) || P(first))) || (!W(after) && (!P(after) || W(last) || P(last)));
}

function createService(): TurndownService {
  const svc = new TurndownService({
    headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', hr: '---',
    br: '  ', preformattedCode: true,
    blankReplacement: (_content, node) => {
      const n = node as unknown as Element;
      if (n.nodeName === 'LI') return listItemMarkdown('', n);
      // a list whose items are all empty is dropped, unless it is nested and one is written `- <br>` (G8)
      if ((n.nodeName === 'UL' || n.nodeName === 'OL') && n.parentElement?.nodeName === 'LI' && _content.includes('<br>')) return listMarkdown(_content, n);
      if (n.nodeName === 'P' && n.parentElement?.nodeName === 'LI') return '\n\n';
      return (node as TNode).isBlock ? '\n\n' : '';
    },
  });
  svc.use(gfm);
  svc.escape = (s: string) => s.split(NL).join('\n');

  svc.addRule('mdrRaw', {
    filter: (n) => n.hasAttribute('data-md'),
    replacement: (_c, n) => {
      const md = (n as Element).getAttribute('data-md') ?? '';
      return (n as Element).hasAttribute('data-md-block') ? '\n\n' + md + '\n\n' : md;
    },
  });
  svc.addRule('mdrParagraph', {
    filter: (n) => n.nodeName === 'P' || (n.nodeName === 'DIV' && !n.hasAttribute('data-md')),
    replacement: (c) => '\n\n' + dropLineEndSpaces(c) + '\n\n',
  });
  svc.addRule('mdrHeading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (c, n) => {
      const level = Number(n.nodeName.charAt(1));
      const text = c.replace(/\n+/g, ' ').trim();
      return '\n\n' + '#'.repeat(level) + (text ? ' ' + text : '') + '\n\n';
    },
  });
  svc.addRule('mdrBlockquote', {
    filter: 'blockquote',
    replacement: (c) => '\n\n' + trimNl(c).split('\n').map((l) => (l === '' ? '>' : '> ' + l)).join('\n') + '\n\n',
  });
  svc.addRule('mdrList', { filter: ['ul', 'ol'], replacement: (c, n) => listMarkdown(c, n as Element) });
  svc.addRule('mdrListItem', { filter: 'li', replacement: (c, n) => listItemMarkdown(c, n as Element) });
  // A break alone on its line right before a block (an emptied item over its nested list) cannot be written:
  // a `\` there ends the paragraph and shows as text, `<br>` alone on a line starts an HTML block that takes
  // the nested list with it. It is left out: the text and the structure stay, the empty line goes.
  svc.addRule('mdrBr', { filter: 'br', replacement: (_c, n) => (brAtLineStart(n as Element) ? (brBeforeBlock(n as Element) ? '' : '\\\n') : '  \n') });
  svc.addRule('mdrHr', { filter: 'hr', replacement: () => '\n\n---\n\n' });
  svc.addRule('mdrStrong', {
    filter: ['strong', 'b'],
    replacement: (c, n) => {
      if (!c.trim()) return c;
      const e = n as Element;
      // Inside bold, `**` may pair with the outer delimiters instead (`****x**…**`, `**a**b**…**`): the other
      // delimiter where it reads back, raw HTML otherwise (check item 7).
      if (formatAncestor(e, 'strong')) {
        if (!underscoreOk(e, c)) return '<strong>' + c + '</strong>';
        e.setAttribute('data-mdr-u', '');
        return '__' + c + '__';
      }
      return flankOk(e, c, '**') && !gluedToFormatting(e) ? '**' + c + '**' : '<strong>' + c + '</strong>';
    },
  });
  svc.addRule('mdrEm', {
    filter: ['em', 'i'],
    replacement: (c, n) => {
      if (!c.trim()) return c;
      const e = n as Element;
      const p = e.parentElement;
      // `***x***` reads back as <em><strong>; an <em> filling a <strong> needs the other delimiter, as does one
      // inside another <em> (`**x* y*` does not read back, check item 7).
      const inStrong = p !== null && (p.nodeName === 'STRONG' || p.nodeName === 'B') && (p.firstChild === e || p.lastChild === e);
      const inEm = formatAncestor(e, 'em') !== null;
      if ((inStrong || inEm) && underscoreOk(e, c)) { e.setAttribute('data-mdr-u', ''); return '_' + c + '_'; }
      return flankOk(e, c, '*') && !inStrong && !inEm && !gluedToFormatting(e) ? '*' + c + '*' : '<em>' + c + '</em>';
    },
  });
  svc.addRule('mdrDel', {
    filter: (n) => n.nodeName === 'DEL' || n.nodeName === 'S' || n.nodeName === 'STRIKE',
    replacement: (c, n) => {
      if (!c.trim()) return c;
      // strikethrough inside strikethrough has no other delimiter (check item 7)
      const e = n as Element;
      return flankOk(e, c, '~~') && !gluedToFormatting(e) && !(formatAncestor(e, 'del') && delimBothWays(e, c)) ? '~~' + c + '~~' : '<del>' + c + '</del>';
    },
  });
  svc.addRule('mdrLink', {
    filter: (n) => n.nodeName === 'A',
    replacement: (c, n) => {
      const a = n as Element;
      const href = a.getAttribute('href');
      const extra = Array.from(a.attributes).some((x) => !['href', 'title', 'target', 'rel', 'data-l'].includes(x.name) && !x.name.startsWith('data-mdr'));
      // a destination with a line break / control character came from raw HTML: written back as such (U10 e)
      if (href === null || extra || CONTROL.test(href)) return openTag(a, (name) => name === 'target' || name === 'rel') + c + '</a>';
      const text = a.getAttribute('data-mdr-text') ?? '';
      if (!a.getAttribute('title') && a.children.length === 0 && text !== '') {
        // U11: the source's own `<url>` while it is one; else bare where proven, `<url>` where valid. Not
        // knowing the source, a URL holding a Markdown character (or ending in punctuation) prefers `<url>`.
        // J19 extended: the shown text is what normalizeLinkText decoded; the URL is written in the source's own
        // spelling of it (OWN_URLS), else with every escape `rawInUrl` keeps (as encodeURIComponent spells it, or in
        // lower case), and only in a spelling proven to read back as this link showing this text.
        const al = a.getAttribute('data-mdr-al');
        const own = OWN_URLS.get(href);
        const spells: string[] = own === undefined ? [] : [/^mailto:/i.test(own) && !/^mailto:/i.test(text) ? own.slice(7) : own];
        const upper = urlSpelling(text);
        if (upper !== null) spells.push(upper, upper.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase()));
        for (const s of spells) {
          const spell = urlText(s, href);
          const auto = autolinkProven(a, spell, href, text);
          if (auto && al === '1') return '<' + spell + '>';
          if ((al === '0' || !auto || !/[*_~$`&<\\]|[.,:;!?)]$/.test(spell)) && bareProven(a, spell, href, text)) return spell;
          if (auto) return '<' + spell + '>';
        }
      }
      // markdown-it finds the end of a link text with its inline rules, linkify included: a URL in the text
      // takes the backslash of a following `\]` / `\[` with it, and the text ends early. Raw HTML then (an
      // <a> turns linkify off inside it), which renders the same link.
      if (/:\/\/\S*?\\[[\]]/.test(c)) return openTag(a, (name) => name === 'target' || name === 'rel') + c + '</a>';
      return '[' + c + '](' + linkDest(href) + linkTitle(a.getAttribute('title')) + ')';
    },
  });
  svc.addRule('mdrImage', {
    filter: 'img',
    replacement: (_c, n) => {
      const img = n as Element;
      const extra = Array.from(img.attributes).some((x) => !['src', 'alt', 'title', 'loading', 'data-l'].includes(x.name));
      const src = img.getAttribute('src');
      if (src === null || extra || CONTROL.test(src)) return openTag(img, (name) => name === 'loading');
      const alt = attrRefs((img.getAttribute('alt') ?? '').replace(/([\\[\]])/g, '\\$1').replace(/\n+/g, ' '));   // (S2; B3)
      return '![' + alt + '](' + linkDest(src) + linkTitle(img.getAttribute('title')) + ')';
    },
  });
  // Tables: cells carry CELL-separated content, the table rule assembles rows + the alignment row.
  svc.addRule('mdrCell', { filter: ['th', 'td'], replacement: (c) => CELL + c.replace(/\n+/g, ' ').trim() });
  svc.addRule('mdrRow', { filter: 'tr', replacement: (c) => '\n' + c.replace(/\n/g, '') + '\n' });
  svc.addRule('mdrSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: (c) => c });
  svc.addRule('mdrTable', {
    filter: 'table',
    replacement: (c, n) => {
      const rows = c.split('\n').filter((r) => r.includes(CELL)).map((r) => r.split(CELL).slice(1));
      if (rows.length === 0) return '';
      const head = (n as HTMLTableElement).rows[0];
      const cols = Math.max(...rows.map((r) => r.length));
      const aligns: string[] = [];
      for (let i = 0; i < cols; i++) {
        const cell = head?.cells[i];
        const style = (cell?.getAttribute('style') ?? '').replace(/\s+/g, '');
        const align = /text-align:(left|right|center)/.exec(style)?.[1] ?? cell?.getAttribute('align') ?? '';
        aligns.push(align === 'left' ? ':--' : align === 'right' ? '--:' : align === 'center' ? ':-:' : '---');
      }
      const fmt = (cells: string[]): string => '| ' + cells.map((x) => x).join(' | ') + ' |';
      const out = [fmt(rows[0].concat(Array(Math.max(0, cols - rows[0].length)).fill(''))), '| ' + aligns.join(' | ') + ' |'];
      for (const r of rows.slice(1)) out.push(fmt(r));
      return '\n\n' + out.join('\n') + '\n\n';
    },
  });
  // Any other inline element: raw HTML around its converted content (markdown-it passes it through).
  svc.addRule('mdrRawInline', {
    filter: (n) => !MD_INLINE.has(n.nodeName) && !isBlockEl(n) && !n.hasAttribute('data-md'),
    replacement: (c, n) => {
      const e = n as Element;
      if (e.tagName === 'WBR') return '<wbr>';
      return openTag(e) + c + `</${e.tagName.toLowerCase()}>`;
    },
  });
  // only the root in run's box (prepare drops the attribute anywhere else)
  svc.addRule('mdrTop', { filter: (n) => n.hasAttribute('data-mdr-top') && n.parentNode?.parentNode === null, replacement: (c) => { topOut = c; return ''; } });
  return svc;
}

let service: TurndownService | null = null;

/** JavaScript's `\s` (what turndown's final trim removes). */
const JS_SPACE = /\s/;

function run(clone: Element): string {
  service ??= createService();
  looseMemo = new WeakMap();
  indexMemo = new WeakMap();
  // turndown's last step trims its output with `/[\t\r\n\s]+$/`, quadratic in the length of any whitespace run
  // inside it (a code block's blank lines, a run of U+3000; G6). So a block-level root goes in as the only child
  // of a box: the `mdrTop` rule keeps the root's Markdown (what turndown would have produced for the root
  // itself) and leaves turndown '' to trim; the same trim is done here in linear time. A blank root gets
  // turndown's blank rule instead of `mdrTop`: it is converted directly (its output has no inner whitespace run).
  if (!BLOCKISH.has(clone.tagName)) return trimNl(service.turndown(clone as HTMLElement));
  const box = clone.ownerDocument.createElement('div');
  clone.setAttribute('data-mdr-top', '');
  box.appendChild(clone);
  topOut = null;
  service.turndown(box);
  const md = topOut as string | null;
  topOut = null;
  if (md === null) return trimNl(service.turndown(clone as HTMLElement));
  let e = md.length;
  while (e > 0 && JS_SPACE.test(md[e - 1])) e--;
  return trimNl(trimStartOf(md.slice(0, e), '\t\r\n'));
}

/** Markdown for the block DOM `el` (not modified), no trailing newline. Throws NoMarkersError when the block
 *  leaves no free marker set (H15). */
export function serializeBlock(el: Element, kind: BlockKind, hints: SerializeHints = {}): string {
  if (!pickMarkers(el, hints.puaRaw, hints.urlSpellings, hints.hidden, hints.nbspRef ?? null)) throw new NoMarkersError();
  const fast = kind === BlockKind.List && !hints.uncached ? serializeListItems(el, hints) : null;
  if (fast !== null) return sourceStyle(fast, hints);
  const clone = el.cloneNode(true) as Element;
  prepare(clone, hints, kind);
  return sourceStyle(run(clone), hints);
}

// ---------------------------------------------------------------- list blocks, item by item
/** Per list item: the key it was serialized under (marker context + its HTML) and the result. */
let itemCache = new WeakMap<Element, { key: string; md: string; blank: boolean }>();

/** Cache counters for tests and benchmarks (`resetListCache` zeroes them and empties the cache). */
export const listCacheStats = { hits: 0, misses: 0 };
export function resetListCache(): void {
  itemCache = new WeakMap();
  listCacheStats.hits = 0;
  listCacheStats.misses = 0;
}

/** The list-cache key's part for `urlSpellings`: the array's identity (a session's hints keep one array, never changed;
 *  another array is another key — a miss at worst), not its JSON, which every item's key would repeat. */
const spellIds = new WeakMap<object, number>();
let spellSeq = 0;
function idOf(o: object | undefined): string {
  if (o === undefined) return '';
  let n = spellIds.get(o);
  if (n === undefined) { n = ++spellSeq; spellIds.set(o, n); }
  return String(n);
}

/** A caret to mark (see serializeBlockWithCaret): the top-level item it is in, and its position. */
interface ItemCaret { li: Element; node: Node; offset: number }

/** The top-level list of a block that is exactly one list of ≥ 8 plain items, and those items; null otherwise. */
function singleList(el: Element): { list: Element; items: Element[] } | null {
  let list: Element | null = null;
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) { if (/^[ \t\r\n]*$/.test((c as Text).data)) continue; return null; }
    if (c.nodeType !== 1) continue;
    const e = c as Element;
    if (e.hasAttribute('data-mdr-ui')) continue;
    if (list || (e.tagName !== 'UL' && e.tagName !== 'OL')) return null;
    list = e;
  }
  if (!list) return null;
  const items: Element[] = [];
  for (const c of Array.from(list.childNodes)) {
    if (c.nodeType === 3 && /^[ \t\r\n]*$/.test((c as Text).data)) continue;
    if (c.nodeType !== 1 || (c as Element).tagName !== 'LI') return null;
    items.push(c as Element);
  }
  return items.length < 8 ? null : { list, items };
}

/**
 * A block that is exactly one top-level list, serialized one item at a time with a per-item cache: the
 * whole-block conversion grows faster than linearly with the item count (turndown re-flattens the
 * accumulated output on every join), which made typing in a 300-item list cost ~45 ms per keystroke.
 * An item's Markdown depends only on its own subtree, its marker (list type, start + index) and whether
 * the list is loose; the cache key holds all of them (the item's outerHTML, its checkbox states, the
 * marker number, list tag, looseness and the hints that change the output), so a hit is by construction
 * the output a fresh serialization would give, and an item whose DOM changed is always redone.
 * The output is byte-identical to the one-pass path (`hints.uncached`; test/serialize.listcache.test.ts).
 * With `caret`, the caret's item is serialized fresh with CARET_MARK and not cached.
 * Returns null when the block is not a single plain list (the caller takes the general path).
 */
function serializeListItems(el: Element, hints: SerializeHints, caret?: ItemCaret): string | null {
  const sl = singleList(el);
  if (!sl) return null;
  const { list, items } = sl;
  if (caret && !items.includes(caret.li)) return null;
  const loose = isLooseList(list);
  const start = Number(list.getAttribute('start') ?? '1');
  const base = Number.isFinite(start) ? start : 1;
  const ctx = `${list.tagName}|${loose ? 1 : 0}|${hints.editing ? 1 : 0}|${hints.math === false ? 0 : 1}|${hints.keepNbsp ? 1 : 0}|${hints.autolinks ? JSON.stringify(hints.autolinks) : ''}|${idOf(hints.urlSpellings)}|${idOf(hints.hidden)}|${hints.nbspRef ?? ''}|${OWN_DROPPED}|${hints.stamped ? 1 : 0}|${PUA_RAW}|`;
  const one = (li: Element, i: number, mark?: ItemCaret): { md: string; blank: boolean } => {
    const shell = el.cloneNode(false) as Element;
    const l = list.cloneNode(false) as Element;
    if (list.tagName === 'OL') l.setAttribute('start', String(base + i));
    if (loose) l.setAttribute('data-mdr-loose', '');
    if (i > 0) l.setAttribute('data-mdr-cont', '');
    const copy = li.cloneNode(true) as Element;
    if (mark) insertMark(li, copy, mark.node, mark.offset);
    l.appendChild(copy);
    shell.appendChild(l);
    prepare(shell, hints, BlockKind.List);
    // Alone in its list, a blank item would make the whole list blank (turndown drops it); in the full
    // list it is turndown's blank list item: just its marker.
    const pli = l.firstElementChild;
    if (pli && turndownBlank(pli)) {
      looseMemo = new WeakMap();
      indexMemo = new WeakMap();
      return { md: trimNl(listItemMarkdown('', pli)), blank: true };
    }
    return { md: run(shell), blank: false };
  };
  const out: string[] = [];
  let allBlank = true;
  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    if (caret && caret.li === li) { const r = one(li, i, caret); allBlank &&= r.blank; out.push(r.md); continue; }
    const key = ctx + (list.tagName === 'OL' ? base + i : i === 0 ? '^' : '') + '|' + li.outerHTML + checkState(li);   // the first item may differ (underText)
    const hit = itemCache.get(li);
    if (hit && hit.key === key) { listCacheStats.hits++; allBlank &&= hit.blank; out.push(hit.md); continue; }
    listCacheStats.misses++;
    const r = one(li, i);
    itemCache.set(li, { key, md: r.md, blank: r.blank });
    allBlank &&= r.blank;
    out.push(r.md);
  }
  // every item blank: the one-pass conversion drops the (blank) list altogether
  if (allBlank) return '';
  return out.join(loose ? '\n\n' : '\n');
}

/** turndown's own `isBlank` (turndown 7): such a node goes to `blankReplacement` instead of its rule. */
const TD_VOID = ['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'];
const TD_MEANINGFUL = ['A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TH', 'TD', 'IFRAME', 'SCRIPT', 'AUDIO', 'VIDEO'];
function turndownBlank(n: Element): boolean {
  return !TD_VOID.includes(n.nodeName) && !TD_MEANINGFUL.includes(n.nodeName) && /^\s*$/i.test(n.textContent ?? '')
    && !TD_VOID.some((t) => n.getElementsByTagName(t).length > 0) && !TD_MEANINGFUL.some((t) => n.getElementsByTagName(t).length > 0);
}

/** Inserts the caret marker (CARET) into `copy` (a deep clone of `live`) at the clone of (node, offset). */
function insertMark(live: Node, copy: Node, node: Node, offset: number): void {
  const path: number[] = [];
  for (let cur: Node = node; cur !== live; cur = cur.parentNode!) path.unshift(Array.prototype.indexOf.call(cur.parentNode!.childNodes, cur));
  let target: Node = copy;
  for (const i of path) target = target.childNodes[i];
  if (target.nodeType === 3) {
    const t = target as Text;
    t.data = t.data.slice(0, offset) + CARET + t.data.slice(offset);
  } else {
    target.insertBefore(copy.ownerDocument!.createTextNode(CARET), target.childNodes[offset] ?? null);
  }
}

/** Checkbox state is a property the HTML does not show. */
function checkState(li: Element): string {
  let s = '';
  for (const b of Array.from(li.querySelectorAll('input'))) s += (b as HTMLInputElement).checked ? 'x' : 'o';
  return s;
}

// ---------------------------------------------------------------- the block's own source style
const ATX = /^#{1,6}(?:[ \t]|$)/;
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Calls `fn(line, index)` for every line outside fenced code (fence lines included in neither). */
function eachProseLine(lines: string[], fn: (line: string, i: number) => void): void {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence !== null) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(l)) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    fn(l, i);
  }
}

function delimAligns(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => {
    const t = c.trim();
    return (t.startsWith(':') ? 'l' : '') + (t.endsWith(':') ? 'r' : '');
  });
}

/** The first table delimiter row of `lines` (a pipe-bearing `---` row under a row with a pipe), or -1. */
function firstDelimRow(lines: string[]): number {
  let at = -1;
  eachProseLine(lines, (l, i) => {
    if (at < 0 && i > 0 && l.includes('|') && l.includes('-') && DELIM_ROW.test(l) && lines[i - 1].includes('|')) at = i;
  });
  return at;
}

// ---------------------------------------------------------------- S1: what the source hides
/** Anything that may be a character reference (named, decimal, hex; the HTML parser also reads some without `;`). */
const REF_ANY = /&(?:#[0-9]{1,8};?|#[xX][0-9a-fA-F]{1,7};?|[A-Za-z][A-Za-z0-9]{0,31};?)/g;
/** A reference as markdown-it's entity rule reads it (rules_inline/entity.mjs). */
const MD_REF = /^&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});$/;
const PCT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** S1, the cheap part: does `content` hold a reference or a percent-escape that may decode to a character `hideable`
 *  accepts? Only then is it rendered (sourceHidden): a block without one costs this scan. */
function mayHide(content: string): boolean {
  if (content.includes('&')) {
    for (const m of content.matchAll(REF_ANY)) {
      const r = m[0];
      if (r.charCodeAt(1) === 35) {
        const hex = r.charCodeAt(2) === 120 || r.charCodeAt(2) === 88;
        const cp = parseInt(r.slice(hex ? 3 : 2), hex ? 16 : 10);
        if (cp <= 0x10ffff && hideable(String.fromCodePoint(cp))) return true;
      } else if (r.endsWith(';')) {
        const d = mdi().utils.unescapeAll(r);
        if (d !== r && Array.from(d).some(hideable)) return true;
      } else if (content.includes('<')) return true;   // (raw HTML may read it without its `;`: the rendering decides)
    }
  }
  if (content.includes('%')) {
    for (const m of content.matchAll(PCT_RUN)) {
      let d: string;
      try { d = decodeURIComponent(m[0]); } catch { return true; }
      if (Array.from(d).some(hideable)) return true;
    }
  }
  return false;
}

/** The source's own first spelling of `c` as a reference markdown-it reads (MD_REF), or null (`content` without its code). */
function ownReference(content: string, c: string): string | null {
  for (const m of content.matchAll(REF_ANY)) if (MD_REF.test(m[0]) && mdi().utils.unescapeAll(m[0]) === c) return m[0];
  return null;
}

/** B1 (CONTRACT §11, Checkpoint H): the characters `hideable` accepts that `content` spells in a hidden way outside its
 *  code, whatever its raw count: each one a character reference there may decode to (markdown-it's reading of it; a
 *  numeric one with or without its `;`; a named one without its `;` as its longest name the HTML parser may read in raw
 *  HTML), and each one a percent-escape decodes to in the text of a bare URL or autolink (`links`: their source texts,
 *  as normalizeLinkText received them; the rendering shows that text decoded). Over-inclusion is the safe direction (an
 *  occurrence the source held raw is written as a reference too, S2); sourceHidden keeps only what the rendering shows. */
function spelledHidden(content: string, links: readonly string[]): Set<string> {
  const out = new Set<string>();
  const add = (d: string): void => { for (const c of d) if (hideable(c)) out.add(c); };
  const text = stripCode(content);
  if (text.includes('&')) {
    const seen = new Set<string>();
    const un = mdi().utils.unescapeAll;
    for (const m of text.matchAll(REF_ANY)) {
      const r = m[0];
      if (seen.has(r)) continue;
      seen.add(r);
      if (r.charCodeAt(1) === 35) {
        const hex = r.charCodeAt(2) === 120 || r.charCodeAt(2) === 88;
        const cp = parseInt(r.slice(hex ? 3 : 2), hex ? 16 : 10);
        if (cp <= 0x10ffff) add(String.fromCodePoint(cp));
      } else if (r.endsWith(';')) add(un(r));
      else {
        for (let k = r.length; k > 2; k--) {
          const t = r.slice(0, k) + ';';
          const d = un(t);
          if (d !== t) { add(d); break; }
        }
      }
    }
  }
  for (const u of links) {
    if (!u.includes('%')) continue;
    for (const c of mdi().normalizeLinkText(u)) if (hideable(c) && !u.includes(c)) out.add(c);
  }
  return out;
}

/** S1 (CONTRACT §11, Round-5 verification decisions): HIDDEN of a block whose source is `content` — every character
 *  `hideable` accepts that the block's rendering (the fidelity gate's: its texts and attribute values, renderedShows)
 *  shows more often than `content` holds it raw, and (B1 of Checkpoint H) every one it shows that the source spells in
 *  a hidden way outside code (spelledHidden), whatever its raw count — with the reference it is written as: the source's
 *  own first spelling, else `&#xHHHH;` (a spelling inside code is literal text there and does not count). A character
 *  no reference of which markdown-it reads back (a C0 or C1 control, a surrogate, a non-character) is left out: it is
 *  written as before, and the guard of inlineEdit.ts refuses a write that reveals it. `code` (B2): for each character
 *  of `hidden` the source holds raw inside code, how often. undefined when there is none. */
function sourceHidden(content: string): { hidden: Map<string, string>; code: Map<string, number> } | undefined {
  if (!mayHide(content)) return undefined;
  const shown = renderedShows(content);
  if (shown === null) return undefined;
  const more = new Map<string, number>();
  for (const c of shown.shows) if (hideable(c)) more.set(c, (more.get(c) ?? 0) + 1);
  if (more.size === 0) return undefined;
  for (const c of content) { const k = more.get(c); if (k !== undefined) more.set(c, k - 1); }
  const spelled = spelledHidden(content, shown.links);
  let out: Map<string, string> | undefined;
  for (const [c, k] of more) {
    const cp = c.codePointAt(0)!;
    if ((k <= 0 && !spelled.has(c)) || !mdi().utils.isValidEntityCode(cp)) continue;
    (out ??= new Map()).set(c, ownReference(stripCode(content), c) ?? `&#x${cp.toString(16).toUpperCase()};`);
  }
  if (!out) return undefined;
  const code = new Map<string, number>();
  for (const c of shown.code) if (out.has(c)) code.set(c, (code.get(c) ?? 0) + 1);
  return { hidden: out, code };
}

/** Style hints read off the block's source at session start (see SerializeHints). */
export function sourceStyleHints(content: string): Pick<SerializeHints, 'tightHeadings' | 'tableDelim' | 'keepNbsp' | 'autolinks' | 'urlSpellings' | 'puaRaw' | 'hidden' | 'hiddenCode' | 'nbspRef'> {
  const lines = content.split('\n');
  const out: Pick<SerializeHints, 'tightHeadings' | 'tableDelim' | 'keepNbsp' | 'autolinks' | 'urlSpellings' | 'puaRaw' | 'hidden' | 'hiddenCode' | 'nbspRef'> = { autolinks: sourceAutolinks(content), urlSpellings: sourceUrls(content) };
  const pua = markerCharsOf(content);
  if (pua !== '') out.puaRaw = pua;
  const hidden = sourceHidden(content);
  if (hidden) { out.hidden = hidden.hidden; out.hiddenCode = hidden.code; }
  if (content.includes('&')) {                     // B3: the source's own reference spelling of U+00A0 outside code
    const nb = ownReference(stripCode(content), NBSP);
    if (nb !== null) out.nbspRef = nb;
  }
  if (/&nbsp;|&#160;|&#x0*a0;|\u00a0/i.test(content)) out.keepNbsp = true;
  eachProseLine(lines, (l, i) => {
    if (ATX.test(l) && i + 1 < lines.length && lines[i + 1].trim() !== '') out.tightHeadings = true;
  });
  const d = firstDelimRow(lines);
  if (d >= 0) out.tableDelim = lines[d];
  return out;
}

/** Re-applies the block's own source style to a serialization: no blank line under an ATX heading when
 *  the source had none, the source's delimiter row while the columns and alignment are the same. Both
 *  are rendering-neutral. */
function sourceStyle(md: string, h: SerializeHints): string {
  if (!h.tightHeadings && h.tableDelim === undefined) return md;
  const lines = md.split('\n');
  if (h.tableDelim !== undefined) {
    const d = firstDelimRow(lines);
    if (d >= 0) {
      const a = delimAligns(lines[d]), b = delimAligns(h.tableDelim);
      // the serialized row's own indentation (a table inside a list item), the source row's form
      if (a.length === b.length && a.every((x, i) => x === b[i])) lines[d] = /^[ \t]*/.exec(lines[d])![0] + h.tableDelim.trim();
    }
  }
  if (h.tightHeadings) {
    const drop = new Set<number>();
    eachProseLine(lines, (l, i) => {
      if (ATX.test(l) && lines[i + 1] === '' && i + 2 < lines.length && lines[i + 2] !== '') drop.add(i + 1);
    });
    if (drop.size > 0) return lines.filter((_, i) => !drop.has(i)).join('\n');
  }
  return lines.join('\n');
}

/** `serializeBlock` with CARET_MARK inserted at (node, offset) of the LIVE `el` — used to find which
 *  source line the caret ends up on after a structural edit. Returns null when the position is outside `el`;
 *  throws NoMarkersError when the block leaves no free marker set (H15).
 *  The document's own CARET_MARK characters are U+FFFD in this result (line structure unchanged). */
export function serializeBlockWithCaret(el: Element, kind: BlockKind, node: Node, offset: number, hints: SerializeHints = {}): string | null {
  if (node !== el && !el.contains(node)) return null;
  if (!pickMarkers(el, hints.puaRaw, hints.urlSpellings, hints.hidden, hints.nbspRef ?? null)) throw new NoMarkersError();
  const marked = (md: string): string => (CARET === CARET_MARK ? md : md.split(CARET_MARK).join('\uFFFD').split(CARET).join(CARET_MARK));
  if (kind === BlockKind.List && !hints.uncached) {
    // the caret's top-level item: the item-wise path redoes only that one (a large list stays cheap)
    let top: Node = node;
    while (top.parentNode && top.parentNode !== el && top.parentNode.parentNode !== el) top = top.parentNode;
    if (top !== el && top.parentNode !== el && top.nodeType === 1 && (top as Element).tagName === 'LI') {
      const fast = serializeListItems(el, hints, { li: top as Element, node, offset });
      if (fast !== null) return marked(sourceStyle(fast, hints));
    }
  }
  const clone = el.cloneNode(true) as Element;
  insertMark(el, clone, node, offset);
  prepare(clone, hints, kind);
  return marked(sourceStyle(run(clone), hints));
}

// ---------------------------------------------------------------- normalisation (tests, diagnostics)
const PRESERVE_WS = new Set(['PRE', 'CODE', 'TEXTAREA']);
const NORM_BLOCK = new Set(['P', 'DIV', 'SECTION', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);

/**
 * Canonical form of an HTML fragment for comparisons: attributes sorted (and `data-l`, a line map, not
 * content, dropped), whitespace runs collapsed outside `pre`/`code`, whitespace-only text between block
 * elements and at the edges of block elements removed. Two fragments that render the same content
 * produce the same string.
 */
export function normalizeHtml(html: string): string {
  const t = document.createElement('template');
  t.innerHTML = html;
  const out: string[] = [];
  const walk = (n: Node, pre: boolean): void => {
    const kids = Array.from(n.childNodes);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        let d = (c as Text).data;
        if (!pre) {
          d = d.replace(/[ \t\r\n]+/g, ' ');
          const prevB = i === 0 ? n.nodeType !== 1 || NORM_BLOCK.has((n as Element).tagName) : kids[i - 1].nodeType === 1 && NORM_BLOCK.has((kids[i - 1] as Element).tagName);
          const nextB = i === kids.length - 1 ? n.nodeType !== 1 || NORM_BLOCK.has((n as Element).tagName) : kids[i + 1].nodeType === 1 && NORM_BLOCK.has((kids[i + 1] as Element).tagName);
          if (prevB) d = d.replace(/^ /, '');
          if (nextB) d = d.replace(/ $/, '');
        }
        if (d) out.push(d.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      } else if (c.nodeType === 1) {
        const e = c as Element;
        const tag = e.tagName.toLowerCase();
        const attrs = Array.from(e.attributes).filter((a) => a.name !== 'data-l').map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`).sort();
        out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
        walk(e.tagName === 'TEMPLATE' ? (e as HTMLTemplateElement).content : e, pre || PRESERVE_WS.has(e.tagName));
        out.push(`</${tag}>`);
      }
    }
  };
  walk(t.content, false);
  return out.join('');
}
