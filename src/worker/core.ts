// src/worker/core.ts — worker state, message handling and the render scheduler (SPEC 4.1, 4.2, 4.5).
// Pure logic: no `self`, no DOM; the slice yield uses MessageChannel when present, else setTimeout.
import {
  BlockKind, DEFAULT_RENDER_OPTIONS, HTML_BATCH_MAX_BYTES, HTML_BATCH_MAX_ITEMS, WORKER_SLICE_MS, BLOCK_STRIDE,
  type DocStats, type FromWorker, type HtmlItem, type RenderOptions, type TextChange, type ToWorker,
} from '../shared/types';
import { packHtml } from '../shared/protocol';
import { fnv1a32, hashKey } from '../shared/hash';
import { T } from '../shared/i18n';
import { applyChanges, createDoc, docText, normaliseEmpty, type ChangeEffect, type Doc } from './doc';
import { blockSource, buildBlocks, identify, indexOfBlockContaining, resegmentWindow, segmentAll, setextLevel, type Block } from './segmenter';
import { addCounts, emptyStats, finaliseStats } from './stats';
import { createOutlineState, updateOutline, type OutlineState } from './outline';
import { createMarkdown, type Markdown, type References } from './md';
import { CACHE_BUDGET_BYTES, createRenderCache, type RenderedBlock } from './cache';
import { loadMath, mathFailed, mathReady } from './math';
import { createDraftSaver } from './draft';

export type Post = (m: FromWorker, transfer?: ArrayBuffer[]) => void;

/** Slow-block throttle (SPEC 4.5): a render slower than `slowRenderMs` marks the block `slow`;
 *  slow blocks re-render at most once per `slowIntervalMs` while edits continue. Code blocks that keep
 *  receiving edits are coalesced: rendered at once when last rendered more than `codeCoalesceMs` ago,
 *  otherwise one deferred render `codeCoalesceMs` later (fix round, lead decision 4). A code block of at
 *  least `fastCodeChars` characters is pushed as escaped text right away while it is being edited
 *  (highlighting such a fence costs > 100 ms per keystroke) and highlighted once typing settles.
 *  Overridable for tests. */
export interface CoreTuning {
  slowRenderMs: number; slowIntervalMs: number; codeCoalesceMs: number; fastCodeChars: number;
  /** Render-cache budget in bytes; tests shrink it to force the LRU eviction that real documents hit. */
  cacheBytes: number;
  /** Test hook: called with the block id on every markdown render (how the "one render per keystroke"
   *  invariant is asserted without timing). Never set in production. */
  onRender?: (id: number) => void;
}
export const DEFAULT_TUNING: CoreTuning = { slowRenderMs: 30, slowIntervalMs: 300, codeCoalesceMs: 150, fastCodeChars: 8192, cacheBytes: CACHE_BUDGET_BYTES };

const now = (): number => performance.now();

/** What markdown can still see in a block's source once KaTeX has taken the `$$…$$` regions (math on):
 *  every math region is removed, and an unclosed `$$` swallows the rest of the block — exactly what a
 *  whole-document parse does. Used for the reference-definition prefilter (SPEC §4.3.7). */
export function stripMathRegions(source: string): string {
  if (source.indexOf('$$') < 0) return source;
  const lines = source.split('\n');
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    if (open) {
      if (line.indexOf('$$') >= 0) open = false;   // the closing line belongs to the formula
      continue;
    }
    const m = /^ {0,3}\$\$/.exec(line);
    if (!m) { out.push(line); continue; }
    // `$$a = b$$` closes on its own line; a bare `$$` opens a region that runs until the next `$$` line.
    if (line.indexOf('$$', m[0].length) < 0) open = true;
  }
  return out.join('\n');
}

/** Exact line-array comparison without joining either document into one string. */
function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeYield(fn: () => void): () => void {
  if (typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    ch.port1.onmessage = fn;
    // Node: an active port would keep the event loop alive after tests finish.
    (ch.port1 as unknown as { unref?: () => void }).unref?.();
    return () => ch.port2.postMessage(null);
  }
  return () => {
    setTimeout(fn, 0);
  };
}

/**
 * Merges the effect of a just-applied transaction into the running union of a flush (CONTRACT §7).
 * `acc` is expressed in the coordinates of the document BEFORE the flush started (`fromLine` / `toLineOld`)
 * and AFTER everything merged so far (`toLineNew`); `e` is expressed in the coordinates around its own
 * transaction. The bounds are deliberately conservative (a wider window only costs a longer rescan).
 */
