// src/worker/segmenter.ts — SPEC 4.3: line scanner (TEXT / FENCE / HTML1 / MATH), glue rules,
// windowed resegmentation and the deterministic identity rule. The single source of truth for blocks.
import { BlockKind } from '../shared/types';
import { fnv1a64 } from '../shared/hash';
import { blockCounts } from './stats';
import type { ChangeEffect } from './doc';
import type { OutlineHeads } from './outline';

export interface Segment { start: number; count: number; kind: BlockKind } // start is a 0-based line index

export interface Block {
  id: number;
  startLine: number; // 1-based
  lineCount: number;
  kind: BlockKind;
  hashLo: number;
  hashHi: number;
  chars: number;
  charsNoSpace: number;
  cjk: number;
  latinWords: number;
  /** Source may define a link reference (prefilter; core.ts lets markdown-it's block parser decide). */
  hasRef: boolean;
  /** Source contains `]`: rendering may depend on the reference definitions (SPEC 4.3.7). */
  hasBracket: boolean;
  hasDollar: boolean;
  /** Last render exceeded the slow threshold (core.ts throttles re-renders of slow blocks). */
  slow: boolean;
  lastRenderAt: number;
  /** When this block last changed through an edit (core.ts clock); 0 for a freshly loaded document. */
  lastEditAt: number;
  /** Code-block coalescing (core.ts): a pending deferred render must not start before this time. */
  renderAfter: number;
  /** Heading entries of this block (outline.ts), computed lazily; valid for the block's lifetime because a
   *  block object is only reused (pass 1 of the identity rule) when its source hash is unchanged. */
  outline: OutlineHeads | null;
  /** core.ts: this exact content has been rendered at least once (the LRU may since have evicted it).
   *  Valid for the block's lifetime for the same reason as `outline`; core.ts clears it when the
   *  reference set or the render options change. The document-wide dirty walk (SPEC 4.5 priority 3)
   *  skips warmed blocks: without it every keystroke restarted a full pass that re-rendered every block
   *  the 64 MB cache had evicted — 50 000 renders per keystroke on huge.md. */
  warmed: boolean;
}

const { Prose, Heading, Code, Table, List, Quote, Html, Math: MathKind, Hr } = BlockKind;

// ---------------------------------------------------------------- line classification
const BLANK = /^\s*$/;
const ATX = /^ {0,3}#{1,6}(\s|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HTML1_OPEN = /^ {0,3}<(pre|script|style|textarea)(\s|>|$)/i;
const HTML1_CLOSE = /<\/(pre|script|style|textarea)>/i;
const COMMENT_OPEN = /^ {0,3}<!--/;
const COMMENT_CLOSE = /-->/;
const MATH_OPEN = /^ {0,3}\$\$/;
const HR = /^ {0,3}(\*\s*){3,}$|^ {0,3}(-\s*){3,}$|^ {0,3}(_\s*){3,}$/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4})(?=\S)|^( {0,3})([-*+]|\d{1,9}[.)])( {5,}|\s*$)/;
const QUOTE = /^ {0,3}>/;
const HTML_KIND = /^ {0,3}<[a-zA-Z!/?]/;
const TABLE_DELIM = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
/** Label of a reference definition: `]` may appear escaped (`[a\]b]: url`). The colon may be followed by
 *  the destination with no whitespace at all (`[a]:/url` is a definition in CommonMark and markdown-it),
 *  so the prefilter must not require one — it only decides which blocks are worth parsing. */
const REF_LABEL = String.raw`\[(?:\\[^\n]|[^\]\\\n])+\]`;
const REF_DEF = new RegExp(`^ {0,3}${REF_LABEL}:`, 'm');
/** Definition possibly nested behind quote / list markers (prefilter only). */
const REF_ANY = new RegExp(`${REF_LABEL}:`, 'm');
const INDENTED = /^( {2}|\t)/;
const INDENTED4 = /^( {4}|\t)/;

