// src/worker/doc.ts — the worker's copy of the document as lines[] plus offset ↔ (line, col) mapping.
// Offsets are UTF-16 code units over `lines.join('\n')` (CodeMirror's coordinates). Lines are 0-based
// inside this module; the returned ChangeEffect uses 1-based lines like the rest of the protocol.
import type { TextChange } from '../shared/types';

export interface Doc {
  /** Empty document = [] (0 lines, 0 blocks). Never [''] outside applyChange. */
  lines: string[];
  /** Prefix sums of lines[i].length + 1; rebuilt lazily, invalidated by every change. A view on `startsBuf`. */
  lineStarts: Uint32Array | null;
  /**
   * Persistent backing store for `lineStarts`, grown ×1.5 and NEVER reallocated per edit (P13):
   * huge.md is 340k lines, so one prefix-sum array is 1.36 MB — and V8 puts every allocation over
   * 128 KB in large-object space, which only a major GC reclaims. Allocating a fresh one on each
   * keystroke (the previous `new Uint32Array(n)`) is megabytes of uncollected churn per second of typing.
   */
  startsBuf: Uint32Array;
}

/** 1-based line window touched by one change. */
export interface ChangeEffect { fromLine: number; toLineOld: number; toLineNew: number; lineDelta: number }

/** Resolved (0-based) positions of one change in the coordinates the change was expressed in. */
interface ResolvedChange { la: number; ca: number; lb: number; cb: number; insert: string }

export function createDoc(text: string): Doc {
  const normalised = text.indexOf('\r') >= 0 ? text.replace(/\r\n?/g, '\n') : text;
  return { lines: normalised === '' ? [] : normalised.split('\n'), lineStarts: null, startsBuf: new Uint32Array(0) };
}

export function lineStartsOf(doc: Doc): Uint32Array {
  if (doc.lineStarts) return doc.lineStarts;
  const lines = doc.lines;
  const n = Math.max(1, lines.length);
  let buf = doc.startsBuf;
  if (buf.length < n) {
    buf = new Uint32Array(Math.max(n, Math.ceil(buf.length * 1.5)));
    doc.startsBuf = buf;
  }
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    buf[i] = acc;
    acc += lines[i].length + 1;
  }
  if (lines.length === 0) buf[0] = 0; // the loop wrote nothing: the reused buffer must not show stale data
  // `subarray` is a small view object (young space), not a copy of the 1.36 MB store.
  const starts = buf.length === n ? buf : buf.subarray(0, n);
  doc.lineStarts = starts;
  return starts;
}