export function mergeEffects(acc: ChangeEffect | null, e: ChangeEffect, oldLineCount: number): ChangeEffect {
  if (!acc) return { ...e };
  const cum = acc.lineDelta; // lines added (+) / removed (−) by everything merged so far
  const fromOld = Math.max(1, e.fromLine - Math.max(0, cum));
  const toOld = Math.min(oldLineCount, e.toLineOld - Math.min(0, cum));
  // lines of the running union that sit after this transaction's start shift with it
  let toNew = acc.toLineNew;
  if (toNew >= e.fromLine && e.lineDelta > 0) toNew += e.lineDelta;
  return {
    fromLine: Math.min(acc.fromLine, fromOld),
    toLineOld: Math.max(acc.toLineOld, toOld),
    toLineNew: Math.max(toNew, e.toLineNew),
    lineDelta: cum + e.lineDelta,
  };
}

/** Outward walk from the viewport centre over block indices [min, max]; persists across slices until reset. */
interface Walk { lo: number; hi: number; min: number; max: number; valid: boolean; radiusScreens: number | null }

/** Back-fill (priority 4) stays within this many viewport heights of the viewport, like the preview's eviction distance. */
const FILL_SCREENS = 20;
const FILL_MIN_LINES = 40;

export function createRenderCore(post: Post, tuning: Partial<CoreTuning> = {}): { handle(m: ToWorker): void } {
  const { slowRenderMs, slowIntervalMs, codeCoalesceMs, fastCodeChars, cacheBytes, onRender } = { ...DEFAULT_TUNING, ...tuning };
  let opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  /** Built on demand (the `init` message usually replaces the options first). */
  let mdc: Markdown | null = null;
  let docId = '';
  let version = 0;
  let doc: Doc = createDoc('');
  let blocks: Block[] = [];
  const byId = new Map<number, Block>();
  let nextId = 1;
  const alloc = (): number => nextId++;
  let totals: DocStats = emptyStats();
  const dirty = new Set<number>();
  const need = new Set<number>();
  let viewport = { firstLine: 1, lastLine: 1 };
  let win = { first: 1, last: 1, centre: 0 };
  const cache = createRenderCache(cacheBytes);
  let refs: References = {};
  let refsJson = '{}';
  let refsHash = 0;
  let outlineVersion = 0;
  /** outlineVersion of the last `outline` message actually posted; -1 while none has gone out. A resync
   *  repeats the outline only when the client's copy can differ from ours (CONTRACT §8). */
  let sentOutlineVersion = -1;
  const outline: OutlineState = createOutlineState();
  let idleVersion = -1;
  /** A `viewport` / `need` arrived since the last `idle`: answer it with an `idle` even when there was
   *  nothing left to do, so a request is never left without a reply (the client's progress indicator and
   *  `__mdr.waitIdle()` both wait for one). */
  let askedSinceIdle = false;
  let scheduled = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let slowTimerAt = 0;
  let mathRequested = false;
  const walkDirty: Walk = { lo: 0, hi: 0, min: 0, max: 0, valid: false, radiusScreens: null };
  const walkFill: Walk = { lo: 0, hi: 0, min: 0, max: 0, valid: false, radiusScreens: FILL_SCREENS };

  /** Queued `edit` transactions (CONTRACT §7): flushed in ONE task so a burst of keystrokes that is
   *  already sitting in the worker's message queue is applied before a single resegmentation. */
  const pendingEdits: Array<{ version: number; changes: TextChange[] }> = [];
  let flushScheduled = false;

  const draft = createDraftSaver(
    () => (docId ? { docId, version, text: docText(doc), at: Date.now() } : null),
    (id, v, at) => post({ type: 'draftSaved', docId: id, version: v, at }),
  );
  const yieldSlice = makeYield(runSlice);
  const yieldFlush = makeYield(flushTask);

  // ---------------------------------------------------------------- helpers
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    yieldSlice();
  }

  function resetWalks(): void {
    walkDirty.valid = false;
    walkFill.valid = false;
  }

  /** markdown-it's `reference` block rule writes every definition it finds into `env.references`, so a
   *  plain `{ references: refs }` env lets ONE rendered block silently add a definition the prefilter in
   *  `rebuildRefs` rejected (`[a]:url` with no space after the colon, a definition inside a paragraph…).
   *  `refsJson` / `refsHash` would not change with it, so the poisoned entry would survive every later
   *  render and every cache key. Each render therefore gets a prototype view: lookups reach `refs`,
   *  writes land on the throwaway object. */
  const refsView = (): References => Object.create(refs) as References;

  /** Cache key: content hash, plus the reference-set hash for blocks whose rendering may use references. */
  function keyOf(b: Block): string {
    const k = hashKey(b.hashLo, b.hashHi, b.chars);
    return b.hasBracket ? `${k}:${refsHash}` : k;
  }

  function rebuildIndex(): void {
    byId.clear();
    for (const b of blocks) byId.set(b.id, b);
  }

  function updateWindow(): void {
    const h = Math.max(1, viewport.lastLine - viewport.firstLine + 1);
    win = {
      first: Math.max(1, Math.floor(viewport.firstLine - 1.5 * h)),
      last: Math.ceil(viewport.lastLine + 1.5 * h),
      centre: blocks.length ? indexOfBlockContaining(blocks, Math.round((viewport.firstLine + viewport.lastLine) / 2)) : 0,
    };
  }

  function inWindow(b: Block): boolean {
    return b.startLine <= win.last && b.startLine + b.lineCount - 1 >= win.first;
  }

  // ---------------------------------------------------------------- references (SPEC 4.3.7)
  /** markdown-it's block parser decides what is a definition (not inside fences / raw HTML, not interrupting
   *  a paragraph, multi-line titles and urls, definitions nested in quotes and lists); blocks are parsed in
   *  document order into one env so the first definition of a label wins, as in a whole-document parse. */
  function rebuildRefs(): boolean {
    const env: { references?: References } = {};
    for (const b of blocks) {
      if (!b.hasRef) continue;
      let src = blockSource(doc.lines, b);
      // Text a `$$` region has taken over defines no reference, and an unclosed `$$` swallows the rest of
      // the block. In a Code / Html block a `$$` line is not math at all, so those are left untouched
      // (mayDefineReference already restricts them to the part markdown-it parses).
      if (opts.math && b.kind !== BlockKind.Code && b.kind !== BlockKind.Html) {
        src = stripMathRegions(src);
        if (src.indexOf(']:') < 0) continue;
      }
      try {
        const md = mdk();
        md.md.block.parse(src, md.md, env, []);
      } catch {
        // a block that fails to parse defines nothing; renderBlock reports the error
      }
    }
    const next = env.references ?? {};
    const json = JSON.stringify(next);
    if (json === refsJson) return false;
    refs = next;
    refsJson = json;
    refsHash = fnv1a32(json);
    return true;
  }

  // ---------------------------------------------------------------- structure / outline
  function postStructure(changed: Iterable<number>): void {
    const arr = new Int32Array(blocks.length * BLOCK_STRIDE);
    for (let i = 0, o = 0; i < blocks.length; i++, o += BLOCK_STRIDE) {
      const b = blocks[i];
      arr[o] = b.id;
      arr[o + 1] = b.startLine;
      arr[o + 2] = b.lineCount;
      arr[o + 3] = b.kind;
    }
    const ch = Int32Array.from(changed);
    post(
      { type: 'structure', version, blocks: arr, changed: ch, lineCount: doc.lines.length, stats: finaliseStats(totals, doc.lines.length, blocks.length), outlineVersion },
      [arr.buffer, ch.buffer],
    );
  }

  /** Incremental structure update (CONTRACT §7): `inserted` replaces blocks[index … index+removed). */
  function postStructureDelta(index: number, removed: number, inserted: Block[], lineDelta: number, changed: Iterable<number>): void {
    const arr = new Int32Array(inserted.length * BLOCK_STRIDE);
    for (let i = 0, o = 0; i < inserted.length; i++, o += BLOCK_STRIDE) {
      const b = inserted[i];
      arr[o] = b.id;
      arr[o + 1] = b.startLine;
      arr[o + 2] = b.lineCount;
      arr[o + 3] = b.kind;
    }
    const ch = Int32Array.from(changed);
    post(
      {
        type: 'structureDelta', version, index, removed, inserted: arr, lineDelta, changed: ch,
        lineCount: doc.lines.length, stats: finaliseStats(totals, doc.lines.length, blocks.length), outlineVersion,
      },
      [arr.buffer, ch.buffer],
    );
  }

  /** Recomputes the outline; bumps outlineVersion when its fingerprint changed. Returns the message to post after the structure. */
  function refreshOutline(): FromWorker | null {
    if (!updateOutline(outline, blocks, doc.lines)) return null;
    outlineVersion++;
    return { type: 'outline', outlineVersion, items: outline.entries };
  }

  /** Can this reconcile change the outline? Only when a block that holds (or can hold) a heading was removed or added. */
  function touchesOutline(r: ReturnType<typeof resegmentWindow>): boolean {
    for (const b of r.removed) if (b.outline !== null && b.outline.heads.length > 0) return true;
    for (const b of r.added) {
      if (b.kind === BlockKind.Heading || (b.kind === BlockKind.Html && b.lineCount >= 2) || setextLevel(doc.lines, b) > 0) return true;
    }
    return false;
  }

  /** Delta description of the reconcile a flush produced, or null when a full `structure` must go out. */
  interface Delta { index: number; removed: number; inserted: Block[]; lineDelta: number }

  function afterDocChange(changed: Iterable<number>, outlineTouched = true, delta: Delta | null = null): void {
    // The outline scan is O(blocks); typing inside a paragraph (no heading involved, no line shift)
    // cannot change it, so the fingerprint stays and no scan is needed.
    const outline = outlineTouched ? refreshOutline() : null;
    if (delta) postStructureDelta(delta.index, delta.removed, delta.inserted, delta.lineDelta, changed);
    else postStructure(changed);
    if (outline) {
      post(outline);
      sentOutlineVersion = outlineVersion;
    }
    updateWindow();
    resetWalks();
    schedule();
  }

  // ---------------------------------------------------------------- messages
  function setDoc(m: Extract<ToWorker, { type: 'setDoc' }>): void {
    docId = m.docId;
    version = m.version;
    const next = createDoc(m.text);
    // A re-seed with byte-identical text (save-as under a new docId, draft restore, worker restart)
    // keeps the block ids: the preview then reconciles instead of destroying every wrapper and dropping
    // every measured height. A genuinely different document gets fresh ids, so the preview still sees a
    // setDoc-sized replacement (prefix 0, suffix 0) and marks `mdr:structure` / `mdr:first-visible`.
    const reseed = sameLines(doc.lines, next.lines) && blocks.length > 0;
    doc = next;
    blocks = reseed ? identify(doc.lines, blocks, segmentAll(doc.lines), alloc).N : buildBlocks(doc.lines, alloc);
    rebuildIndex();
    totals = emptyStats();
    for (const b of blocks) addCounts(totals, b, 1);
    dirty.clear();
    for (const b of blocks) dirty.add(b.id);
    need.clear();
    viewport = { firstLine: 1, lastLine: 1 };
    refsJson = '';
    rebuildRefs();
    draft.reset();
    afterDocChange(dirty);
  }

  /** `edit` never renders inline: it queues and lets `flushTask` apply the whole burst at once. */
  function queueEdit(m: Extract<ToWorker, { type: 'edit' }>): void {
    pendingEdits.push({ version: m.version, changes: m.changes });
    if (flushScheduled) return;
    flushScheduled = true;
    yieldFlush();
  }

  function flushTask(): void {
    flushScheduled = false;
    flushEdits();
  }

  /** Applies (and clears) every queued transaction. Called from the flush task and synchronously by any
   *  other message that must see an up-to-date document. */
  function flushEdits(): void {
    if (pendingEdits.length === 0) return;
    const batch = pendingEdits.splice(0, pendingEdits.length);
    const at = now();
    const oldLineCount = doc.lines.length;
    const changed = new Set<number>();
    let merged: ChangeEffect | null = null;
    for (let i = 0; i < batch.length; i++) {
      version = batch[i].version;
      const eff = applyChanges(doc, batch[i].changes);
      if (eff) merged = mergeEffects(merged, eff, oldLineCount);
    }
    normaliseEmpty(doc);
    let outlineTouched = false;
    let refTouched = false;
    let delta: Delta | null = null;
    if (doc.lines.length === 0) {
      if (blocks.length) {
        for (const b of blocks) {
          addCounts(totals, b, -1);
          dirty.delete(b.id);
        }
        blocks = [];
        byId.clear();
        outlineTouched = true;
        refTouched = true; // every definition the document held is gone with it
      }
    } else if (merged) {
      merged.fromLine = Math.max(1, Math.min(merged.fromLine, oldLineCount || 1));
      merged.toLineOld = Math.max(merged.fromLine, Math.min(merged.toLineOld, oldLineCount || 1));
      merged.toLineNew = Math.min(merged.toLineNew, doc.lines.length);
      const hadBlocks = blocks.length > 0;
      const r = resegmentWindow(blocks, doc.lines, merged, alloc);
      outlineTouched = merged.lineDelta !== 0 || touchesOutline(r);
      refTouched = applyReconcile(r, changed, at);
      // one contiguous replacement per flush — exactly what a StructureDeltaMsg expresses
      if (hadBlocks) delta = { index: r.index, removed: r.removed.length, inserted: r.added, lineDelta: merged.lineDelta };
    } else if (blocks.length) {
      delta = { index: 0, removed: 0, inserted: [], lineDelta: 0 }; // edit with no changes: version bump only
    }
    if (refTouched && rebuildRefs()) {
      for (const b of blocks) if (b.hasBracket) { changed.add(b.id); b.warmed = false; }   // their cache key moved with refsHash
    }
    for (const id of changed) dirty.add(id);
    // `changed` must be a subset of the inserted blocks (types.ts StructureDeltaMsg); a reference
    // definition that re-rendered blocks outside the replaced range falls back to a full structure.
    if (delta) {
      const inserted = new Set<number>();
      for (const b of delta.inserted) inserted.add(b.id);
      for (const id of changed) {
        if (!inserted.has(id)) {
          delta = null;
          break;
        }
      }
    }
    afterDocChange(changed, outlineTouched, delta);
    draft.touch();
  }

  /** Applies one resegmentation result to the state; returns whether a reference definition was touched. */
  function applyReconcile(r: ReturnType<typeof resegmentWindow>, changed: Set<number>, at: number): boolean {
    blocks = r.blocks;
    let refTouched = false;
    for (const b of r.removed) {
      addCounts(totals, b, -1);
      byId.delete(b.id);
      refTouched = refTouched || b.hasRef;
    }
    for (const b of r.added) {
      addCounts(totals, b, 1);
      byId.set(b.id, b);
      refTouched = refTouched || b.hasRef;
    }
    for (const id of r.dirty) {
      changed.add(id);
      const b = byId.get(id);
      if (b) b.lastEditAt = at; // drives the escaped-first render of big fences (see `interim`)
    }
    return refTouched;
  }

  /**
   * CONTRACT §8. The preview could not apply a `structureDelta` and asks for solid ground: answer with a
   * full `structure` for the CURRENT version, plus the outline when the client's copy may be older than
   * ours. Queued edits are flushed first — the reply must describe the document the client is about to
   * have, not the one before the burst it already sent us (their deltas go out ahead of the structure and
   * a desynced preview simply ignores them). Recovery path: never on the hot path.
   * `changed` carries the still-dirty ids, i.e. exactly the blocks whose HTML the preview has not been
   * given for this version, so the preview re-requests them instead of trusting what it has mounted.
   */
  function resync(): void {
    flushEdits();
    // A structure makes the client "not idle" again (App.afterStructure); like `viewport` / `need`, a
    // resync must therefore be answered with an `idle` even when there is nothing left to render, or
    // `waitIdle()` and the 「渲染中」 indicator would wait for ever.
    askedSinceIdle = true;
    postStructure(dirty);
    if (sentOutlineVersion !== outlineVersion) {
      post({ type: 'outline', outlineVersion, items: outline.entries });
      sentOutlineVersion = outlineVersion;
    }
    updateWindow();
    resetWalks();
    schedule();
  }

  function setOptions(patch: Partial<RenderOptions>): void {
    opts = { ...opts, ...patch };
    mathRequested = false;
    rebuildMarkdown();
    cache.clear();
    for (const b of blocks) { dirty.add(b.id); b.warmed = false; }
    if (blocks.length) postStructure(dirty);
    resetWalks();
    schedule();
  }

  /** The markdown-it instance for the current options, built on first use. */
  function mdk(): Markdown {
    if (!mdc) {
      mdc = createMarkdown(opts);
      if (opts.math && mathReady()) mdc.enableMath();
    }
    return mdc;
  }

  function rebuildMarkdown(): void {
    mdc = null;
  }

  function exportHtml(requestId: number, mathOutput: 'html' | 'htmlAndMathml' = 'htmlAndMathml'): void {
    const text = docText(doc);
    const run = async (): Promise<void> => {
      if (opts.math && !mathReady() && !mathFailed() && text.indexOf('$') >= 0) await loadMath();
      if (opts.math && mathReady()) mdk().enableMath();
      updateOutline(outline, blocks, doc.lines);
      const ids = new Map<number, string>();
      for (const e of outline.entries) ids.set(e.line, e.slug);
      post({ type: 'exportHtml', requestId, html: mdk().renderDocument(text, refsView(), ids, mathOutput) });
    };
    run().catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: false }));
  }

  /**
   * Runtime shape check for one ToWorker message (lead decision K). `isToWorker` (frozen, src/shared) is a
   * type-only guard: it accepts `{type:'edit'}` with no `changes`, which used to throw inside the core —
   * and an exception in the worker's `onmessage` reaches the client as a crash and costs a full restart.
   * A malformed message is dropped with ONE console.warn and leaves the state untouched.
   */
  function validate(m: ToWorker): ToWorker | null {
    const drop = (why: string): null => {
      console.warn(`[worker] ignoring malformed ${String((m as { type?: unknown }).type)} message: ${why}`);
      return null;
    };
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
    switch (m.type) {
      case 'init':
      case 'setOptions':
        return isObj(m.options) ? m : drop('options is not an object');
      case 'setDoc':
        if (typeof m.text !== 'string') return drop('text is not a string');
        if (typeof m.docId !== 'string') return drop('docId is not a string');
        return Number.isFinite(m.version) ? m : drop('version is not a number');
      case 'edit': {
        if (!Number.isFinite(m.version)) return drop('version is not a number');
        if (!Array.isArray(m.changes)) return drop('changes is not an array');
        for (const c of m.changes as unknown[]) {
          if (!isObj(c) || !Number.isFinite(c.from) || !Number.isFinite(c.to) || typeof c.insert !== 'string') {
            return drop('a change is not {from:number,to:number,insert:string}');
          }
        }
        return m;
      }
      case 'viewport':
        return Number.isFinite(m.firstLine) && Number.isFinite(m.lastLine) ? m : drop('firstLine/lastLine are not numbers');
      case 'need':
        if (!Array.isArray(m.ids)) return drop('ids is not an array');
        for (const id of m.ids as unknown[]) if (!Number.isFinite(id)) return drop('an id is not a number');
        return m;
      case 'draft':
        return m.action === 'enable' || m.action === 'disable' || m.action === 'clear' || m.action === 'flush'
          ? m
          : drop('unknown action');
      case 'exportHtml':
        if (!Number.isFinite(m.requestId)) return drop('requestId is not a number');
        return m.mathOutput === undefined || m.mathOutput === 'html' || m.mathOutput === 'htmlAndMathml' ? m : drop('bad mathOutput');
      case 'resync':
        return m;   // no payload to check
      default:
        return drop('unknown type');
    }
  }

  function handle(raw: ToWorker): void {
    const m = validate(raw);
    if (!m) return;
    switch (m.type) {
      case 'init':
        opts = { ...opts, ...m.options };
        rebuildMarkdown();
        post({ type: 'ready' });
        break;
      case 'setDoc':
        pendingEdits.length = 0; // they belong to the document being replaced
        setDoc(m);
        break;
      case 'edit':
        queueEdit(m);
        break;
      case 'viewport':
        flushEdits();
        askedSinceIdle = true;
        viewport = { firstLine: m.firstLine, lastLine: m.lastLine };
        updateWindow();
        resetWalks();
        schedule();
        break;
      case 'need':
        flushEdits();
        askedSinceIdle = true;
        for (const id of m.ids) if (byId.has(id)) need.add(id);
        schedule();
        break;
      case 'setOptions':
        flushEdits();
        setOptions(m.options);
        break;
      case 'draft':
        flushEdits();
        if (m.action === 'enable') draft.enable();
        else if (m.action === 'disable') draft.disable();
        else if (m.action === 'clear') draft.clear();
        else draft.flush();
        break;
      case 'exportHtml':
        flushEdits();
        exportHtml(m.requestId, m.mathOutput);
        break;
      case 'resync':
        resync();
        break;
    }
  }

  // ---------------------------------------------------------------- scheduler (SPEC 4.5)
  /** Set while a slice skipped a block that must wait (KaTeX loading / slow-block throttle). */
  let deferredSeen = false;

  /** Cache key of the escaped-only (unhighlighted) interim render of a big fence. */
  function plainKeyOf(b: Block): string {
    return `${keyOf(b)}:nh`;
  }

  /**
   * A big fence that is being typed in: highlight.js over a 26 KB block costs > 100 ms, which would make
   * every keystroke wait for it (SPEC §10 wants the preview within 1–2 frames). Such a block is pushed as
   * escaped text immediately and highlighted once the typing settles (`codeCoalesceMs` of quiet).
   */
  function interim(b: Block, t: number): boolean {
    return (
      opts.highlight && b.kind === BlockKind.Code && b.lastEditAt > 0 && t - b.lastEditAt < codeCoalesceMs &&
      b.chars >= fastCodeChars && b.chars <= opts.maxHtmlChars && (need.has(b.id) || inWindow(b))
    );
  }

  /** True when the block must be rendered but cannot be right now; arms the retry (promise / timer). */
  function deferred(b: Block, t: number): boolean {
    if (cache.has(keyOf(b))) return false;
    if (opts.math && b.hasDollar && !mathReady() && !mathFailed()) {
      requestMath();
      deferredSeen = true;
      return true;
    }
    if (interim(b, t)) {
      // the escaped text can go out now; the highlighted render follows when the block settles
      armSlowTimer(b.lastEditAt + codeCoalesceMs);
      deferredSeen = true;
      return cache.has(plainKeyOf(b)); // already pushed for this exact text: nothing new to send
    }
    if (b.slow && t < b.lastRenderAt + slowIntervalMs) {
      armSlowTimer(b.lastRenderAt + slowIntervalMs);
      deferredSeen = true;
      return true;
    }
    if (b.kind === BlockKind.Code && b.lastRenderAt > 0) {
      // coalescing: the first edit within codeCoalesceMs of the last render arms one deferred render
      if (b.renderAfter <= t && t < b.lastRenderAt + codeCoalesceMs) b.renderAfter = t + codeCoalesceMs;
      if (t < b.renderAfter) {
        armSlowTimer(b.renderAfter);
        deferredSeen = true;
        return true;
      }
    }
    return false;
  }

  function requestMath(): void {
    if (mathRequested) return;
    mathRequested = true;
    void loadMath().then((ok) => {
      if (ok) {
        if (opts.math) mdk().enableMath();
      } else {
        opts = { ...opts, math: false };
        post({ type: 'error', message: T.mathUnavailable, fatal: false });
      }
      resetWalks();
      schedule();
    });
  }

  /** Arms (or re-arms earlier) the deferred-render timer for the absolute time `at` (performance.now clock). */
  function armSlowTimer(at: number): void {
    if (slowTimer !== null) {
      if (slowTimerAt <= at) return;
      clearTimeout(slowTimer);
    }
    slowTimerAt = at;
    slowTimer = setTimeout(() => {
      slowTimer = null;
      resetWalks();
      schedule();
    }, Math.max(1, Math.ceil(at - now())));
  }

  function walkNext(w: Walk, pred: (b: Block) => boolean): Block | null {
    if (!blocks.length) return null;
    if (!w.valid) {
      w.lo = Math.min(win.centre, blocks.length - 1);
      w.hi = w.lo + 1;
      if (w.radiusScreens === null) {
        w.min = 0;
        w.max = blocks.length - 1;
      } else {
        const r = w.radiusScreens * Math.max(FILL_MIN_LINES, viewport.lastLine - viewport.firstLine + 1);
        w.min = indexOfBlockContaining(blocks, viewport.firstLine - r);
        w.max = indexOfBlockContaining(blocks, viewport.lastLine + r);
      }
      w.valid = true;
    }
    while (w.lo >= w.min || w.hi <= w.max) {
      const goDown = w.lo >= w.min && (w.hi > w.max || win.centre - w.lo <= w.hi - win.centre);
      const b = goDown ? blocks[w.lo--] : blocks[w.hi++];
      if (pred(b)) return b;
    }
    return null;
  }

  /** Dirty blocks inside the auto-push window, nearest the centre first (computed once per slice). */
  function windowDirty(t: number): Block[] {
    if (!blocks.length) return [];
    const i0 = indexOfBlockContaining(blocks, win.first);
    const i1 = indexOfBlockContaining(blocks, win.last);
    const idx: number[] = [];
    for (let i = i0; i <= i1; i++) if (dirty.has(blocks[i].id) && !deferred(blocks[i], t)) idx.push(i);
    idx.sort((a, b) => Math.abs(a - win.centre) - Math.abs(b - win.centre));
    return idx.map((i) => blocks[i]);
  }

  function nextNeed(t: number): Block | null {
    for (const id of need) {
      const b = byId.get(id);
      if (!b) {
        need.delete(id);
        continue;
      }
      if (!deferred(b, t)) return b;
    }
    return null;
  }

  function render(b: Block, noHighlight: boolean): RenderedBlock {
    onRender?.(b.id);
    const t0 = now();
    const res = mdk().renderBlock(blockSource(doc.lines, b), { references: refsView(), blockId: b.id, noHighlight });
    return { html: res.html, flags: res.flags, renderMs: now() - t0 };
  }

  function produce(b: Block, t: number): HtmlItem | null {
    const key = keyOf(b);
    let r = cache.get(key);
    let plain = false;
    if (!r && interim(b, t)) {
      // escaped text first (cheap), highlighted once the block settles: the block stays dirty
      const pk = plainKeyOf(b);
      r = cache.get(pk);
      if (!r) {
        r = render(b, true);
        cache.set(pk, r);
      }
      plain = true;
    } else if (!r) {
      r = render(b, false);
      cache.set(key, r);
      b.lastRenderAt = now();
      b.slow = r.renderMs > slowRenderMs;
    }
    // Push ONLY what the preview asked for (`need`) or what this version actually changed inside the
    // auto-push window. A block the background back-fill re-rendered because the LRU had evicted it is
    // unchanged on screen: pushing it re-mounts an untouched neighbour (findings-r3, worker finding C).
    // This content has now been rendered once, so the document-wide dirty walk must not pick the block
    // again after the next `resetWalks()` — it would only re-render what the 64 MB LRU evicted in the
    // meantime. Leaving that mark off made EVERY keystroke restart a full pass: 50 000 renders per key on
    // huge.md, which is where P13's typing peak came from. The block stays `dirty` (the preview's copy is
    // still stale), so scrolling it into the auto-push window still pushes it — from the cache when the
    // entry survived, by re-rendering when it did not.
    if (!plain) b.warmed = true;
    if (!need.has(b.id) && !(dirty.has(b.id) && inWindow(b))) return null; // warmed the cache only
    if (!plain) {
      need.delete(b.id);
      dirty.delete(b.id);
    }
    return { id: b.id, flags: r.flags, payload: r.html };
  }

  function runSlice(): void {
    scheduled = false;
    const start = now();
    let out: HtmlItem[] = [];
    let outBytes = 0;
    let worked = 0;
    deferredSeen = false;
    const flush = (): void => {
      if (!out.length) return;
      const { batch, transfer } = packHtml(out);
      post({ type: 'html', version, batch }, transfer);
      out = [];
      outBytes = 0;
    };
    const q1 = windowDirty(start);
    let q1i = 0;
    const dirtyMiss = (b: Block): boolean => dirty.has(b.id) && !b.warmed && !deferred(b, now());
    const miss = (b: Block): boolean => !cache.has(keyOf(b)) && !deferred(b, now());
    for (;;) {
      if (worked > 0 && now() - start >= WORKER_SLICE_MS) {
        flush();
        schedule();
        return;
      }
      let b: Block | null = null;
      while (q1i < q1.length && !dirty.has(q1[q1i].id)) q1i++;
      if (q1i < q1.length) b = q1[q1i++];
      else b = nextNeed(now());
      if (!b) {
        // Interactive results leave before background work: a walk may scan every block before it finds one.
        flush();
        b = walkNext(walkDirty, dirtyMiss) ?? walkNext(walkFill, miss);
      }
      if (!b) break;
      worked++;
      const item = produce(b, now());
      if (item) {
        out.push(item);
        outBytes += item.payload.length;
        if (out.length >= HTML_BATCH_MAX_ITEMS || outBytes >= HTML_BATCH_MAX_BYTES) flush();
      }
    }
    flush();
    if (deferredSeen || slowTimer !== null) return; // the slow timer / KaTeX promise reschedules
    if (idleVersion !== version || worked > 0 || askedSinceIdle) {
      idleVersion = version;
      askedSinceIdle = false;
      post({ type: 'idle', version });
    }
  }

  return { handle };
}