/** CommonMark HTML block type 6 tag names (start an HTML block that ends at the next blank line). */
const HTML6_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML6 = new RegExp(`^ {0,3}</?(${HTML6_NAMES})(\\s|/?>|$)`, 'i');
const ATTR = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"'=<>\`]+|'[^']*'|"[^"]*"))?)*`;
/** Type 7: a complete open or closing tag alone on its line. */
const HTML7 = new RegExp(`^ {0,3}(?:<[a-zA-Z][a-zA-Z0-9-]*${ATTR}\\s*/?>|</[a-zA-Z][a-zA-Z0-9-]*\\s*>)\\s*$`);
const HTML_OTHER = /^ {0,3}<(\?|![A-Z]|!\[CDATA\[)/;
/** Container elements whose unclosed open tag glues the following blocks (README `<details>` / `<div align>` pattern). */
const CONTAINER_NAMES = 'address|article|aside|blockquote|center|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|header|li|main|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|tr|ul';
const CONTAINER_OPEN = new RegExp(`^ {0,3}<(${CONTAINER_NAMES})(\\s|>|$)`, 'i');
/** SPEC fix round: an unclosed container glues at most this many lines. */
export const HTML_GLUE_MAX_LINES = 400;

const enum St { Text, Fence, Html, Math }

/** Scanner state for the non-TEXT modes (module-level: scans are synchronous and never nested). */
const S = { st: St.Text, fenceChar: 96, fenceLen: 0, close: HTML1_CLOSE };

function isBlank(line: string): boolean {
  return line.length === 0 || BLANK.test(line);
}

/** Index of the first char after ≤ 3 leading spaces, or -1 if the line is indented ≥ 4 (a tab counts as 4) / blank. */
function construct(line: string): number {
  let i = 0;
  for (;;) {
    const c = line.charCodeAt(i);
    if (c === 9) return -1;
    if (c !== 32) break;
    if (i >= 3) return -1;
    i++;
  }
  return i >= line.length ? -1 : i;
}

/** Leading-space count of a line (a tab counts as 4). */
function indentOf(line: string): number {
  let i = 0;
  let n = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) n++;
    else if (c === 9) n += 4;
    else break;
  }
  return n;
}

export function isAtxHeading(line: string): boolean {
  const p = construct(line);
  return p >= 0 && line.charCodeAt(p) === 35 && ATX.test(line);
}

/** Indented code line (≥ 4 spaces or a tab) that is not blank. */
function isIndentedCode(line: string): boolean {
  return INDENTED4.test(line) && !isBlank(line);
}

/** Column where the content of a list item starts (CommonMark: marker + 1–4 spaces; ≥ 5 spaces → marker + 1). */
export function listContentIndent(line: string): number {
  const m = LIST_MARKER.exec(line);
  if (!m) return 2;
  if (m[1] !== undefined) return m[1].length + m[2].length + m[3].length;
  return m[4].length + m[5].length + 1;
}

/** Does `line` start a CommonMark HTML block (types 1–7)? Such lines are raw HTML until their end condition. */
export function isHtmlBlockStart(line: string): boolean {
  const p = construct(line);
  if (p < 0 || line.charCodeAt(p) !== 60) return false;
  return HTML1_OPEN.test(line) || COMMENT_OPEN.test(line) || HTML_OTHER.test(line) || HTML6.test(line) || HTML7.test(line);
}

/** HTML block types 1–6 — the only ones that may interrupt a paragraph, so they turn the rest of a
 *  running block into raw HTML (type 7 needs a preceding blank line and is therefore not included). */
export function htmlInterruptsParagraph(line: string): boolean {
  const p = construct(line);
  if (p < 0 || line.charCodeAt(p) !== 60) return false;
  return HTML1_OPEN.test(line) || COMMENT_OPEN.test(line) || HTML_OTHER.test(line) || HTML6.test(line);
}

/**
 * Does `line` start a list that markdown-it would render as a new list (SPEC 4.3, fix round)?
 * Lists always start a block, so blank-separated items and continuation paragraphs stay in one List
 * block and the nested-heading rule applies. `interrupt` is set when the running block's last line can
 * be a paragraph continuation (CommonMark: only a non-empty item, and an ordered one starting at 1,
 * may interrupt a paragraph); a thematic break or a setext underline is not a list.
 */
export function startsListBlock(line: string, interrupt: boolean): boolean {
  const p = construct(line);
  if (p < 0) return false;
  const c = line.charCodeAt(p);
  const bullet = c === 42 || c === 45 || c === 43;
  if (!bullet && !(c >= 48 && c <= 57)) return false;
  const m = LIST.exec(line);
  if (!m || HR.test(line)) return false;
  if (!interrupt) return true;
  if (SETEXT.test(line)) return false;
  if (!bullet && line.charCodeAt(p) !== 49) return false; // `2.` cannot interrupt a paragraph
  if (!bullet && line.charCodeAt(p + 1) !== 46 && line.charCodeAt(p + 1) !== 41) return false; // `10.` neither
  return line.slice(p + m[1].length).trim() !== ''; // an empty item cannot interrupt a paragraph
}

/** Tag name of a container element opened at the start of `line` (README pattern), or null. */
function containerOpened(line: string): string | null {
  const m = CONTAINER_OPEN.exec(line);
  return m ? m[1].toLowerCase() : null;
}

const tagRes = new Map<string, RegExp>();

/** Net number of `<tag …>` minus `</tag>` occurrences on one line (self-closing tags do not count). */
function tagBalance(line: string, tag: string): number {
  if (line.indexOf('<') < 0) return 0;
  let re = tagRes.get(tag);
  if (!re) {
    re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi');
    tagRes.set(tag, re);
  }
  re.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === '/') n--;
    else if (!m[0].endsWith('/>')) n++;
  }
  return n;
}

/** Enters FENCE / HTML1 / MATH state when `line` opens one that it does not also close. */
function openState(line: string): void {
  const p = construct(line);
  if (p < 0) return;
  const c = line.charCodeAt(p);
  if (c === 96 || c === 126) {
    const m = FENCE_OPEN.exec(line);
    if (!m || (c === 96 && m[2].indexOf('`') >= 0)) return;
    S.st = St.Fence;
    S.fenceChar = c;
    S.fenceLen = m[1].length;
  } else if (c === 60) {
    if (HTML1_OPEN.test(line)) {
      if (!HTML1_CLOSE.test(line)) {
        S.st = St.Html;
        S.close = HTML1_CLOSE;
      }
    } else if (COMMENT_OPEN.test(line) && !COMMENT_CLOSE.test(line)) {
      S.st = St.Html;
      S.close = COMMENT_CLOSE;
    }
  } else if (c === 36 && MATH_OPEN.test(line)) {
    if (line.indexOf('$$', p + 2) < 0) S.st = St.Math;
  }
}

