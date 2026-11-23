// @vitest-environment jsdom
// test/v3-rev-fidelity-stall.test.ts — verify-review (stage 2c, 0.2.0). Repro for REV-3.
//
// The fidelity gate (src/preview/fidelity.ts, U12) runs on the main thread at EVERY session start and resume.
// Two of its regular expressions trim trailing whitespace with an unanchored `/[\t\n\f\r ]+$/`:
//   hoist():   /[\t\n\f\r ]+$/.exec(p.s)            (text right before </em>, </i>, </strong>, </b>)
//   mathAtom(): tex.replace(/(?<!\\)[\t\n\f\r ]+$/, '')   (every formula's TeX)
// A whitespace run that is NOT at the end makes the engine retry at every position of the run: quadratic in
// its length (the same defect serialize.ts fixed with trimEndOf, G6). The block's own serialization is linear.
// Each case times the gate against the serializer on the same block; the gate must stay in the same order of
// magnitude. Both FAIL today (N = 40 000: the gate takes about 0.5–1.5 s, the serializer a few ms).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  return w;
}

function timeBoth(src: string, kind: BlockKind): { serialize: number; gate: number; ok: boolean } {
  const w = mount(src);
  const hints = { ...sourceStyleHints(src), editing: true };
  let t = performance.now();
  const baseline = serializeBlock(w, kind, hints);
  const serialize = performance.now() - t;
  t = performance.now();
  const ok = baselineFaithful(w, kind, baseline);
  const gate = performance.now() - t;
  return { serialize: Math.round(serialize), gate: Math.round(gate), ok };
}

const N = 40000;
describe('REV-3: the fidelity gate is quadratic in an inner whitespace run', () => {
  it('emphasis holding a long run of spaces (hoist)', () => {
    const r = timeBoth(`Intro *a${' '.repeat(N)}b* end`, BlockKind.Prose);
    expect(r.ok).toBe(true);
    expect(r.gate, JSON.stringify(r)).toBeLessThan(Math.max(200, 20 * r.serialize));
  });
  it('a display formula whose TeX holds a long run of spaces (mathAtom)', () => {
    const r = timeBoth(`$$\nx${' '.repeat(N)}y\n$$`, BlockKind.Math);
    expect(r.gate, JSON.stringify(r)).toBeLessThan(Math.max(200, 20 * r.serialize));
  });
});
