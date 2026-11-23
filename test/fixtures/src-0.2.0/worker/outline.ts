// src/worker/outline.ts — heading scan (ATX, setext, markdown headings inside glued HTML regions) with
// global slug dedupe (SPEC 4.3.9). Incremental (fix round, lead decision 8g): each block caches its heading
// entries (text, base slug, text hash) on the block object for its lifetime; a keystroke costs one O(blocks)
// filter walk plus the fingerprint. A text edit in one heading patches that entry and the slugs sharing its
// old/new base; a pure line shift patches line numbers; only an inserted/removed heading rebuilds the list.
import type { OutlineEntry } from '../shared/types';
import { BlockKind } from '../shared/types';
import { fnv1a32, fnv1a64 } from '../shared/hash';
import { scan, setextHeadings, type Block } from './segmenter';
import { slugify } from '../shared/slug';
export { slugify };

type Level = OutlineEntry['level'];
/** One heading inside a block; `off` is its 0-based line offset from the block start. */
export interface Head { level: Level; text: string; base: string; textHash: number; off: number }
/** Heading entries of one block (stored on Block.outline). */
export interface OutlineHeads { heads: Head[] }

export interface OutlineState {
  /** Flattened heads of the last build (reference-stable while their blocks are unchanged). */
  order: Head[];
  /** Parallel to `order`: line of each head at the last build (typed, so a shift check never touches entry objects). */
  lines: Int32Array;
  /** Parallel to `order`: dedupe rank (0 → base slug, n → `base-n`). */
  ranks: Int32Array;
  entries: OutlineEntry[];
  fingerprint: string;
}

