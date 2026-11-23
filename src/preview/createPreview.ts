// src/preview/createPreview.ts — PreviewApi (SPEC §5): stateless prefix/suffix reconcile by id, height
// model driven materialization window, budgeted mounting, idle-time eviction. The document is tiled by
// `div.md-chunk` placeholders of ~256 blocks; only the chunks near the window hold `section.md-block`
// wrappers, the rest are empty divs carrying exactly the height the model assigns to their blocks.
// Hot paths (applyStructureDelta, scroll, sync queries, mounting) read no layout except
// scrollTop/clientHeight in updateWindow / runEvict. A FULL `structure` — setDoc, a resync, a worker
// restart, never a keystroke — additionally runs one synchronous updateWindow so the new worker learns
// the materialization window before the next frame (lead decision 5).
import 'katex/dist/katex.min.css';
import '../styles/preview.css';
import '../styles/hljs.css';
import { fnv1a32 } from '../shared/hash';
import { T } from '../shared/i18n';
import { unpackHtml } from '../shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, BlockKind, HTML_FLAG_PLAIN, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED, MOUNT_SLICE_MS,
  type BlockInfo, type CreatePreview, type HtmlMsg, type Line, type OutlineEntry, type PreviewApi, type StructureDeltaMsg,
  type StructureMsg,
} from '../shared/types';
// Rule L (CONTRACT §11, Round-4 verification decisions): only TYPES of the editing module here; its code is a chunk of
// its own, loaded the first time the preview is told to become editable (inlineEditLoader.ts).
import type { InlineEditApi, InlineEditHost } from './inlineEdit';
import { INLINE_EDIT_OFF, inlineEditLoaded, loadInlineEdit } from './inlineEditLoader';
import { HeightModel, estimateHeight } from './heights';
import { attachInteractions, taskLineIn, type TaskAnswer, type TaskStamp } from './interactions';
import { pickFocusElement } from './focusLine';
import { createMountQueue, type QueuedItem } from './mountQueue';
import { sanitizeToFragment } from './sanitize';

const WINDOW_ABOVE = 1.5, WINDOW_BELOW = 2.5;   // screens, relative to the scroller height
const EVICT_SCREENS = 20, EVICT_MAX = 300, EVICT_INTERVAL_MS = 500;
/** A mounted block that becomes stale more than this many blocks outside the window is evicted at once. */
const STALE_EVICT_MARGIN = 16;
const GIANT_BYTES = 262144, GIANT_SETTLE_MS = 500;
/** Longest payload the redundant-push guard hashes (≈0.3 ms); above it a re-push is simply accepted. */
const HASH_MAX_CHARS = 131072;
/** A mounted block still stale this long after its structure arrived is re-requested (missed push). */
const STALE_RESCUE_MS = 700;
/** Wrappers per `div.md-chunk`. Chunks keep the article's child count small, so a change inside one
 *  block re-lays out ≈ CHUNK siblings instead of every wrapper of a 100k-block document. Chunks grow
 *  (middle insertions) and shrink (removals) with edits; empty ones are removed. */
const CHUNK = 256;
/** Chunks are the unit of *wrapper* materialization too: only chunks this close (in chunk slots) to the
 *  materialization window hold `section.md-block` wrappers at all. Everything further away is a dormant
 *  chunk — one empty div whose height is the model's sum for its blocks. A pending wrapper costs ≈1 KB of
 *  renderer memory (element + attributes + computed style + layout box), so the 100k of a 6.6 MB document
 *  are ≈100 MB of the P13 budget; with this bound ~14 chunks (≈3.5k wrappers) are live at a time. */
const CHUNK_MAT_MARGIN = 1;
/** …and they are given back only this much further out, so small scrolls never re-create wrappers. */
const CHUNK_KEEP_MARGIN = 6;
/** Chunks materialized / released per pass. Building 256 wrappers (or dropping 256 with their mounted
 *  content) costs a few ms of style + layout, so a fast scroll that jumps several chunks spreads the work
 *  over frames instead of producing one long frame; the rest follows on the next rAF. */
const CHUNK_MAT_MAX = 2, CHUNK_DEM_MAX = 2;
/** PLAIN payloads are mounted as independent block-level pieces of at most this many characters, so
 *  Chrome never lays out one multi-MB line box (superlinear) and an edit re-lays out one piece only. */
export const PLAIN_PIECE_CHARS = 65536;
/** Shown above a PLAIN prose block: the source is too large to render (RenderOptions.maxHtmlChars), so the
 *  literal Markdown is what the user sees. Without it the downgrade is indistinguishable from a render bug. */
export const PLAIN_NOTE_TEXT = '此段落过长，已按纯文本显示';
/** Navigation anchor: after scrollToLine the target line is re-applied while blocks above it are
 *  measured (ResizeObserver), for at most this long / this many passes (SPEC §5.3, lead decision 6). */
const ANCHOR_MS = 600, ANCHOR_PASSES = 5, ANCHOR_PX = 1;
const USER_SCROLL_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

const requestIdle: (fn: () => void) => number =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => window.setTimeout(fn, 50);
const cancelIdle: (h: number) => void =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : (h) => window.clearTimeout(h);

/**
 * Splits PLAIN text into pieces of ≤ `max` characters, cutting after a newline whenever one exists in
 * the piece (a single longer line is cut mid-line). Pieces keep their trailing newline, so pieces of a
 * text with normal lines are stable under an edit inside one of them (only that piece changes).
 */