function closes(line: string): boolean {
  if (S.st === St.Fence) {
    const m = FENCE_CLOSE.exec(line);
    return m !== null && m[1].charCodeAt(0) === S.fenceChar && m[1].length >= S.fenceLen;
  }
  if (S.st === St.Math) return line.indexOf('$$') >= 0;
  return S.close.test(line);
}

function isFenceOpener(line: string): boolean {
  const m = FENCE_OPEN.exec(line);
  return m !== null && !(m[1].charCodeAt(0) === 96 && m[2].indexOf('`') >= 0);
}

/**
 * Number of cells in one table row: one optional leading and one optional trailing `|` are dropped,
 * then the row is split on every unescaped `|` (markdown-it's `escapedSplit` + shift/pop, SPEC 4.3.4).
 */
function tableCells(line: string): number {
  let s = line.trim();
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124 && s.charCodeAt(s.length - 2) !== 92) s = s.slice(0, -1);
  let n = 1;
  for (let j = 0; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) j++;
    else if (c === 124) n++;
  }
  return n;
}

/**
 * GFM table head at line `i`: a header row containing `|` followed by a delimiter row with EXACTLY the
 * same cell count (markdown-it bails out otherwise). The cell-count test is what keeps the table rule
 * from shadowing a setext heading: `配置项 | 说明` + `---` is 2 cells vs 1, so it stays Prose and the
 * setext scan in outline.ts finds the `<h2>` markdown-it actually renders (findings-r3, worker finding D).
 */