export function createOutlineState(): OutlineState {
  return { order: [], lines: new Int32Array(0), ranks: new Int32Array(0), entries: [], fingerprint: '' };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.charCodeAt(0) === 35) {
      const cp = e.charCodeAt(1) === 120 || e.charCodeAt(1) === 88 ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Plain text of a heading line as the reader sees it: markers, trailing `#`, inline emphasis/code
 * markers, link syntax, images (alt is not visible text), inline HTML tags, backslash escapes and
 * entities removed/decoded. Inner whitespace is kept (it matches the rendered textContent).
 */
export function headingText(line: string): string {
  let s = line.replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '');
  // escaped punctuation is literal text: shield it (U+E000 sentinel) from the marker/tag strip below
  s = s.replace(/\\([!-/:-@[-`{-~])/g, '\uE000$1');
  s = s
    .replace(/(?<!\uE000)!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/(?<!\uE000)\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?<!\uE000)<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(?<!\uE000)[*_~`]/g, '')
    .replace(/\uE000(.)/g, '$1');
  return decodeEntities(s).trim();
}


function head(level: Level, text: string, off: number): Head {
  return { level, text, base: slugify(text), textHash: fnv1a32(level + text), off };
}

const ATX = /^ {0,3}(#{1,6})(?:\s|$)/;

function atxHead(line: string, off: number): Head | null {
  const m = ATX.exec(line);
  return m ? head(m[1].length as Level, headingText(line), off) : null;
}

function setextHeads(lines: string[], b: { kind: BlockKind; startLine: number; lineCount: number }, base: number): Head[] {
  const out: Head[] = [];
  for (const h of setextHeadings(lines, b)) {
    const parts: string[] = [];
    for (let i = h.from; i < h.to; i++) parts.push(headingText(lines[i]));
    out.push(head(h.level, parts.join(' ').trim(), h.from - base));
  }
  return out;
}

/** Markdown headings inside a (glued) HTML region: everything after a blank line is markdown again. */
function htmlHeads(lines: string[], b: Block): Head[] {
  const s = b.startLine - 1;
  const out: Head[] = [];
  scan(
    lines,
    s,
    (start, count, kind) => {
      if (kind === BlockKind.Heading) {
        const h = atxHead(lines[start], start - s);
        if (h) out.push(h);
      } else if (kind === BlockKind.Prose && count >= 2) {
        for (const h of setextHeads(lines, { kind, startLine: start + 1, lineCount: count }, s)) out.push(h);
      }
      return false;
    },
    { end: s + b.lineCount, htmlGlue: false },
  );
  return out;
}

function headsOf(lines: string[], b: Block): Head[] {
  if (b.outline) return b.outline.heads;
  const heads = computeHeads(lines, b);
  b.outline = { heads };
  return heads;
}

function computeHeads(lines: string[], b: Block): Head[] {
  if (b.kind === BlockKind.Heading) {
    const h = atxHead(lines[b.startLine - 1], 0);
    const out = h ? [h] : [];
    // the lines after the heading line are prose: a setext heading there is rendered as one too
    // (`# Title\nSubtitle\n---`), so the outline must list it (SPEC 4.3.9).
    if (b.lineCount >= 3) {
      for (const s of setextHeads(lines, { kind: BlockKind.Prose, startLine: b.startLine + 1, lineCount: b.lineCount - 1 }, b.startLine - 1)) out.push(s);
    }
    return out;
  }
  if (b.kind === BlockKind.Prose) return setextHeads(lines, b, b.startLine - 1);
  return htmlHeads(lines, b);
}

const slugOf = (base: string, rank: number): string => (rank === 0 ? base : `${base}-${rank}`);

/**
 * Recomputes the outline into `state`; returns true when the entries (text, level or line) changed.
 * `state.entries` is patched in place where possible (the previously posted array was cloned by postMessage).
 */
export function updateOutline(state: OutlineState, blocks: Block[], lines: string[]): boolean {
  const order: Head[] = [];
  const lineOf: number[] = [];
  const hashOf: number[] = [];
  const idOf: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const kind = b.kind;
    if (kind !== BlockKind.Heading && (b.lineCount < 2 || (kind !== BlockKind.Prose && kind !== BlockKind.Html))) continue;
    const heads = headsOf(lines, b);
    for (let k = 0; k < heads.length; k++) {
      const h = heads[k];
      order.push(h);
      lineOf.push(b.startLine + h.off);
      hashOf.push(h.textHash);
      idOf.push(b.id);
    }
  }
  const n = order.length;
  const prev = state.order;
  const entries = state.entries;
  if (prev.length === n) {
    // same number of headings: patch changed entries in place (text edit in a heading) and shifted lines
    let changed = false;
    for (let i = 0; i < n; i++) {
      const h = order[i];
      if (prev[i] === h) continue;
      changed = true;
      const e = entries[i];
      const oldBase = prev[i].base;
      e.text = h.text;
      e.level = h.level;
      if (oldBase !== h.base) {
        // ranks of the entries sharing the old base after i decrease, those sharing the new base increase
        // prev[j] is the head entries[j] currently reflects (positions < i are already patched)
        let before = 0;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const ejBase = prev[j].base;
          if (j < i) {
            if (ejBase === h.base) before++;
            continue;
          }
          if (ejBase === oldBase) entries[j].slug = slugOf(oldBase, --state.ranks[j]);
          else if (ejBase === h.base) entries[j].slug = slugOf(h.base, ++state.ranks[j]);
        }
        state.ranks[i] = before;
        e.slug = slugOf(h.base, before);
      }
      prev[i] = h;
    }
    const oldLines = state.lines;
    for (let i = 0; i < n; i++) {
      const line = lineOf[i];
      if (oldLines[i] !== line) {
        oldLines[i] = line;
        entries[i].line = line;
        changed = true;
      }
      const e = entries[i];
      if (e.blockId !== idOf[i]) e.blockId = idOf[i];
    }
    if (!changed && state.fingerprint !== '') return false;
  } else {
    // a heading was inserted or removed: rebuild the entries with global slug dedupe (O(headings) map work)
    const seen = new Map<string, number>();
    const fresh: OutlineEntry[] = new Array(n);
    const ranks = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const h = order[i];
      const r = seen.get(h.base) ?? 0;
      seen.set(h.base, r + 1);
      ranks[i] = r;
      fresh[i] = { level: h.level, text: h.text, slug: slugOf(h.base, r), line: lineOf[i], blockId: idOf[i] };
    }
    state.entries = fresh;
    state.order = order;
    state.lines = Int32Array.from(lineOf);
    state.ranks = ranks;
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < n; i++) {
    h1 = Math.imul(h1 ^ hashOf[i], 16777619);
    h2 = Math.imul(h2 ^ hashOf[i], 2246822519) + 0x9e3779b9;
    h1 = Math.imul(h1 ^ lineOf[i], 16777619);
    h2 = Math.imul(h2 ^ lineOf[i], 2246822519) + 0x9e3779b9;
  }
  const fp = `${h1 >>> 0}:${h2 >>> 0}:${n}`;
  if (fp === state.fingerprint) return false;
  state.fingerprint = fp;
  return true;
}

/** One-shot build over a fresh state. TEST/BENCH ONLY — the worker keeps one OutlineState and calls
 *  `updateOutline`; this helper exists so a test can compare an incremental result with a fresh build. */
export function buildOutline(blocks: Block[], lines: string[]): { entries: OutlineEntry[]; cache: Map<number, OutlineHeads> } {
  const state = createOutlineState();
  updateOutline(state, blocks, lines);
  const cache = new Map<number, OutlineHeads>();
  for (const b of blocks) if (b.outline) cache.set(b.id, b.outline);
  return { entries: state.entries, cache };
}

/** Fingerprint of a finished outline. TEST ONLY (`updateOutline` maintains its own, cheaper one). */
export function outlineFingerprint(entries: OutlineEntry[]): string {
  const [lo, hi] = fnv1a64(entries.map((e) => e.level + e.text + e.line).join('\n'));
  return `${hi}:${lo}:${entries.length}`;
}
