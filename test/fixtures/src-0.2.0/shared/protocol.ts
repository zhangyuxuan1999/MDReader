// src/shared/protocol.ts — packing/unpacking of transferable HTML batches + message guards.
import type { FromWorker, HtmlBatch, HtmlItem, ToWorker } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Packs rendered blocks into one set of typed arrays so the whole batch is transferred
 * (zero-copy) instead of structured-cloned as thousands of strings.
 */
export function packHtml(items: HtmlItem[]): { batch: HtmlBatch; transfer: ArrayBuffer[] } {
  const n = items.length;
  const ids = new Int32Array(n);
  const flags = new Uint8Array(n);
  const offsets = new Uint32Array(n + 1);
  let cap = 0;
  for (let i = 0; i < n; i++) cap += items[i].payload.length * 3; // UTF-16 → UTF-8 worst case
  const scratch = new Uint8Array(cap);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    ids[i] = it.id;
    flags[i] = it.flags & 0xff;
    offsets[i] = pos;
    if (it.payload.length > 0) {
      const r = encoder.encodeInto(it.payload, scratch.subarray(pos));
      pos += r.written;
    }
  }
  offsets[n] = pos;
  // Copy to an exactly-sized buffer so we never transfer a mostly-empty 3x allocation.
  const utf8 = scratch.slice(0, pos);
  return {
    batch: { ids, flags, offsets, utf8 },
    transfer: [ids.buffer, flags.buffer, offsets.buffer, utf8.buffer],
  };
}

export function unpackHtml(b: HtmlBatch): HtmlItem[] {
  const n = b.ids.length;
  const out: HtmlItem[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const start = b.offsets[i];
    const end = b.offsets[i + 1];
    out[i] = {
      id: b.ids[i],
      flags: b.flags[i],
      payload: end > start ? decoder.decode(b.utf8.subarray(start, end)) : '',
    };
  }
  return out;
}

const FROM_WORKER_TYPES = new Set<FromWorker['type']>([
  'ready', 'structure', 'structureDelta', 'outline', 'html', 'idle', 'draftSaved', 'exportHtml', 'error',
]);
const TO_WORKER_TYPES = new Set<ToWorker['type']>([
  'init', 'setDoc', 'edit', 'viewport', 'need', 'setOptions', 'draft', 'exportHtml', 'resync',
]);

export function isFromWorker(x: unknown): x is FromWorker {
  return typeof x === 'object' && x !== null && FROM_WORKER_TYPES.has((x as { type: FromWorker['type'] }).type);
}

export function isToWorker(x: unknown): x is ToWorker {
  return typeof x === 'object' && x !== null && TO_WORKER_TYPES.has((x as { type: ToWorker['type'] }).type);
}