function isTableHead(lines: string[], i: number): boolean {
  const head = lines[i];
  if (head.indexOf('|') < 0 || i + 1 >= lines.length) return false;
  const delim = lines[i + 1];
  return TABLE_DELIM.test(delim) && tableCells(delim) === tableCells(head);
}

/** Block kind from its first line (SPEC 4.3.4). Indented code (≥ 4 spaces / tab) is `Code` like a fence. */
export function kindOf(lines: string[], i: number): BlockKind {
  const line = lines[i];
  const p = construct(line);
  if (p >= 0) {
    const c = line.charCodeAt(p);
    if (c === 35 && ATX.test(line)) return Heading;
    if ((c === 96 || c === 126) && isFenceOpener(line)) return Code;
    if ((c === 42 || c === 45 || c === 95) && HR.test(line)) return Hr;
    if ((c === 42 || c === 45 || c === 43 || (c >= 48 && c <= 57)) && LIST.test(line)) return List;
    if (c === 62) return Quote;
    if (c === 36 && line.startsWith('$$', p)) return MathKind;
    if (c === 60 && HTML_KIND.test(line)) return Html;
  } else if (isIndentedCode(line)) return Code;
  if (isTableHead(lines, i)) return Table;
  return Prose;
}

/** Glue across a blank line (SPEC 4.3.2 + indented code): the block continues with `next`. */
function glues(kind: BlockKind, indentedCode: boolean, next: string): boolean {
  if (kind === List) return LIST.test(next) || INDENTED.test(next);
  if (kind === Quote) return QUOTE.test(next);
  if (indentedCode) return isIndentedCode(next);
  return false;
}

export interface ScanOptions {
  /** Scan stops at this 0-based line (exclusive); default lines.length. */
  end?: number;
  /** Glue an unclosed HTML container across blank lines (default true; off when scanning inside such a region). */
  htmlGlue?: boolean;
}

/**
 * Scans `lines` from `from` (0-based), calling `emit` for each block. `emit` returns true to stop.
 * Every block starts in TEXT state; trailing blank lines belong to the preceding block.
 */
export function scan(lines: string[], from: number, emit: (start: number, count: number, kind: BlockKind) => boolean, o?: ScanOptions): void {
  const n = o?.end ?? lines.length;
  const htmlGlue = o?.htmlGlue ?? true;
  let i = from;
  while (i < n) {
    const start = i;
    const first = lines[i];
    const kind = kindOf(lines, i);
    // (c) a heading nested in a list item (indent ≥ the item's content indent) stays in the list
    const listIndent = kind === List ? listContentIndent(first) : 0;
    const indentedCode = kind === Code && construct(first) < 0;
    // a list line ends the running block (lists always start a block); `interrupt` blocks whose last
    // line can be a lazy paragraph continuation only yield to a list that may interrupt a paragraph
    const listInterrupt = kind !== Heading && kind !== Hr && kind !== Code;
    // (d) raw HTML (types 1–7): `#` lines are not headings until the block's first blank line
    let raw = kind === Html && isHtmlBlockStart(first);
    // (f) README pattern: an unclosed container glues the following blocks up to its closing tag
    const container = htmlGlue && kind === Html ? containerOpened(first) : null;
    // an open tag may span several lines (`<div\n  align="center">`): count it as open and resume the
    // balance scan after the `>` that ends it (a `>` inside a quoted attribute value ends the scan too,
    // which only means the tag counts as open — the region still glues).
    let openTagDone = true;
    let balance = 0;
    if (container !== null) {
      const gt = first.indexOf('>');
      if (gt < 0) {
        balance = 1;
        openTagDone = false;
      } else balance = tagBalance(first, container);
    }
    let closerSeen = container !== null && openTagDone && balance <= 0;
    S.st = St.Text;
    openState(first);
    i++;
    for (;;) {
      if (S.st !== St.Text) {
        while (i < n && !closes(lines[i])) i++;
        if (i < n) i++;
        S.st = St.Text;
        continue;
      }
      if (i >= n) break;
      const line = lines[i];
      if (isBlank(line)) {
        let j = i + 1;
        while (j < n && isBlank(lines[j])) j++;
        i = j;
        raw = false;
        if (j >= n) break;
        if (glues(kind, indentedCode, lines[j])) continue;
        if (container && !closerSeen && j - start < HTML_GLUE_MAX_LINES) {
          raw = isHtmlBlockStart(lines[j]);
          continue;
        }
        break;
      }
      const inRaw = raw || (container !== null && !closerSeen);
      if (isAtxHeading(line) && !inRaw && !(kind === List && indentOf(line) >= listIndent)) break;
      if (!inRaw && kind !== List && startsListBlock(line, listInterrupt)) break;
      if (container !== null && !closerSeen) {
        if (!openTagDone) {
          const gt = line.indexOf('>');
          if (gt >= 0) {
            openTagDone = true;
            balance += tagBalance(line.slice(gt + 1), container);
          }
        } else balance += tagBalance(line, container);
        if (openTagDone && balance <= 0) closerSeen = true;
      } else if (!raw && htmlInterruptsParagraph(line)) {
        // an HTML block of types 1–6 interrupts the running block: raw until the next blank line
        raw = true;
      }
      openState(line);
      i++;
    }
    if (emit(start, i - start, kind)) return;
  }
}