/** Largest line index whose start offset is ≤ offset (binary search). */
export function offsetToPos(doc: Doc, offset: number): { line: number; col: number } {
  const starts = lineStartsOf(doc);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

/**
 * Resolves every change of one transaction against the ORIGINAL document in one pass (all offsets
 * share the pre-transaction coordinates), so lineStarts is built once per transaction, not per change.
 */
export function resolveChanges(doc: Doc, changes: TextChange[]): ResolvedChange[] {
  return changes.map((c) => {
    const a = offsetToPos(doc, c.from);
    const b = c.to === c.from ? a : offsetToPos(doc, c.to);
    return { la: a.line, ca: a.col, lb: b.line, cb: b.col, insert: c.insert };
  });
}

/** Applies one resolved change (callers apply a transaction's changes in REVERSE order). */
export function applyResolved(doc: Doc, r: ResolvedChange): ChangeEffect {
  const lines = doc.lines;
  if (lines.length === 0) lines.push('');
  const la = Math.min(r.la, lines.length - 1);
  const lb = Math.min(r.lb, lines.length - 1);
  const joined = lines[la].slice(0, r.ca) + r.insert + lines[lb].slice(r.cb);
  const fresh = joined.split('\n');
  const removed = lb - la + 1;
  if (fresh.length === removed) for (let i = 0; i < removed; i++) lines[la + i] = fresh[i];
  else spliceLines(lines, la, removed, fresh);
  doc.lineStarts = null;
  return { fromLine: la + 1, toLineOld: lb + 1, toLineNew: la + fresh.length, lineDelta: fresh.length - removed };
}

/** Convenience for tests and single changes: resolve + apply. */
export function applyChange(doc: Doc, c: TextChange): ChangeEffect {
  return applyResolved(doc, resolveChanges(doc, [c])[0]);
}

/** Appends `lines[l1][c1 …]` up to `lines[l2][… c2]` (0-based, end-exclusive column) to `parts`. */
function pushRange(parts: string[], lines: string[], l1: number, c1: number, l2: number, c2: number): void {
  if (l1 > l2 || (l1 === l2 && c1 >= c2)) return;
  if (l1 === l2) {
    parts.push(lines[l1].slice(c1, c2));
    return;
  }
  parts.push(lines[l1].slice(c1));
  if (l2 - l1 > 1) parts.push('\n', lines.slice(l1 + 1, l2).join('\n'));
  parts.push('\n', lines[l2].slice(0, c2));
}

/**
 * Applies EVERY change of one transaction in a SINGLE pass over the affected line range (CONTRACT §7).
 * `changes` are ascending, non-overlapping and expressed in ORIGINAL (pre-transaction) offsets, exactly as
 * `ChangeSet.iterChanges` yields them. The affected range `[firstLine, lastLine]` is rebuilt once by
 * concatenating the untouched segments with the inserts, split once and spliced into `lines` once, so the
 * cost is O(affected text + changes) instead of O(changes × lines-in-block) (findings-r3, worker finding A).
 * Returns null for an empty change list.
 */
export function applyChanges(doc: Doc, changes: TextChange[]): ChangeEffect | null {
  if (changes.length === 0) return null;
  if (changes.length === 1) return applyResolved(doc, resolveChanges(doc, changes)[0]);
  const resolved = resolveChanges(doc, changes);
  const lines = doc.lines;
  if (lines.length === 0) lines.push('');
  const last = lines.length - 1;
  const a = Math.min(resolved[0].la, last);
  let b = a;
  for (let i = 0; i < resolved.length; i++) {
    const e = Math.min(resolved[i].lb, last);
    if (e > b) b = e;
  }
  const parts: string[] = [];
  let cl = a;
  let cc = 0;
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    const la = Math.min(r.la, last);
    const lb = Math.min(r.lb, last);
    pushRange(parts, lines, cl, cc, la, la === r.la ? r.ca : lines[la].length);
    if (r.insert !== '') parts.push(r.insert);
    const cb = lb === r.lb ? r.cb : lines[lb].length;
    if (lb > cl || (lb === cl && cb > cc)) {
      cl = lb;
      cc = cb;
    }
  }
  pushRange(parts, lines, cl, cc, b, lines[b].length);
  const fresh = parts.join('').split('\n');
  const removed = b - a + 1;
  if (fresh.length === removed) for (let i = 0; i < removed; i++) lines[a + i] = fresh[i];
  else spliceLines(lines, a, removed, fresh);
  doc.lineStarts = null;
  return { fromLine: a + 1, toLineOld: b + 1, toLineNew: a + fresh.length, lineDelta: fresh.length - removed };
}

/** Collapses the single-empty-line representation back to the canonical empty document. */
export function normaliseEmpty(doc: Doc): void {
  if (doc.lines.length === 1 && doc.lines[0] === '') {
    doc.lines.length = 0;
    doc.lineStarts = null;
  }
}

export function docText(doc: Doc): string {
  return doc.lines.join('\n');
}

/** splice() without spreading `fresh` as arguments (a pasted 200k-line text would overflow the stack). */
function spliceLines(lines: string[], at: number, removed: number, fresh: string[]): void {
  if (fresh.length < 10000) {
    lines.splice(at, removed, ...fresh);
    return;
  }
  const tail = lines.slice(at + removed);
  lines.length = at;
  for (let i = 0; i < fresh.length; i++) lines.push(fresh[i]);
  for (let i = 0; i < tail.length; i++) lines.push(tail[i]);
}
