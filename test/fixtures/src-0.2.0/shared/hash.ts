// src/shared/hash.ts — 64-bit content hash (two independent 32-bit lanes) over UTF-16 code units.
// Lane A is FNV-1a (seed 0x811c9dc5, prime 0x01000193); lane B uses a different seed and multiplier
// (0x9747b28c, 0x5bd1e995) so the lanes are not affine images of each other.

export function fnv1a64(s: string): [lo: number, hi: number] {
  let a = 0x811c9dc5 | 0;
  let b = 0x9747b28c | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul((b ^ c) + ((b << 5) | (b >>> 27)), 0x5bd1e995);
  }
  return [a >>> 0, b >>> 0];
}

/** Stable string key for LRU caches: hi:lo:len. */
export function hashKey(lo: number, hi: number, len: number): string {
  return `${hi}:${lo}:${len}`;
}

/** Cheap 32-bit hash for small strings (outline fingerprints etc.). */
export function fnv1a32(s: string): number {
  let a = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
  return a >>> 0;
}
