// @vitest-environment jsdom
// test/v3-rev-markers.test.ts — verify-review (stage 2c, 0.2.0). Repro for REV-4.
//
// serialize.ts picks its internal markers NL / CARET / CELL / MARKUP per call (pickMarkers) among the code points
// of U+E000–U+F8FF and U+FDD0–U+FDEF that the block does not contain (G4). When fewer than four are free,
// pickMarkers() returns false WITHOUT changing the markers. unsupportedReason() turns that into the refusal
// 'markers' at the session start, but serializeBlock() and serializeBlockWithCaret() ignore the return value and
// run with the markers of the PREVIOUS call — characters the block now contains. A session that started on an
// ordinary paragraph and then receives such text (a paste of a private-use glyph table, typed or IME text) is
// serialized with document characters taken for internal markers: U+E000 becomes a line break, etc. (G4's
// corruption by another path). Expected: every pasted character is written as it is (or nothing is written).
// FAILS today.
import { describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { NoMarkersError, serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

const mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  return w;
}
/** Every code point the serializer may use as a marker: 6432 characters, all distinct. */
function markerRange(): string {
  let s = '';
  for (let c = 0xe000; c <= 0xf8ff; c++) s += String.fromCharCode(c);
  for (let c = 0xfdd0; c <= 0xfdef; c++) s += String.fromCharCode(c);
  return s;
}

describe('REV-4: serializeBlock runs with stale markers when none is free', () => {
  it('a paste of the whole private-use range into a session on a plain paragraph', () => {
    const src = 'Hello world';
    const w = mount(src);
    expect(unsupportedReason(w, src)).toBeNull();                // the session starts (markers U+E000…U+E003)
    const hints = { ...sourceStyleHints(src), editing: true };
    expect(serializeBlock(w, BlockKind.Prose, hints)).toBe('Hello world');
    const pua = markerRange();
    w.querySelector('p')!.appendChild(document.createTextNode(` ${pua}`));   // what pasteText inserts: one text node
    // Lead decision H15 (CONTRACT §11, "Stage-2c review decisions", smaller rules): when no free marker set exists
    // the block is refused in every serializer entry point and nothing is written. So the call must not return a
    // (corrupted) Markdown string; it throws the typed NoMarkersError, and unsupportedReason says 'markers'.
    // (Changed by fix-serial, round 3: the original expected the characters written as they are.)
    let md: string | null = null;
    let err: unknown = null;
    try { md = serializeBlock(w, BlockKind.Prose, hints); } catch (e) { err = e; }
    expect({ md, refused: err instanceof NoMarkersError }).toEqual({ md: null, refused: true });
    expect(unsupportedReason(w, src)).toBe('markers');
  });
});