export function segmentAll(lines: string[]): Segment[] {
  const out: Segment[] = [];
  scan(lines, 0, (start, count, kind) => {
    out.push({ start, count, kind });
    return false;
  });
  return out;
}

// ---------------------------------------------------------------- blocks
export function blockSource(lines: string[], b: { startLine: number; lineCount: number }): string {
  const s = b.startLine - 1;
  return b.lineCount === 1 ? lines[s] : lines.slice(s, s + b.lineCount).join('\n');
}

/** One setext heading inside a prose block: paragraph lines [from, to) (0-based, absolute) underlined at `to`. */
export interface SetextHeading { level: 1 | 2; from: number; to: number }

/**
 * Setext headings of a prose block (outline only): every `===` / `---` line that follows ≥ 1 paragraph
 * line underlines the paragraph that started after the previous underline (CommonMark: the underline
 * ends the paragraph, so `a\n---\nb\n---` is two h2s).
 */
export function setextHeadings(lines: string[], b: { kind: BlockKind; startLine: number; lineCount: number }): SetextHeading[] {
  const out: SetextHeading[] = [];
  if (b.kind !== Prose || b.lineCount < 2) return out;
  const s = b.startLine - 1;
  let e = s + b.lineCount - 1;
  while (e > s && isBlank(lines[e])) e--;
  let p = s;
  for (let i = s; i <= e; i++) {
    const line = lines[i];
    if (isBlank(line)) return out;
    if (!SETEXT.test(line)) continue;
    if (i === p) {
      // `---` starting a paragraph is a thematic break; `===` alone is text
      if (line.trimStart().charCodeAt(0) === 45) p = i + 1;
      continue;
    }
    out.push({ level: line.trimStart().charCodeAt(0) === 61 ? 1 : 2, from: p, to: i });
    p = i + 1;
  }
  return out;
}

/** Level of the block's first setext heading, or 0. */
export function setextLevel(lines: string[], b: { kind: BlockKind; startLine: number; lineCount: number }): 1 | 2 | 0 {
  const h = setextHeadings(lines, b);
  return h.length ? h[0].level : 0;
}