export function splitPlain(text: string, max = PLAIN_PIECE_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const n = text.length;
  let start = 0;
  while (start < n) {
    let end = start + max;
    if (end >= n) { out.push(text.slice(start)); break; }
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl >= start) end = nl + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Rough intrinsic height of a plain piece: its line count, or its wrapped length for long lines. */
function pieceEstimate(text: string, code: boolean): number {
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  const perLine = code ? 84 : 60, lh = code ? 23 : 28;
  return Math.max(lines, Math.ceil(text.length / perLine)) * lh;
}

/** Text of each mounted plain piece (compared on re-mount so untouched pieces keep their layout). */
const pieceText = new WeakMap<Element, string>();

/**
 * Lifts every `pre.md-code[data-lang]` of a freshly mounted block into a `div.md-codewrap` carrying the
 * same `data-lang`, so preview.css can paint the language badge from the wrapper.
 *
 * The badge cannot be drawn by the `pre` itself: that element is the fence's horizontal scroller, a
 * `float` is ignored by its `white-space: pre` lines (the old `::before` was painted over the code
 * glyphs) and anything positioned inside it travels with `scrollLeft`. The wrapper is a plain
 * `position: relative` box outside the scrolled content, so the badge stays in the corner.
 *
 * A Code block is one `pre` and takes the fast path; container blocks (list items, quotes, HTML) may
 * hold several fences and are walked. Blocks without a fenced-with-language block cost one property
 * read plus one `querySelector`.
 */
export function wrapCodeFences(w: HTMLElement): void {
  const only = w.childElementCount === 1 ? (w.firstElementChild as HTMLElement | null) : null;
  if (only && only.tagName === 'PRE' && only.classList.contains('md-code') && only.dataset.lang !== undefined) {
    wrapFence(w, only);
    return;
  }
  const pres = w.querySelectorAll<HTMLElement>('pre.md-code[data-lang]');
  for (let k = 0; k < pres.length; k++) {
    const pre = pres[k];
    const parent = pre.parentElement;
    if (parent) wrapFence(parent, pre);
  }
}

function wrapFence(parent: HTMLElement, pre: HTMLElement): void {
  if (parent.classList.contains('md-codewrap')) return;
  const wrap = parent.ownerDocument.createElement('div');
  wrap.className = 'md-codewrap';
  wrap.dataset.lang = pre.dataset.lang ?? '';
  parent.insertBefore(wrap, pre);
  wrap.appendChild(pre);
}

/** One `div.md-chunk`: a run of `n` consecutive blocks, with or without their wrappers (`live`). */
interface Chunk { el: HTMLElement; n: number; live: boolean }

export const createPreview: CreatePreview = (opts) => {
  const { bus } = opts;
  const el = document.createElement('div');
  el.className = 'mdr-preview';
  const body = document.createElement('article');
  body.className = 'mdr-preview__body markdown-body';
  el.appendChild(body);
  opts.parent.appendChild(el);

  const model = new HeightModel();
  const els = new Map<number, HTMLElement>();          // wrappers currently in the DOM
  const indexById = new Map<number, number>();         // every block of the current structure
  const measured = new Map<number, number>();          // last ResizeObserver height, pinned on eviction
  const mounted = new Set<number>();
  const requested = new Set<number>();
  /** Mounted, stale blocks whose newer HTML was dropped (pane hidden / outside the window): re-requested when they enter the window. */
  const lost = new Set<number>();
  const staleSince = new Map<number, number>();
  /** Highest payload version accepted (queued, deferred or mounted) per id; older payloads are dropped. */
  const latest = new Map<number, number>();
  const giant = new Map<number, { item: QueuedItem; timer: number }>();
  /** Length + hash of the payload currently mounted per block (see the redundant-push guard in applyHtml). */
  const mountedPayload = new Map<number, { len: number; hash: number }>();
  /** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): stamps. A payload's stamp — (its version, the
   *  block's start line, its line count), given in applyHtml when that version is the structure's and the preview is
   *  not desynced — travels with the item (mount queue, giant path, heldItem); mountItem makes it the stamp of the
   *  wrapper ELEMENT the payload is mounted in (a recreated wrapper never inherits one) and removes it for an item
   *  without one. A session that takes a block removes its wrapper's stamp (hold). */
  const payloadStamp = new WeakMap<QueuedItem, TaskStamp>();
  const wrapperStamp = new WeakMap<HTMLElement, TaskStamp>();
  /** Blocks a session has released whose re-render has not mounted (release; emptied by a mount, an eviction, a
   *  forget). Not `lost`: that also holds stale blocks whose refresh was dropped, which are known by their stamp. */
  const released = new Set<number>();
  /** The version of the last full structure that ended a desync: the structure's own numbers stand for a block's
   *  HTML only when its stamp is at least this (below it the stamp itself is used). */
  let stampFloor = -1;
  let outline: OutlineEntry[] = [];
  /** In-preview editing (CONTRACT §11): the block being edited (-1 = none). Its worker HTML is held back in
   *  `heldItem` until the session ends, it is never evicted and its chunk never goes dormant. */
  let editId = -1;
  let heldItem: QueuedItem | null = null;
  /** U9: the wrapper of the session's block after the session wrote that block's deletion. No block owns it
   *  any more, but it stays where the block was (inside its chunk, skipped by every chunk-child index) until
   *  the session releases it. It is never moved: moving the focused element would take the focus from it. */
  let ghost: HTMLElement | null = null;
  /** The element of the ghost's chunk once that chunk left the chunk list: it stays in place, holding only
   *  the ghost (no longer a chunk), and goes with it. */
  let ghostHolder: HTMLElement | null = null;
  /** Focus line (CONTRACT §9): the line the user is on, mirrored from the editor or set by a click/selection
   *  in this pane. `focusEl` is the ONE element currently carrying `.is-focus`; `focusBlockId` is the block
   *  that owns it, so the mount path can test "is this my block?" in O(1). */
  let focusLine: Line | null = null;
  let focusEl: HTMLElement | null = null;
  let focusBlockId = -1;
  let visible = true;
  let winFirst = 0, winLast = -1;  // materialization window (block indices); empty when last < first
  let winCentre = 0;               // block index at the viewport centre, refreshed with the window
  let vpFirst = 0, vpLast = 0;     // last viewport() sent
  let acceptAll = false, evictionOff = false;
  let awaitingFirstVisible = false;
  let disposed = false;
  /** Version of the last structure message (full or delta) that was applied; deltas must not go backwards. */
  let structureVersion = -1;
  /** Set when a `structureDelta` could not be applied: `opts.resync()` has been called ONCE and every
   *  further delta is ignored until the full `structure` it asks for arrives (CONTRACT §8). Applying a
   *  delta on a base the worker no longer has would leave the block table, the heights and every
   *  line ↔ scrollTop mapping silently wrong for the rest of the session. */
  let desynced = false;

  // ---------------------------------------------------------------- rAF / idle handles
  let winRaf = 0, scrollRaf = 0, settleRaf = 0, mountAllRaf = 0, focusRaf = 0;
  /** Belt and braces for a missed push (a restarted worker whose window was never replayed, a dropped
   *  batch): a mounted block that is still stale this long after the structure is re-requested, so the
   *  preview can never stay frozen until the user happens to scroll. */
  let staleRescueTimer = 0;
  let evictTimer = 0, evictIdle = 0, lastEvict = 0;
  const scrollHandlers = new Set<() => void>();

  function scheduleWindow(): void {
    if (!winRaf && !disposed) winRaf = requestAnimationFrame(() => { winRaf = 0; updateWindow(); });
  }

  function scheduleStaleRescue(): void {
    if (staleRescueTimer || disposed) return;
    staleRescueTimer = window.setTimeout(() => {
      staleRescueTimer = 0;
      if (disposed || !visible || model.count === 0 || winLast < winFirst) return;
      const ids: number[] = [];
      for (let i = Math.max(0, winFirst - STALE_EVICT_MARGIN); i <= winLast + STALE_EVICT_MARGIN && i < model.count; i++) {
        const id = model.id(i);
        if (held(id)) continue;
        if (!mounted.has(id) || !staleSince.has(id) || requested.has(id) || queue.has(id) || giant.has(id)) continue;
        requested.add(id);
        ids.push(id);
      }
      if (ids.length > 0) opts.request(ids);
      else scheduleWindow();
    }, STALE_RESCUE_MS);
  }

  // ---------------------------------------------------------------- chunks
  /** Document-order list of chunks; Σ n === model.count, no empty chunk. */
  let chunks: Chunk[] = [];
  /** starts[k] = block index of chunks[k]'s first block; rebuilt lazily (≈1500 entries for 6.6 MB). */
  let starts = new Int32Array(0);
  let startsDirty = true;
  /** Chunks whose `--chunk-h` no longer matches the model (membership or a block height changed). */
  const dirtyChunks = new Set<Chunk>();

  function chunkStarts(): Int32Array {
    if (startsDirty || starts.length !== chunks.length) {
      if (starts.length !== chunks.length) starts = new Int32Array(chunks.length);
      let acc = 0;
      for (let k = 0; k < chunks.length; k++) { starts[k] = acc; acc += chunks[k].n; }
      startsDirty = false;
    }
    return starts;
  }

  /** Index of the chunk containing block index `i` (clamped); -1 when there is no chunk. */
  function chunkAt(i: number): number {
    const n = chunks.length;
    if (n === 0) return -1;
    const st = chunkStarts();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= i) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function markChunkAt(i: number): void {
    const k = chunkAt(i);
    if (k >= 0) dirtyChunks.add(chunks[k]);
  }

  /** --chunk-h := Σ model heights of the chunk's blocks (its height while dormant, its intrinsic size
   *  while skipped by content-visibility). Only chunks marked dirty are touched. */
  function flushChunkHeights(): void {
    if (dirtyChunks.size === 0) return;
    const st = chunkStarts();
    const hs = model.heights;
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      if (!dirtyChunks.has(c)) continue;
      const from = st[k], to = from + c.n;
      let sum = 0;
      for (let i = from; i < to; i++) sum += hs[i];
      c.el.style.setProperty('--chunk-h', `${sum}px`);
    }
    dirtyChunks.clear();
  }

  function newChunk(n: number): Chunk {
    const el2 = document.createElement('div');
    el2.className = 'md-chunk is-dormant';
    el2.dataset.n = String(n);
    return { el: el2, n, live: false };
  }

  function setChunkCount(c: Chunk, n: number): void {
    c.n = n;
    c.el.dataset.n = String(n);
    dirtyChunks.add(c);
    startsDirty = true;
  }

  /** Builds the wrappers of chunk `k` (it must be within the materialization margin). */
  function materialize(k: number): void {
    const c = chunks[k];
    if (c.live) return;
    const from = chunkStarts()[k];
    c.el.appendChild(createRange(from, from + c.n));
    c.el.classList.remove('is-dormant');
    c.live = true;
    scheduleFocus();   // the focused block may have just got its wrapper back
  }

  /**
   * Gives a far-away chunk's wrappers (and anything mounted in them) back to the browser. The model keeps
   * every height — pinned measurements included — and the empty chunk keeps exactly that height, so
   * nothing shifts and every line ↔ scrollTop mapping stays valid. Never called for a chunk that can
   * reach the materialization window (CHUNK_KEEP_MARGIN) nor while eviction is off (mountAll).
   */
  function dematerialize(k: number): void {
    const c = chunks[k];
    if (!c.live) return;
    const from = chunkStarts()[k], to = from + c.n;
    for (let i = from; i < to; i++) {
      const id = model.id(i);
      cancelGiant(id);
      const w = els.get(id);
      if (w && mounted.has(id)) ro?.unobserve(w);
      els.delete(id);
      mounted.delete(id);
      mountedPayload.delete(id);
      requested.delete(id);
      lost.delete(id);
      released.delete(id);
      queue.remove(id);
    }
    c.el.replaceChildren();
    c.el.classList.add('is-dormant');
    c.live = false;
    dirtyChunks.add(c);
    scheduleFocus();
  }

  /** `keep`: the ghost (U9) survives in its chunk element, which stays in place as the ghost's holder. */
  function clearChunks(keep: HTMLElement | null = null): void {
    const holder = keep && keep.parentElement && keep.parentElement.parentElement === body ? keep.parentElement : null;
    if (holder) {
      for (const n of Array.from(body.children)) if (n !== holder) n.remove();
      ghost = keep;
      holdGhost(holder);
    } else {
      body.replaceChildren();
      ghost = null;
      ghostHolder = null;
    }
    chunks = [];
    dirtyChunks.clear();
    startsDirty = true;
  }

  /** Turns a chunk element that leaves the chunk list into the ghost's holder (see `ghostHolder`). */
  function holdGhost(el2: HTMLElement): void {
    for (const n of Array.from(el2.children)) if (n !== ghost) n.remove();
    el2.className = 'md-ghost-holder';
    el2.removeAttribute('data-n');
    el2.style.removeProperty('--chunk-h');
    ghostHolder = el2;
  }

  /** The `offset`-th wrapper of live chunk `c` (null past its end); the emptied wrapper (`ghost`) is not one. */
  function wrapperAt(c: Chunk, offset: number): Element | null {
    if (!ghost || ghost.parentElement !== c.el) return c.el.children[offset] ?? null;
    let k = 0;
    for (let n = c.el.firstElementChild; n; n = n.nextElementSibling) {
      if (n === ghost) continue;
      if (k++ === offset) return n;
    }
    return null;
  }

  /** Removes `count` blocks starting at old block index `from` from the chunk list (DOM + counts). `keep`:
   *  the wrapper of a removed block that stays in place as the emptied element (U9). */
  function removeChunkRange(from: number, count: number, keep: HTMLElement | null = null): void {
    if (count <= 0 || chunks.length === 0) return;
    const st = chunkStarts();
    let k = chunkAt(from);
    let offset = from - st[k];
    let left = count;
    while (left > 0 && k < chunks.length) {
      const c = chunks[k];
      const take = Math.min(c.n - offset, left);
      if (take <= 0) { k++; offset = 0; continue; }
      if (c.live) {
        let node = wrapperAt(c, offset);
        for (let t = 0; t < take && node; t++) {
          let nx = node.nextElementSibling;
          if (nx && nx === ghost) nx = nx.nextElementSibling;
          if (node === keep) ghost = keep;
          else node.remove();
          node = nx;
        }
      }
      left -= take;
      if (c.n === take) {
        if (ghost && ghost.parentElement === c.el) holdGhost(c.el);
        else c.el.remove();
        dirtyChunks.delete(c);
        chunks.splice(k, 1);
      } else {
        setChunkCount(c, c.n - take);
        k++;
      }
      offset = 0;
    }
    startsDirty = true;
  }

  /** Appends chunks covering the new block range [from, to) (the tail of the document). */
  function appendChunkRange(from: number, to: number): void {
    let i = from;
    const last = chunks[chunks.length - 1];
    if (last && last.n < CHUNK) {
      const take = Math.min(CHUNK - last.n, to - i);
      if (last.live) last.el.appendChild(createRange(i, i + take));
      setChunkCount(last, last.n + take);
      i += take;
    }
    if (i >= to) return;
    const frag = document.createDocumentFragment();
    const fresh: Chunk[] = [];
    for (; i < to; i += CHUNK) {
      const end = Math.min(to, i + CHUNK);
      const c = newChunk(end - i);
      fresh.push(c);
      dirtyChunks.add(c);
      frag.appendChild(c.el);
    }
    body.appendChild(frag);
    chunks.push(...fresh);
    startsDirty = true;
  }

  /**
   * Inserts `count` blocks at new block index `from`. A short run joins the containing chunk while it
   * stays reasonably small; a longer run gets dormant chunks of its own (splitting the containing chunk
   * at the insertion point), so even a 190k-block paste costs a few hundred empty divs.
   */
  function insertChunkRange(from: number, count: number): void {
    if (count <= 0) return;
    const covered = model.count - count;
    if (from >= covered) { appendChunkRange(from, from + count); return; }
    const st = chunkStarts();
    const k = chunkAt(from);
    const c = chunks[k];
    const offset = from - st[k];
    if (c.n + count <= 2 * CHUNK) {
      if (c.live) c.el.insertBefore(createRange(from, from + count), wrapperAt(c, offset));
      setChunkCount(c, c.n + count);
      return;
    }
    let at = k;                                   // fresh chunks go before chunks[at]
    if (offset > 0) {
      const tail = newChunk(c.n - offset);
      if (c.live) {
        tail.live = true;
        tail.el.classList.remove('is-dormant');
        let node = wrapperAt(c, offset);
        while (node) {
          const nx = node.nextElementSibling;
          tail.el.appendChild(node);
          node = nx;
        }
      }
      c.el.after(tail.el);
      chunks.splice(k + 1, 0, tail);
      setChunkCount(c, offset);
      dirtyChunks.add(tail);
      at = k + 1;
    }
    const frag = document.createDocumentFragment();
    const fresh: Chunk[] = [];
    for (let i = from; i < from + count; i += CHUNK) {
      const end = Math.min(from + count, i + CHUNK);
      const nc = newChunk(end - i);
      fresh.push(nc);
      dirtyChunks.add(nc);
      frag.appendChild(nc.el);
    }
    body.insertBefore(frag, chunks[at].el);
    chunks.splice(at, 0, ...fresh);
    startsDirty = true;
  }

  /** Materializes the chunks around the window, gives back the ones far outside it — at most
   *  CHUNK_MAT_MAX / CHUNK_DEM_MAX per pass, the rest on the next frame. */
  function syncLiveChunks(first: number, last: number): void {
    const nk = chunks.length;
    if (nk === 0) return;
    const c0 = chunkAt(first), c1 = chunkAt(last);
    const matFrom = Math.max(0, c0 - CHUNK_MAT_MARGIN), matTo = Math.min(nk - 1, c1 + CHUNK_MAT_MARGIN);
    let more = false;
    let mat = CHUNK_MAT_MAX;
    for (let k = matFrom; k <= matTo; k++) {
      if (chunks[k].live) continue;
      if (mat-- <= 0) { more = true; break; }
      materialize(k);
    }
    if (!evictionOff) {
      const keepFrom = Math.max(0, c0 - CHUNK_KEEP_MARGIN), keepTo = Math.min(nk - 1, c1 + CHUNK_KEEP_MARGIN);
      const editIdx = editId >= 0 ? indexById.get(editId) : undefined;
      const editChunk = editIdx === undefined ? -1 : chunkAt(editIdx);
      let dem = CHUNK_DEM_MAX;
      for (let k = 0; k < nk; k++) {
        if (k >= keepFrom && k <= keepTo) continue;
        if (k === editChunk) continue;   // the block being edited keeps its wrapper
        if (ghost && ghost.parentElement === chunks[k].el) continue;   // …and so does an emptied one (U9)
        if (!chunks[k].live) continue;
        if (dem-- <= 0) { more = true; break; }
        dematerialize(k);
      }
    }
    flushChunkHeights();
    if (more) scheduleWindow();
  }

  // ---------------------------------------------------------------- wrappers
  function newWrapper(id: number, estH: number): HTMLElement {
    const w = document.createElement('section');
    w.className = 'md-block is-pending';
    w.dataset.id = String(id);
    w.style.setProperty('--est-h', `${estH}px`);
    els.set(id, w);
    return w;
  }

  function makeWrapper(i: number): HTMLElement {
    return newWrapper(model.id(i), model.heights[i]);
  }

  function createRange(from: number, to: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(makeWrapper(i));
    return frag;
  }

  function cancelGiant(id: number): void {
    const g = giant.get(id);
    if (!g) return;
    clearTimeout(g.timer);
    giant.delete(id);
    els.get(id)?.classList.remove('is-slow');
  }

  /** Bookkeeping for a block that left the structure; its wrapper is removed by the chunk surgery. */
  function forgetBlock(id: number): void {
    const w = els.get(id);
    if (w && mounted.has(id)) ro?.unobserve(w);
    els.delete(id);
    indexById.delete(id);
    mounted.delete(id);
    measured.delete(id);
    requested.delete(id);
    lost.delete(id);
    released.delete(id);
    staleSince.delete(id);
    latest.delete(id);
    mountedPayload.delete(id);
    queue.remove(id);
    cancelGiant(id);
  }

  /** U9 + U14: the edit session just wrote the deletion of its emptied block, and the identity rule handed that
   *  block's id to another block (deleting a first block keeps the blank line before its content, which then
   *  belongs to the next block: that block's lines changed, so no old block matches it and it inherits the
   *  first unmatched old id). The id must leave the unchanged prefix / suffix (old indices [lo, hi) of the
   *  replaced range; `p` / `s` counted inside it), so the session's wrapper is removed as the emptied element
   *  (kept in place) and the block that now has the id gets a wrapper of its own. H20: only a structure that shows
   *  the deletion (`version` at least the deletion write's): an older one still has the session's block itself. */
  function unkeepReusedId(p: number, s: number, lo: number, hi: number, version: number): [number, number] {
    if (editId < 0 || ghost !== null || !inline.keepsRemoved(editId, version)) return [p, s];
    const at = indexById.get(editId);
    if (at === undefined || at < lo || at >= hi) return [p, s];
    if (at < lo + p) p = at - lo;
    if (at >= hi - s) s = hi - 1 - at;
    return [p, s];
  }

  /** The block whose worker HTML waits for the edit session (never requested, dimmed, evicted or mounted
   *  meanwhile) — not a block that only shares the id of the session's emptied wrapper (see unkeepReusedId). */
  function held(id: number): boolean {
    return id === editId && (ghost === null || Number(ghost.dataset.id) !== id || els.get(id) === ghost);
  }

  // ---------------------------------------------------------------- structure
  function applyStructure(m: StructureMsg): void {
    // A full structure is the state the worker really holds: it ends any desync (CONTRACT §8) and, because
    // it is also what follows a worker restart, it invalidates every `need` still outstanding — those were
    // addressed to a worker that no longer exists and will never be answered. Forgetting them is what lets
    // `updateWindow` below ask the new worker for the blocks in the window again (decision 5).
    restampChanged(m.changed);
    if (desynced) stampFloor = m.version;   // (U16: what was mounted during the desync is not described by this)
    desynced = false;
    structureVersion = m.version;
    requested.clear();
    const nb = m.blocks, ob = model.blocks;
    const nNew = nb.length / BLOCK_STRIDE, nOld = model.count;
    const minLen = Math.min(nOld, nNew);
    let p = 0;
    while (p < minLen && ob[p * BLOCK_STRIDE + B_ID] === nb[p * BLOCK_STRIDE + B_ID]) p++;
    let s = 0;
    while (s < minLen - p && ob[(nOld - 1 - s) * BLOCK_STRIDE + B_ID] === nb[(nNew - 1 - s) * BLOCK_STRIDE + B_ID]) s++;

    // No id survives: a setDoc-sized replacement (or the first structure). Every chunk goes away below
    // and the new (dormant) ones are created from scratch.
    const reset = p === 0 && s === 0;
    [p, s] = unkeepReusedId(p, s, 0, nOld, m.version);
    if (nNew > 0 && (nOld === 0 || reset)) {
      performance.mark('mdr:structure');
      awaitingFirstVisible = true;
    }
    // A new document ends a running mountAll; an ordinary edit does not: its walk restarts below so the
    // changed / inserted wrappers are requested too, and the HTML already in flight for far-away pending
    // blocks is still accepted (the worker's responses to edits made just before the command may only be
    // dispatched after it started — dropping them would leave those blocks pending until scrolled to).
    const keepMountAll = mountAllResolve !== null && !reset && nNew > 0;
    if (!keepMountAll) {
      resolveMountAll();
      evictionOff = false;
      acceptAll = false;
    }

    // U9: the edit session wrote the deletion of its emptied block: the block leaves the structure, its
    // wrapper stays where it was (the session lives on in it).
    const keep = editId >= 0 && inline.keepsRemoved(editId) ? (ghost ?? els.get(editId) ?? null) : null;
    // Removed ids (before insertion so a moved id is recreated cleanly).
    for (let i = p; i < nOld - s; i++) forgetBlock(ob[i * BLOCK_STRIDE + B_ID]);
    if (reset) clearChunks(keep);
    else removeChunkRange(p, nOld - s - p, keep);
    // setDoc resets the worker's own viewport to lines 1..1, and a re-seed (save-as, a restarted worker)
    // leaves the line window numerically unchanged — updateWindow would not re-emit it. Force one: the
    // signature of a setDoc-sized pass is "no id survives" or "every block is dirty".
    if (reset || (nNew > 0 && m.changed.length >= nNew)) vpFirst = vpLast = -1;

    // Heights: the prefix keeps its slots, the suffix is moved inside the persistent buffer, the middle
    // gets estimates or pinned measurements. No full-document array is allocated unless the capacity grew.
    model.replaceStructure(nb, p, s);
    for (let i = p; i < nNew - s; i++) {
      const id = nb[i * BLOCK_STRIDE + B_ID];
      model.heights[i] = measured.get(id) ?? estimateHeight(nb[i * BLOCK_STRIDE + B_KIND], nb[i * BLOCK_STRIDE + B_LINES]);
      indexById.set(id, i);
    }
    if (nNew !== nOld) for (let i = nNew - s; i < nNew; i++) indexById.set(nb[i * BLOCK_STRIDE + B_ID], i);

    // Chunks for the inserted middle (dormant; syncLiveChunks builds the wrappers that are needed).
    insertChunkRange(p, nNew - s - p);
    if (reset && model.count > 0) { winFirst = 0; winLast = visible ? 0 : -1; winCentre = 0; }
    afterStructureChange(m.changed, m.version, keepMountAll, true);
  }

  /**
   * Every invariant `applyStructureDelta` relies on, checked before a single array is touched. A delta that
   * fails one of them would leave the preview's block table different from the worker's with nothing to
   * say so; the caller turns a `false` here into one `opts.resync()`.
   *
   * The checks are O(removed + inserted) — a handful of entries per keystroke — and cover the three ways a
   * delta can be wrong: out-of-range indices, a version that goes backwards (a gap / reordering), and a
   * replacement that does not tile the document (start lines, line counts, `lineDelta`, `lineCount`).
   */
  function deltaIsApplicable(m: StructureDeltaMsg): boolean {
    const ins = m.inserted;
    const nOld = model.count;
    if (!Number.isInteger(m.index) || !Number.isInteger(m.removed) || !Number.isInteger(m.lineDelta)
      || !Number.isInteger(m.version) || !Number.isInteger(m.lineCount)) return false;
    if (m.index < 0 || m.removed < 0 || m.index + m.removed > nOld) return false;
    if (ins.length % BLOCK_STRIDE !== 0) return false;
    if (m.version < structureVersion) return false;               // out of order / a gap in the stream
    const insCount = ins.length / BLOCK_STRIDE;
    const nNew = nOld - m.removed + insCount;
    // The replacement must tile the document: the first inserted block starts where the block before the
    // replaced range ends, and each following one starts where the previous ends.
    const base = m.index === 0 ? 1 : model.startLine(m.index - 1) + model.lineCount(m.index - 1);
    let end = base;
    for (let j = 0; j < insCount; j++) {
      const o = j * BLOCK_STRIDE;
      if (ins[o + B_START] !== end || ins[o + B_LINES] <= 0) return false;
      end += ins[o + B_LINES];
    }
    let removedLines = 0;
    for (let i = m.index; i < m.index + m.removed; i++) removedLines += model.lineCount(i);
    if (end - base - removedLines !== m.lineDelta) return false;
    if (nNew === 0) return m.lineCount <= 1;                      // empty document (CONTRACT §5)
    const oldLines = nOld === 0 ? 0 : model.startLine(nOld - 1) + model.lineCount(nOld - 1) - 1;
    const newLines = m.index + m.removed < nOld ? oldLines + m.lineDelta : end - 1;
    return newLines === m.lineCount;
  }

  /** One resync per desync: ask the App for a full `structure` and ignore deltas until it arrives. */
  function requestResync(): void {
    if (desynced) return;
    desynced = true;
    opts.resync();
  }

  /**
   * Incremental structure update (CONTRACT §7): `blocks[index, index+removed)` become `inserted` and every
   * later block shifts by `lineDelta`. The persistent typed arrays are spliced in place, so a keystroke on a
   * 100k-block document allocates nothing (P13) — and, crucially, blocks whose id survives the replacement
   * keep their wrapper element, their measured height and their mounted content.
   */
  function applyStructureDelta(m: StructureDeltaMsg): void {
    const ins = m.inserted;
    const nOld = model.count;
    // Already desynced: ignore everything until the full `structure` the resync asks for lands.
    if (desynced) return;
    // A delta the preview cannot apply is never half-applied — and never silently dropped either: the
    // worker cannot learn that the preview rejected a message, so the preview asks for a full structure.
    if (!deltaIsApplicable(m)) { requestResync(); return; }
    restampChanged(m.changed);
    const insCount = ins.length / BLOCK_STRIDE;
    const nNew = nOld - m.removed + insCount;
    structureVersion = m.version;

    // Narrow the replacement to the blocks whose identity really changes: an edit re-sends the edited block
    // with its id intact, and re-creating that wrapper would re-mount (and flash) an untouched block.
    const minLen = Math.min(m.removed, insCount);
    let p = 0;
    while (p < minLen && model.id(m.index + p) === ins[p * BLOCK_STRIDE + B_ID]) p++;
    let s = 0;
    while (s < minLen - p && model.id(m.index + m.removed - 1 - s) === ins[(insCount - 1 - s) * BLOCK_STRIDE + B_ID]) s++;
    [p, s] = unkeepReusedId(p, s, m.index, m.index + m.removed, m.version);
    const from = m.index + p, gone = m.removed - p - s, born = insCount - p - s;

    // A delta is never a reset, so a running mountAll keeps going (see applyStructure).
    const keepMountAll = mountAllResolve !== null && nNew > 0;
    if (!keepMountAll) {
      resolveMountAll();
      evictionOff = false;
      acceptAll = false;
    }

    // U9: the session's emptied block leaves the structure; its wrapper stays in place (see applyStructure).
    const keep = editId >= 0 && inline.keepsRemoved(editId) ? (ghost ?? els.get(editId) ?? null) : null;
    for (let i = from; i < from + gone; i++) forgetBlock(model.id(i));
    removeChunkRange(from, gone, keep);

    // Heights of surviving trailing blocks sit inside the replaced range; the splice only moves the tail.
    const keepH = s > 0 && insCount !== m.removed
      ? model.heights.slice(m.index + m.removed - s, m.index + m.removed)
      : null;
    model.spliceBlocks(m.index, m.removed, ins, m.lineDelta);
    if (keepH) model.heights.set(keepH, m.index + insCount - s);

    for (let i = from; i < from + born; i++) {
      const id = model.id(i);
      model.setHeight(i, measured.get(id) ?? estimateHeight(model.kind(i), model.lineCount(i)));
      indexById.set(id, i);
    }
    if (born !== gone) for (let i = from + born; i < nNew; i++) indexById.set(model.id(i), i);

    insertChunkRange(from, born);
    afterStructureChange(m.changed, m.version, keepMountAll, false);
  }

  /** U16 (Checkpoint-D decisions): just before a structure update changes them, every fresh block among `ch` (mounted,
   *  not stale, not released, not held, its wrapper the one in els, with a stamp at least the floor) gets its wrapper's
   *  stamp replaced by the structure's own (version, start, count) BEFORE the update: it was unchanged since its
   *  payload, so this says the same with a version the editor's ring can still reach. */
  function restampChanged(ch: Int32Array): void {
    for (let k = 0; k < ch.length; k++) {
      const id = ch[k];
      const i = indexById.get(id);
      const w = els.get(id);
      if (i === undefined || !w || !mounted.has(id) || staleSince.has(id) || released.has(id) || held(id)) continue;
      const st = wrapperStamp.get(w);
      if (st && st.v >= stampFloor) wrapperStamp.set(w, { v: structureVersion, s: model.startLine(i), n: model.lineCount(i) });
    }
  }

  /** Tail shared by applyStructure / applyStructureDelta: stale marking, chunk heights, wrappers around
   *  the window, mountAll restart. */
  function afterStructureChange(ch: Int32Array, version: number, keepMountAll: boolean, full: boolean): void {
    // Changed blocks: stale until HTML of this version mounts; refresh estimates of pending ones.
    for (let k = 0; k < ch.length; k++) {
      const id = ch[k];
      const i = indexById.get(id);
      if (i === undefined) continue;
      staleSince.set(id, version);
      requested.delete(id);   // older HTML in flight is outdated; re-request if still pending
      const w = els.get(id);
      if (held(id)) continue;   // the edited DOM is ahead of the worker: no dimming, no eviction
      if (mounted.has(id)) {
        // Inside (or near) the materialization window the old content stays visible until the new HTML
        // mounts (SPEC §5.5). Far outside it nobody sees the wrapper: drop the outdated subtree now (height
        // pinned, so no scroll jump) — the window mechanics re-request it before it can come into view, so
        // stale content never lingers in the document and the memory is released.
        if (acceptAll || evictionOff || (i >= winFirst - STALE_EVICT_MARGIN && i <= winLast + STALE_EVICT_MARGIN)) w?.classList.add('is-stale');
        else evict(id, i);
      } else if (!measured.has(id)) {
        const est = estimateHeight(model.kind(i), model.lineCount(i));
        if (est !== model.heights[i]) {
          model.setHeight(i, est);
          if (w) w.style.setProperty('--est-h', `${est}px`);
          markChunkAt(i);
        }
      }
      // A newer structure supersedes a deferred (giant) payload of this block: never mount it.
      cancelGiant(id);
    }

    flushChunkHeights();
    // The DOM must be usable as soon as the structure call returns, so build the wrappers around the window
    // right away (block indices shifted by at most the edit's delta; the rAF updateWindow corrects them).
    // An insertion into an already-live chunk created its wrappers above, so typing needs nothing here.
    if (model.count > 0) {
      const lastIdx = model.count - 1;
      // The window itself may legitimately be empty (hidden pane); the materialization range never is.
      const a = Math.min(Math.max(winFirst, 0), lastIdx);
      syncLiveChunks(a, Math.min(Math.max(winLast, a), lastIdx));
    } else {
      winFirst = 0; winLast = -1; winCentre = 0;
    }
    if (keepMountAll) {
      mountAllCursor = 0;
      if (!mountAllRaf) mountAllRaf = requestAnimationFrame(mountAllStep);
    }
    // A FULL structure means the worker rebuilt its render state (setDoc, a restart, a resync): its own
    // viewport is back at lines 1..1 and every `need` the preview had outstanding was just forgotten.
    // Re-establish the window synchronously instead of waiting for the next frame — after a restart the
    // rAF pass alone left the window at the document top often enough that typing at the cursor produced
    // nothing until the user happened to scroll (lead decision 5) — and then re-request every block in
    // the window that has no current content, which `updateWindow` alone does not do for mounted-but-stale ones.
    if (full) {
      updateWindow();
      requestWindowBlocks();
    }
    scheduleFocus();   // block boundaries moved: the focus line may sit in another element now
    scheduleWindow();
    inline.afterStructure();
  }

  /** Requests HTML for every block in (and just around) the materialization window whose content is
   *  missing or outdated — pending, `lost`, or mounted-but-stale. The full-structure path uses it: with
   *  the worker's render state rebuilt nothing is in flight any more, so waiting for the stale-rescue
   *  timer (or for a scroll) would leave the visible document frozen. */
  function requestWindowBlocks(): void {
    if (!visible || disposed || model.count === 0 || winLast < winFirst) return;
    const from = Math.max(0, winFirst - STALE_EVICT_MARGIN);
    const to = Math.min(model.count - 1, winLast + STALE_EVICT_MARGIN);
    const ids: number[] = [];
    for (let i = from; i <= to; i++) {
      const id = model.id(i);
      if (held(id) || !els.has(id) || requested.has(id) || queue.has(id) || giant.has(id)) continue;
      if (mounted.has(id) && !lost.has(id) && !staleSince.has(id)) continue;
      requested.add(id);
      ids.push(id);
    }
    if (ids.length > 0) opts.request(ids);
  }

  // ---------------------------------------------------------------- window + eviction
  function updateWindow(): void {
    if (!visible || disposed || model.count === 0) return;
    const H = el.clientHeight;
    if (H === 0) return;
    const rel = el.scrollTop - model.bodyTop;
    const first = model.indexAtTop(rel - WINDOW_ABOVE * H);
    const last = model.indexAtTop(rel + WINDOW_BELOW * H);
    winFirst = first; winLast = last;
    winCentre = model.indexAtTop(rel + H / 2);
    syncLiveChunks(first, last);
    const need: number[] = [];
    for (let i = first; i <= last; i++) {
      const id = model.id(i);
      if (requested.has(id) || !els.has(id)) continue;
      if (mounted.has(id) && !lost.has(id)) continue;
      requested.add(id);
      need.push(id);
    }
    if (need.length > 0) opts.request(need);
    const fl = model.startLine(first);
    const ll = model.startLine(last) + model.lineCount(last) - 1;
    if (fl !== vpFirst || ll !== vpLast) {
      vpFirst = fl; vpLast = ll;
      opts.viewport(fl, ll);
    }
    // Any mounted block kept stale (a push that never came) is rescued below; the band matches the one
    // `applyStructure` keeps rather than evicting, so nothing in the document can stay stale for ever.
    for (let i = Math.max(0, first - STALE_EVICT_MARGIN); i <= last + STALE_EVICT_MARGIN && i < model.count; i++) {
      const id = model.id(i);
      if (mounted.has(id) && staleSince.has(id)) { scheduleStaleRescue(); break; }
    }
    scheduleEvict();
  }

  function scheduleEvict(): void {
    if (evictionOff || evictTimer || evictIdle || mounted.size === 0) return;
    const wait = Math.max(0, EVICT_INTERVAL_MS - (performance.now() - lastEvict));
    evictTimer = window.setTimeout(() => {
      evictTimer = 0;
      evictIdle = requestIdle(runEvict);
    }, wait);
  }

  /** Evicts mounted blocks whose whole box [top, top+height) lies more than EVICT_SCREENS screens from
   *  the viewport; blocks inside the materialization window are never touched (a tall block can span
   *  the viewport with its top far above it). */
  function runEvict(): void {
    evictIdle = 0;
    lastEvict = performance.now();
    if (evictionOff || !visible || disposed) return;
    const H = el.clientHeight;
    if (H === 0) return;
    const rel = el.scrollTop - model.bodyTop;
    const tops = model.tops(), heights = model.heights;
    const limit = EVICT_SCREENS * H;
    const lo = rel - limit, hi = rel + H + limit;
    let n = 0;
    for (const id of mounted) {
      const i = indexById.get(id)!;
      if (i >= winFirst && i <= winLast) continue;
      if (tops[i] + heights[i] >= lo && tops[i] <= hi) continue;
      evict(id, i);
      if (++n >= EVICT_MAX) break;
    }
  }

  /**
   * Empties a far-away block; its measured height is pinned so nothing shifts. The wrapper itself is
   * replaced by a fresh pending one: an off-screen wrapper sits in a display-locked (content-visibility)
   * chunk and is not re-laid out, so its stale layout result would keep the removed subtree alive.
   */
  function evict(id: number, i: number): void {
    const w = els.get(id);
    if (!w || held(id)) return;
    ro?.unobserve(w);
    const fresh = newWrapper(id, measured.get(id) ?? model.heights[i]);
    w.replaceWith(fresh);
    mounted.delete(id);
    lost.delete(id);
    released.delete(id);
    mountedPayload.delete(id);
    if (id === focusBlockId) scheduleFocus();   // the tinted element went with the old wrapper
  }

  // ---------------------------------------------------------------- focus line (CONTRACT §9)
  /** Moves `.is-focus` to the element that covers `focusLine`, or nowhere when that block has no wrapper
   *  (dormant chunk) and when the focus line is cleared. Exactly one element is ever tinted. Touches only
   *  the subtree of the one block containing the line and reads no layout. */
  function applyFocus(): void {
    let next: HTMLElement | null = null;
    focusBlockId = -1;
    if (focusLine !== null && model.count > 0) {
      const i = model.indexAtLine(focusLine);
      if (i >= 0) {
        focusBlockId = model.id(i);
        const w = els.get(focusBlockId);
        if (w) next = pickFocusElement(w, focusLine - model.startLine(i));
      }
    }
    if (next === focusEl) return;
    focusEl?.classList.remove('is-focus');
    focusEl = next;
    next?.classList.add('is-focus');
  }

  /** Re-applies the tint on the next frame — used by the mount / chunk / structure paths, which may have
   *  replaced the element under the focus line. At most one pass per frame, and none at all while no line
   *  is focused. */
  function scheduleFocus(): void {
    if (focusRaf || disposed || focusLine === null) return;
    focusRaf = requestAnimationFrame(() => { focusRaf = 0; applyFocus(); });
  }

  function setFocusLine(line: Line | null): void {
    if (line !== null && !Number.isFinite(line)) return;   // NaN / undefined: no-op, keep what is shown
    focusLine = line === null ? null : Math.max(1, Math.floor(line));
    applyFocus();
  }

  // ---------------------------------------------------------------- html + mounting
  /** Payloads are accepted for the materialization window plus the band `applyStructure` keeps instead
   *  of evicting: a block just past the window still holds its wrapper and its old content, so dropping
   *  its refresh would leave it `.is-stale` until the user happened to scroll onto it. */
  function inWindow(i: number): boolean {
    if (acceptAll) return true;
    if (winLast < winFirst) return false;   // empty window (hidden pane): accept nothing (SPEC §9)
    return i >= winFirst - STALE_EVICT_MARGIN && i <= winLast + STALE_EVICT_MARGIN;
  }

  const queue = createMountQueue({
    mount: mountGuarded,
    // From the model, not from layout: updateWindow already read scrollTop/clientHeight once for this
    // frame. Reading them here instead would be the first layout read after the frame's DOM writes and
    // would force a full layout on the mount path (37 ms with a 50k-heading TOC in the document).
    centre: () => winCentre,
    indexOf: (id) => (els.has(id) ? indexById.get(id) : undefined),
    onDrained: resolveMountAllIfDone,
  });

  /** Is `payload` byte-identical to the payload currently mounted in block `id`? Payloads above the hash
   *  budget are never compared (hashing a multi-MB string on the message path would cost more than the
   *  re-mount it saves) — they take the giant-settle path anyway. */
  function isMountedPayload(id: number, payload: string): boolean {
    const prev = mountedPayload.get(id);
    return prev !== undefined && prev.len === payload.length && payload.length <= HASH_MAX_CHARS
      && prev.hash === fnv1a32(payload);
  }

  function applyHtml(m: HtmlMsg): void {
    const items = unpackHtml(m.batch);
    const offsets = m.batch.offsets;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const i = indexById.get(it.id);
      if (i === undefined || !inWindow(i) || !els.has(it.id)) {
        requested.delete(it.id);
        // A stale, mounted block just lost its refresh: updateWindow re-requests it once it is in the window.
        if (i !== undefined && mounted.has(it.id) && staleSince.has(it.id)) lost.add(it.id);
        continue;
      }
      // Redundant-push guard (lead decision C): the worker's background cache back-fill can re-render and
      // push blocks that did not change. Re-mounting one costs a replaceChildren plus a full re-layout of
      // the block and destroys any selection inside it, so a payload for a block that is mounted, not
      // stale, not `lost`, not explicitly requested AND byte-identical to what is already on screen is
      // dropped. The identity test (length first, hash only when the lengths match) is what makes the drop
      // safe: content that really differs is always mounted, whatever the `changed` set said.
      if (mounted.has(it.id) && !staleSince.has(it.id) && !lost.has(it.id) && !requested.has(it.id)
        && isMountedPayload(it.id, it.payload)) continue;
      const lv = latest.get(it.id);
      if (lv !== undefined && m.version < lv) continue;   // superseded by a newer payload
      latest.set(it.id, m.version);
      const q: QueuedItem = { id: it.id, flags: it.flags, payload: it.payload, version: m.version };
      // U16 (Checkpoint-D decisions): exact for what this payload shows, whenever it is mounted later
      if (m.version === structureVersion && !desynced) payloadStamp.set(q, { v: m.version, s: model.startLine(i), n: model.lineCount(i) });
      if (offsets[k + 1] - offsets[k] > GIANT_BYTES) restartGiant(q);
      else {
        cancelGiant(it.id);   // a small payload supersedes any deferred giant one
        queue.enqueue(q);
      }
    }
  }

  /** Giant guard: mount only once the block has been stable for GIANT_SETTLE_MS; old content stays. */
  function restartGiant(item: QueuedItem): void {
    const prev = giant.get(item.id);
    if (prev) clearTimeout(prev.timer);
    queue.remove(item.id);
    els.get(item.id)?.classList.add('is-slow');
    const timer = window.setTimeout(() => {
      giant.delete(item.id);
      if (els.has(item.id)) queue.enqueue(item);
    }, GIANT_SETTLE_MS);
    giant.set(item.id, { item, timer });
  }

  /**
   * Mounts PLAIN text as ≤ PLAIN_PIECE_CHARS block-level pieces: `pre.md-code--plain > code` pieces
   * for Code blocks (pre-wrap), `p.md-plain` pieces (pre-line) for everything else. Pieces whose text
   * did not change since the last mount are left alone, so typing inside a giant block re-lays out one
   * piece; each piece is a content-visibility unit of its own (see preview.css).
   *
   * A prose block downgraded this way shows literal `**bold**` / `[text](url)` markup, which is
   * indistinguishable from a rendering bug, so it is prefixed with a muted `.md-plain__note` saying why
   * (a Code block looks the same rendered or not, so it needs no note).
   */
  function mountPlain(w: HTMLElement, i: number, text: string): void {
    const code = model.kind(i) === BlockKind.Code;
    const pieces = splitPlain(text);
    let host: HTMLElement = w;
    let first = 0;      // index of the first piece among `host`'s children
    if (code) {
      let pre = w.firstElementChild as HTMLElement | null;
      if (!(pre && w.childElementCount === 1 && pre.classList.contains('md-code--plain'))) {
        pre = document.createElement('pre');
        pre.className = 'md-code md-code--plain';
        w.replaceChildren(pre);
      }
      host = pre;
    } else {
      if (!(w.firstElementChild?.classList.contains('md-plain__note'))) {
        const note = document.createElement('div');
        note.className = 'md-plain__note';
        note.textContent = PLAIN_NOTE_TEXT;
        w.replaceChildren(note);
      }
      first = 1;
    }
    const tag = code ? 'code' : 'p';
    while (host.childElementCount > pieces.length + first) host.lastElementChild!.remove();
    for (let k = 0; k < pieces.length; k++) {
      let node = host.children[k + first] as HTMLElement | undefined;
      if (!node) {
        node = document.createElement(tag);
        node.className = code ? 'md-plain__piece' : 'md-plain md-plain__piece';
        host.appendChild(node);
      }
      if (pieceText.get(node) === pieces[k]) continue;
      node.textContent = pieces[k];
      node.style.setProperty('--piece-h', `${pieceEstimate(pieces[k], code)}px`);
      pieceText.set(node, pieces[k]);
    }
  }

  /** Rule SAN: the worker's render-error block (md.ts renderBlock) for a block whose HTML could not be mounted — the
   *  notice and the block's HTML, both as text nodes. */
  function mountError(w: HTMLElement, payload: string, err: unknown): void {
    let message = '';
    try { message = err instanceof Error ? err.message : String(err); } catch { /* an error that cannot be printed */ }
    const box = document.createElement('div');
    box.className = 'md-error';
    const note = document.createElement('p');
    note.textContent = `${T.renderError}：${message}`;
    const pre = document.createElement('pre');
    pre.textContent = payload;
    box.append(note, pre);
    w.replaceChildren(box);
  }

  /** Rule SAN: mounting one block never throws out of the queue's flush, which would leave the blocks after it unmounted.
   *  What throws after the block's HTML is in place is still reported, as an uncaught error of its own. */
  function mountGuarded(q: QueuedItem): void {
    try { mountItem(q); } catch (err) { window.setTimeout(() => { throw err; }, 0); }
  }

  function mountItem(q: QueuedItem): void {
    const w = els.get(q.id);
    const i = indexById.get(q.id);
    if (!w || i === undefined) {
      // The block's chunk went dormant (or the block vanished) between enqueue and flush: let the window
      // ask for it again instead of leaving it in `requested` for ever.
      requested.delete(q.id);
      return;
    }
    if (q.version < (latest.get(q.id) ?? 0)) return;   // an older deferred payload: never regress
    if (held(q.id)) {
      // Being edited: the DOM is the user's; this payload waits for the session to end.
      heldItem = q;
      requested.delete(q.id);
      return;
    }
    const t0 = performance.now();
    try {
      if (q.flags & HTML_FLAG_PLAIN) mountPlain(w, i, q.payload);
      else {
        if (q.flags & HTML_FLAG_TRUSTED) w.innerHTML = q.payload;   // worker-escaped text only (CONTRACT §6)
        else w.replaceChildren(sanitizeToFragment(q.payload));
        wrapCodeFences(w);
      }
    } catch (err) {
      // Rule SAN (CONTRACT §11, Round-7 decisions): HTML the sanitizer cannot take (DOMPurify throws on a processing
      // instruction named like a form control: `<p><?form></p>`) shows as the render-error block, never as markup.
      mountError(w, q.payload, err);
    }
    // U10(b): the block's raw HTML carries a name the app reserves — every reader of the wrapper (the edit
    // session, the checkbox write-back) treats its markers as forged. Set or cleared at EVERY mount.
    if (q.flags & HTML_FLAG_RESERVED) w.setAttribute('data-mdr-x', '');
    else w.removeAttribute('data-mdr-x');
    const stamp = payloadStamp.get(q);      // (U16: what this wrapper's HTML shows now)
    if (stamp) wrapperStamp.set(w, stamp); else wrapperStamp.delete(w);
    mountedPayload.set(q.id, {
      len: q.payload.length,
      hash: q.payload.length <= HASH_MAX_CHARS ? fnv1a32(q.payload) : 0,
    });
    w.classList.remove('is-pending', 'is-slow');
    const since = staleSince.get(q.id);
    if (since === undefined || q.version >= since) {
      staleSince.delete(q.id);
      w.classList.remove('is-stale');
    }
    mounted.add(q.id);
    requested.delete(q.id);
    lost.delete(q.id);
    released.delete(q.id);
    if (q.id === focusBlockId) scheduleFocus();   // this block's subtree was just replaced
    ro?.observe(w);
    bus.emit('perf:sample', { name: 'mount', ms: performance.now() - t0 });
    if (awaitingFirstVisible) {
      awaitingFirstVisible = false;
      performance.mark('mdr:first-visible');
    }
    if (!staleSince.has(q.id)) inline.afterMount(q.id);
  }

  // ---------------------------------------------------------------- navigation anchor
  let anchor: { line: Line; fraction: number; until: number; passes: number } | null = null;

  /** Re-applies the pending navigation target once (after a settle frame or a height change above it). */
  function reapplyAnchor(countPass: boolean): void {
    const a = anchor;
    if (!a) return;
    if (performance.now() > a.until || a.passes >= ANCHOR_PASSES) { anchor = null; return; }
    if (countPass) a.passes++;
    const again = model.lineToScrollTop(a.line, a.fraction);
    if (Math.abs(again - el.scrollTop) > ANCHOR_PX) el.scrollTop = again;
  }

  const dropAnchor = (): void => { anchor = null; };
  for (const ev of USER_SCROLL_EVENTS) el.addEventListener(ev, dropAnchor, { passive: true, capture: true });

  // ---------------------------------------------------------------- observers
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        if (!visible) return;
        let minIndex = Infinity;
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.id);
          const i = indexById.get(id);
          if (i === undefined) continue;
          const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
          // 0×0 = not rendered (inside a skipped chunk or a hidden pane), never a real measurement.
          if (h === 0 && e.contentRect.width === 0) continue;
          if (h === model.heights[i]) continue;
          measured.set(id, h);
          model.setHeight(i, h);
          if (i < minIndex) minIndex = i;
        }
        // A block at or above the navigation target changed height: keep the target on the top edge.
        if (anchor && minIndex <= model.indexAtLine(anchor.line)) reapplyAnchor(true);
        // A block at or above the top edge changed height: the line under the edge moved although
        // scrollTop did not — the same event as a scroll for whoever follows this pane (scroll sync).
        if (minIndex <= model.indexAtTop(el.scrollTop - model.bodyTop)) scheduleScrollNotify();
        else scheduleWindow();
      })
    : null;
  const elRo = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        model.bodyTop = body.offsetTop;
        scheduleWindow();
      })
    : null;
  elRo?.observe(el);

  /** rAF-coalesced: refresh the window, then tell onScroll listeners the top position changed. */
  function scheduleScrollNotify(): void {
    if (scrollRaf || disposed) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateWindow();
      for (const fn of scrollHandlers) fn();
    });
  }
  el.addEventListener('scroll', scheduleScrollNotify, { passive: true });

  /** P-B (CONTRACT §11, amended): the preview's structure describes the source as it is now — its version is at least
   *  the source document's (PreviewSourceAccess.version(), the editor's). Decided by document versions, never by
   *  elapsed time. A source without a version is trusted (and a preview without a source has nothing to compare). */
  function describesSource(): boolean {
    const src = opts.source;
    return !src?.version || structureVersion >= src.version();
  }
  /** P-B — THE definition of "the wrapper of block `id` shows the block's current source", for every session start
   *  and resume (inlineEdit's currentWrapper, also the replay of a waiting task click; a tick itself asks taskLine
   *  below, U16 as amended a second time): the structure
   *  describes the current source (describesSource), so the block's line range is its range in the source now; and
   *  the HTML mounted in its wrapper was rendered from those lines — mounted, not stale (a structure update that
   *  changed the block's lines marks it stale until HTML of that structure mounts), not lost (released by a session,
   *  its re-render not mounted yet) — and the wrapper is in the document and not pending. null: not (yet). */
  function currentWrapper(id: number): HTMLElement | null {
    if (!describesSource() || !mounted.has(id) || staleSince.has(id) || lost.has(id)) return null;
    const w = els.get(id);
    return w && w.isConnected && !w.classList.contains('is-pending') ? w : null;
  }

  /** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): what the HTML in block wrapper `w` shows, for
   *  taskLineIn. A fresh block (mounted, not stale, not released, not held) whose stamp is at least the floor: the
   *  structure's own (version, start, count); any other mounted block: its wrapper's stamp. 'wait': a block a session
   *  has released whose re-render has not mounted, while editing is on (the session's wait takes the click; with the
   *  switch off nothing waits: 'unknown'). 'unknown': no stamp, a wrapper that is not its block's (PTK-6), a held block. */
  function shownIn(w: HTMLElement): TaskStamp | 'wait' | 'unknown' {
    const id = Number(w.dataset.id);
    const i = indexById.get(id);
    if (i === undefined || els.get(id) !== w || !mounted.has(id) || held(id)) return 'unknown';
    if (released.has(id)) return inline.isEditable() ? 'wait' : 'unknown';
    const st = wrapperStamp.get(w);
    if (!st) return 'unknown';
    return !staleSince.has(id) && st.v >= stampFloor ? { v: structureVersion, s: model.startLine(i), n: model.lineCount(i) } : st;
  }
  /** U16 (Checkpoint-D decisions) — THE answer for a click on a task checkbox: taskLineIn with this preview's triple, the
   *  source's version (none: the structure describes the source), its lineNow and its text. Asked by interactions (the
   *  tick: onClick, onChange) and by the edit session (its capture listener: the wait begins only for 'wait'). */
  function taskLine(box: HTMLInputElement): TaskAnswer {
    const src = opts.source;
    return taskLineIn(box, el, {
      shown: shownIn,
      current: () => (src?.version ? src.version() : structureVersion),
      ...(src?.lineNow ? { lineNow: (line: Line, v: number) => src.lineNow!(line, v) } : {}),
      ...(src ? { sourceLine: (line: Line) => src.read(line, 1) } : {}),
    });
  }

  const detachInteractions = attachInteractions(el, {
    bus,
    setFocusLine,
    currentFocusLine: () => focusLine,
    startLineOf(id) {
      const i = indexById.get(id);
      return i === undefined ? undefined : model.startLine(i);
    },
    taskLine,                                                 // (U16: the one answer for a tick)
    outline: () => outline,
    isEditing: (t) => inline.isEditingTarget(t),
  });

  // ---------------------------------------------------------------- in-preview editing (CONTRACT §11)
  function infoAt(i: number): BlockInfo {
    return { index: i, id: model.id(i), startLine: model.startLine(i), lineCount: model.lineCount(i), kind: model.kind(i) };
  }

  function blockOfElement(node: Element): BlockInfo | null {
    const w = node.closest?.<HTMLElement>('section.md-block') ?? null;
    if (!w || !body.contains(w)) return null;
    const id = Number(w.dataset.id);
    if (els.get(id) !== w) return null;
    const i = indexById.get(id);
    return i === undefined ? null : infoAt(i);
  }

  const inlineHost: InlineEditHost = {
    root: el,
    hintParent: opts.parent,
    bus,
    source: opts.source,
    blockOfElement,
    elementOfBlock: (id) => els.get(id) ?? null,
    blockInfo(id) {
      const i = indexById.get(id);
      return i === undefined ? null : infoAt(i);
    },
    blockAtLine(line) {
      if (model.count === 0) return null;
      const i = model.indexAtLine(line);
      return i < 0 ? null : infoAt(i);
    },
    isFresh: (id) => mounted.has(id) && !staleSince.has(id) && !lost.has(id) && els.has(id),
    taskLine,                                 // (U16: a task click waits only for 'wait')
    // P-B: the one definition (above); used by the session whenever the source has a version
    currentWrapper,
    describesSource,
    // P-F: fresh HTML for the block is on its way (asked for, queued for mounting, or a giant payload settling)
    renderPending: (id) => els.has(id) && !(mounted.has(id) && !staleSince.has(id) && !lost.has(id))
      && (requested.has(id) || queue.has(id) || giant.has(id)),
    setFocusLine: (line) => setFocusLine(line),
    structureVersion: () => structureVersion,
    revealLine(line) {
      if (model.count === 0 || !Number.isFinite(line)) return;
      const top = model.lineToScrollTop(line, 0);
      if (top >= el.scrollTop - 1 && top < el.scrollTop + el.clientHeight - 24) return;   // on screen already
      scrollToLine(line, 0);
      updateWindow();                           // materialize and request its block now, not a frame later
    },
    hold(id) {
      editId = id;
      heldItem = null;
      // The mounted payload no longer describes the DOM: the redundant-push guard must not match it, and (U16) its
      // stamp is gone: from now on the DOM is the session's.
      mountedPayload.delete(id);
      const hw = els.get(id);
      if (hw) wrapperStamp.delete(hw);
    },
    release(id) {
      if (editId === id) editId = -1;
      if (ghost && Number(ghost.dataset.id) === id) {
        // The emptied wrapper of a deleted block (U9): no block to re-render, it just goes.
        ghost.remove();
        ghost = null;
        ghostHolder?.remove();
        ghostHolder = null;
        if (editId === -1) heldItem = null;
        return;
      }
      const q = heldItem;
      heldItem = null;
      if (!els.has(id) || !indexById.has(id)) return;
      // U19: until its re-render mounts, the wrapper still shows the ended session's DOM: it is not fresh (no
      // resume, click or new session accepts it — the block's source may equal what it showed before, so no
      // structure marks it stale), and its HTML is asked for again when this answer is dropped (out of the window).
      if (mounted.has(id)) { lost.add(id); released.add(id); }   // (U16: a task click there waits: taskLine 'wait')
      if (q && q.id === id) queue.enqueue(q);
      else {
        // Nothing arrived while editing: re-render from the worker so the block shows canonical HTML.
        requested.add(id);
        opts.request([id]);
      }
    },
  };

  // Rule L2: THE variable holding the session API. Until the editing module is installed it holds the stand-in
  // (INLINE_EDIT_OFF: every member answers what the real one answers with the switch off and no session); the real one
  // is created at most once, by the first setPreviewEditable(true) after its chunk arrived, and stays (switch off again:
  // its own setEditable(false), as before rule L).
  let inline: InlineEditApi = INLINE_EDIT_OFF;
  let inlineInstalled = false;
  /** Rule L3: the last setPreviewEditable wish (a later call withdraws an earlier one still waiting for the chunk). */
  let editWish = false;
  let editLoad: Promise<boolean> | null = null;
  /** Rule L2: installed late, the module is in the state it would be in had it been created with the preview — the
   *  switch off and no session: its constructor reads nothing of the preview, and every call the preview made meanwhile
   *  (setEditable(false), afterStructure, afterMount, keepsRemoved, isEditingTarget, end, flush) changes nothing in that
   *  state. It subscribes to the bus and the DOM from now on, and only the preview's state from now on matters to it. */
  function installInline(m: NonNullable<ReturnType<typeof inlineEditLoaded>>): void {
    inline = m.createInlineEdit(inlineHost);
    inlineInstalled = true;
  }
  /** Rule L3: synchronous when the module is installed, the wish is off, or the chunk is already here; otherwise the
   *  chunk is fetched and the promise says what happened: true = installed and editable, false = the wish was withdrawn
   *  meanwhile (or the preview was disposed); rejected = the chunk could not be loaded (the switch stays off). */
  function setPreviewEditable(on: boolean): void | Promise<boolean> {
    editWish = on;
    if (inlineInstalled || !on) { inline.setEditable(on); return; }
    const ready = inlineEditLoaded();
    if (ready) { installInline(ready); inline.setEditable(true); return; }
    editLoad ??= loadInlineEdit().then(
      (m) => {
        editLoad = null;
        if (disposed || !editWish) return false;
        if (!inlineInstalled) installInline(m);
        inline.setEditable(true);
        return inline.isEditable();
      },
      (err: unknown) => { editLoad = null; throw err; },
    );
    return editLoad;
  }

  // ---------------------------------------------------------------- mountAll
  let mountAllResolve: (() => void) | null = null;
  let mountAllCursor = 0;

  function resolveMountAll(): void {
    if (mountAllRaf) { cancelAnimationFrame(mountAllRaf); mountAllRaf = 0; }
    const r = mountAllResolve;
    mountAllResolve = null;
    r?.();
  }

  function resolveMountAllIfDone(): void {
    if (mountAllResolve && mountAllCursor >= model.count && mounted.size >= model.count) resolveMountAll();
  }

  /** One ≤ 8 ms step: materialize chunks, request HTML for pending blocks, in document order. */
  function mountAllStep(): void {
    mountAllRaf = 0;
    const n = model.count;
    const t0 = performance.now();
    const ids: number[] = [];
    while (mountAllCursor < n) {
      const k = chunkAt(mountAllCursor);
      if (k < 0) break;
      materialize(k);
      const end = chunkStarts()[k] + chunks[k].n;
      for (; mountAllCursor < end && mountAllCursor < n; mountAllCursor++) {
        const id = model.id(mountAllCursor);
        // Pending, lost, and mounted-but-stale blocks all need fresh HTML for mountAll to leave a consistent document.
        if ((!mounted.has(id) || lost.has(id) || staleSince.has(id)) && !requested.has(id)) { requested.add(id); ids.push(id); }
      }
      if (performance.now() - t0 >= MOUNT_SLICE_MS) break;
    }
    flushChunkHeights();
    if (ids.length > 0) opts.request(ids);
    if (mountAllCursor < n) mountAllRaf = requestAnimationFrame(mountAllStep);
    else resolveMountAllIfDone();
  }

  function mountAll(): Promise<void> {
    resolveMountAll();
    evictionOff = true;
    acceptAll = true;
    mountAllCursor = 0;
    return new Promise<void>((resolve) => {
      mountAllResolve = resolve;
      mountAllStep();
    });
  }

  // ---------------------------------------------------------------- scrolling
  function scrollToLine(line: Line, fraction = 0, behavior: 'instant' | 'smooth' = 'instant'): void {
    const target = model.lineToScrollTop(line, fraction);
    if (behavior === 'smooth') {
      anchor = null;
      el.scrollTo({ top: target, behavior: 'smooth' });
      return;
    }
    el.scrollTop = target;
    // Keep the target on the top edge while blocks above it are measured (estimate → real height).
    anchor = { line, fraction, until: performance.now() + ANCHOR_MS, passes: 0 };
    if (settleRaf) cancelAnimationFrame(settleRaf);
    settleRaf = requestAnimationFrame(() => { settleRaf = 0; reapplyAnchor(false); });
  }

  const api: PreviewApi & { mountedCount(): number; taskStampOf(w: HTMLElement): TaskStamp | undefined; taskLine(box: HTMLInputElement): TaskAnswer } = {
    el,
    applyStructure,
    applyStructureDelta,
    applyHtml,
    applyOutline(items) { outline = items; },
    blockCount: () => model.count,
    blockAtLine(line) {
      const i = model.indexAtLine(line);
      if (i < 0) return { index: -1, id: -1, startLine: 1, lineCount: 0, kind: BlockKind.Prose };
      return { index: i, id: model.id(i), startLine: model.startLine(i), lineCount: model.lineCount(i), kind: model.kind(i) };
    },
    lineToScrollTop: (line, fraction) => model.lineToScrollTop(line, fraction),
    scrollTopToLine: (top) => model.scrollTopToLine(top),
    topVisible: () => model.scrollTopToLine(el.scrollTop),
    isLineVisible(line) {
      // Same origin as scrollTop (lineToScrollTop includes bodyTop); the browser rounds scrollTop while
      // the model is fractional, hence 1 px of slack at the top edge.
      const top = model.lineToScrollTop(line, 0);
      return top >= el.scrollTop - 1 && top < el.scrollTop + el.clientHeight;
    },
    scrollToLine,
    setFocusLine,
    onScroll(fn) {
      scrollHandlers.add(fn);
      return () => { scrollHandlers.delete(fn); };
    },
    setVisible(on) {
      visible = on;
      if (on) scheduleWindow();
      else { winFirst = 0; winLast = -1; }
    },
    mountAll,
    blockOfElement,
    elementOfBlock: (id) => els.get(id) ?? null,
    setPreviewEditable,
    isPreviewEditable: () => inline.isEditable(),
    endEditSession: () => inline.end(),
    /** Writes what the session has pending (synchronously) and KEEPS the session and the caret — for ⌘S,
     *  which should not end an edit mid-sentence. Not yet in PreviewApi (cross-module request). */
    flushEditSession: () => inline.flush(),
    /** Number of mounted (non-pending) blocks; for the ?perf=1 overlay (no DOM query needed). */
    mountedCount: () => mounted.size,
    /** U16 (Checkpoint-D decisions), tests and diagnostics only: a wrapper element's stamp, and THE answer for a task box. */
    taskStampOf: (w) => wrapperStamp.get(w),
    taskLine,
    dispose() {
      inline.dispose();
      disposed = true;
      resolveMountAll();
      detachInteractions();
      for (const ev of USER_SCROLL_EVENTS) el.removeEventListener(ev, dropAnchor, { capture: true });
      queue.dispose();
      ro?.disconnect();
      elRo?.disconnect();
      for (const g of giant.values()) clearTimeout(g.timer);
      giant.clear();
      for (const h of [winRaf, scrollRaf, settleRaf, mountAllRaf, focusRaf]) if (h) cancelAnimationFrame(h);
      if (evictTimer) clearTimeout(evictTimer);
      if (staleRescueTimer) clearTimeout(staleRescueTimer);
      if (evictIdle) cancelIdle(evictIdle);
      el.remove();
    },
  };
  return api;
};