/** Largest index whose startLine ≤ line (line beyond the end → last block). */
export function indexOfBlockContaining(blocks: Block[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (blocks[mid].startLine <= line) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface ReconcileResult {
  blocks: Block[]; // the (possibly new) array
  removed: Block[]; // old blocks whose identity was dropped or replaced
  added: Block[]; // new blocks (kept ids included, so stats can be re-added)
  dirty: number[]; // ids whose content changed or that were created
  /** The reconcile is exactly `blocks.splice(index, removed.length, ...added)`: the index of the first
   *  replaced block in the OLD array. Blocks after `index + removed.length` keep id/kind/lineCount and
   *  shift `startLine` by the transaction's lineDelta — which is what a StructureDeltaMsg encodes. */
  index: number;
}

interface Pending { seg: Segment; source: string; lo: number; hi: number }

function hashSegments(lines: string[], segs: Segment[]): Pending[] {
  return segs.map((seg) => {
    const source = blockSource(lines, { startLine: seg.start + 1, lineCount: seg.count });
    const [lo, hi] = fnv1a64(source);
    return { seg, source, lo, hi };
  });
}

/**
 * Prefilter for reference definitions (SPEC 4.3.7, fix round): text inside a fence / indented code / raw HTML
 * cannot define a reference, so only the part of the source that markdown-it would parse as markdown counts.
 * markdown-it's block parser makes the final decision in core.ts (definitions cannot interrupt a paragraph).
 */
export function mayDefineReference(kind: BlockKind, source: string): boolean {
  if (source.indexOf(']:') < 0) return false;
  if (kind === Code) {
    const nl = source.indexOf('\n');
    if (nl < 0) return false;
    const m = FENCE_OPEN.exec(source.slice(0, nl));
    if (m) {
      // fenced: only text after the closing fence can hold a definition
      const re = new RegExp(`^ {0,3}${m[1].charAt(0) === '`' ? '`' : '~'}{${m[1].length},}[ \\t]*$`, 'm');
      const rest = source.slice(nl + 1);
      const c = re.exec(rest);
      return c !== null && REF_DEF.test(rest.slice(c.index + c[0].length));
    }
    return REF_DEF.test(source);
  }
  if (kind === Html) {
    if (HTML1_OPEN.test(source) || COMMENT_OPEN.test(source)) {
      const close = (COMMENT_OPEN.test(source) ? COMMENT_CLOSE : HTML1_CLOSE).exec(source);
      return close !== null && REF_DEF.test(source.slice(close.index + close[0].length));
    }
    // raw HTML until the first blank line; markdown (glued container region) after it
    const blank = /\n[ \t]*\n/.exec(source);
    return blank !== null && REF_ANY.test(source.slice(blank.index + blank[0].length));
  }
  return REF_ANY.test(source);
}

/** A changed block; `prev` (the block whose id it inherits) carries the slow-render state across edits. */
function makeBlock(p: Pending, id: number, prev?: Block): Block {
  const c = blockCounts(p.source);
  return {
    id, startLine: p.seg.start + 1, lineCount: p.seg.count, kind: p.seg.kind, hashLo: p.lo, hashHi: p.hi,
    chars: c.chars, charsNoSpace: c.charsNoSpace, cjk: c.cjk, latinWords: c.latinWords,
    hasRef: mayDefineReference(p.seg.kind, p.source), hasBracket: p.source.indexOf(']') >= 0, hasDollar: p.source.indexOf('$') >= 0,
    slow: prev?.slow ?? false, lastRenderAt: prev?.lastRenderAt ?? 0, lastEditAt: prev?.lastEditAt ?? 0,
    renderAfter: prev?.renderAfter ?? 0, outline: null, warmed: false,
  };
}

function inherit(p: Pending, o: Block): Block {
  return { ...o, startLine: p.seg.start + 1, lineCount: p.seg.count, kind: p.seg.kind };
}

/**
 * Identity rule (SPEC 4.3.6) between old blocks O and new segments N.
 * Pass 1: equal (hash, lineCount) → same id, clean. Pass 2: zip the rest in order → same id, dirty.
 * Pass 3: surplus N get fresh ids (dirty); surplus O are dropped.
 */
export function identify(lines: string[], O: Block[], segs: Segment[], alloc: () => number): { N: Block[]; dirty: number[] } {
  const pend = hashSegments(lines, segs);
  const byKey = new Map<string, number[]>();
  for (let j = 0; j < O.length; j++) {
    const o = O[j];
    const key = `${o.hashLo}:${o.hashHi}:${o.lineCount}`;
    const q = byKey.get(key);
    if (q) q.push(j);
    else byKey.set(key, [j]);
  }
  const N: Block[] = new Array(pend.length);
  const claimed = new Uint8Array(O.length);
  const unmatched: number[] = [];
  for (let i = 0; i < pend.length; i++) {
    const p = pend[i];
    const q = byKey.get(`${p.lo}:${p.hi}:${p.seg.count}`);
    const j = q?.shift();
    if (j === undefined) unmatched.push(i);
    else {
      claimed[j] = 1;
      N[i] = inherit(p, O[j]);
    }
  }
  const dirty: number[] = [];
  let oj = 0;
  for (const i of unmatched) {
    while (oj < O.length && claimed[oj]) oj++;
    const prev = oj < O.length ? O[oj++] : undefined;
    N[i] = makeBlock(pend[i], prev ? prev.id : alloc(), prev);
    dirty.push(N[i].id);
  }
  return { N, dirty };
}

/** Full segmentation with fresh ids (setDoc). */
export function buildBlocks(lines: string[], alloc: () => number): Block[] {
  return identify(lines, [], segmentAll(lines), alloc).N;
}

/**
 * SPEC 4.3.5: rescan from the block before the one containing `fromLine`; stop at the first boundary
 * beyond the edit that coincides with a shifted old boundary. Blocks after it keep identity.
 */
export function resegmentWindow(blocks: Block[], lines: string[], e: ChangeEffect, alloc: () => number): ReconcileResult {
  if (lines.length === 0) return { blocks: [], removed: blocks, added: [], dirty: [], index: 0 };
  if (blocks.length === 0) {
    const N = buildBlocks(lines, alloc);
    return { blocks: N, removed: [], added: N, dirty: N.map((b) => b.id), index: 0 };
  }
  let a = Math.max(0, indexOfBlockContaining(blocks, e.fromLine) - 1);
  // An HTML container region that hit the glue cap ends at a boundary that depends on the text after it
  // (a closing tag typed later would extend it): rescan from that region too.
  while (a > 0 && blocks[a - 1].kind === Html && blocks[a - 1].lineCount >= HTML_GLUE_MAX_LINES) a--;
  const kOldEnd = indexOfBlockContaining(blocks, e.toLineOld);
  let k = blocks.length;
  const segs: Segment[] = [];
  scan(lines, blocks[a].startLine - 1, (start, count, kind) => {
    segs.push({ start, count, kind });
    const next = start + count + 1; // 1-based line of the next block
    if (next <= e.toLineNew || next > lines.length) return false;
    const found = findOldStart(blocks, kOldEnd + 1, next - e.lineDelta);
    if (found < 0) return false;
    k = found;
    return true;
  });
  const O = blocks.slice(a, k);
  const { N, dirty } = identify(lines, O, segs, alloc);
  if (e.lineDelta !== 0) for (let i = k; i < blocks.length; i++) blocks[i].startLine += e.lineDelta;
  let out = blocks;
  if (N.length === O.length) for (let i = 0; i < N.length; i++) blocks[a + i] = N[i];
  else out = blocks.slice(0, a).concat(N, blocks.slice(k));
  return { blocks: out, removed: O, added: N, dirty, index: a };
}

/** Binary search for an old block index ≥ lo with the given startLine, or -1. */
function findOldStart(blocks: Block[], lo: number, startLine: number): number {
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const s = blocks[mid].startLine;
    if (s === startLine) return mid;
    if (s < startLine) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Throws when `blocks` does not tile `lines` (used by tests). */
export function checkInvariants(blocks: Block[], lines: string[]): void {
  let line = 1;
  const ids = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.startLine !== line) throw new Error(`block ${i} starts at ${b.startLine}, expected ${line}`);
    if (b.lineCount <= 0) throw new Error(`block ${i} has lineCount ${b.lineCount}`);
    if (ids.has(b.id)) throw new Error(`duplicate id ${b.id}`);
    ids.add(b.id);
    line += b.lineCount;
  }
  if (line - 1 !== lines.length) throw new Error(`blocks cover ${line - 1} lines, doc has ${lines.length}`);
}
