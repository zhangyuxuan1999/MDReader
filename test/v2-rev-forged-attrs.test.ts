// @vitest-environment jsdom
// test/v2-rev-forged-attrs.test.ts — verify-review (stage 2a, 0.2.0). REV-1 repro.
//
// The serializer trusts attributes that the document itself can carry: DOMPurify (src/preview/sanitize.ts)
// keeps every data-* attribute (ALLOW_DATA_ATTR defaults to true) and `class` / `style`. Raw inline HTML
// in a paragraph (`<span …>`, RAW_INLINE_OK) leaves the block editable (unsupportedReason → null), so a
// hostile document can plant:
//   - `data-md="…"`: rule mdrRaw writes the attribute VALUE verbatim instead of the element, so the first
//     edit of the paragraph writes arbitrary Markdown the user never typed and never saw (with
//     style="display:none" the carrier is invisible in the preview);
//   - `data-mdr-ui`: prepare() removes the element (UI-only), so the first edit deletes its text from the
//     source;
//   - `class="md-math"`: prepare() turns the element into `$…$`, so the first edit turns text into math.
// Each case: the block renders, a session would start (unsupportedReason null), the user types ONE
// character in the paragraph's plain text, and the serialization must keep the carrier's source
// (expected) instead of replacing / dropping it (observed). All three FAIL today.
//
// Stage 2b (fix-serial-1), lead decision U10 (CONTRACT §11): the worker flags a block whose raw HTML
// carries a reserved name (HTML_FLAG_RESERVED), createPreview marks its wrapper with data-mdr-x and
// unsupportedReason() refuses it, so such a block is never serialized in a session; the sanitizer drops
// data-md / data-md-block / data-mdr-* (U10 d). Each case now checks (1) the pipeline: the wrapper as
// createPreview marks it is refused (`refused`), or, for the <a> case (no reserved name), editable; and
// (2) defence in depth: serialized WITHOUT data-mdr-x, no attribute value becomes Markdown structure and no
// visible text is deleted (`md`); for the data-md cases also on a DOM that bypassed the sanitizer (`raw`).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { normalizeHtml, serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

const render = (src: string): string => mdk.renderBlock(src, { references: {} }).html;
const flagsOf = (src: string): number => mdk.renderBlock(src, { references: {} }).flags;

/** Mounts worker HTML the way createPreview.mountItem does, then marks it the way inlineEdit.begin() does.
 *  `reserved`: the block's flags carry HTML_FLAG_RESERVED, so createPreview sets data-mdr-x (U10 b).
 *  `raw`: the HTML bypasses the sanitizer (defence-in-depth checks of the serializer alone). */
function mountForSession(html: string, reserved = false, raw = false): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  if (raw) w.innerHTML = html;
  else w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  if (reserved) w.setAttribute('data-mdr-x', '');
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}

/** The user types `ch` at the end of the paragraph's first text node (what insertText does). */
function typeAtStart(w: HTMLElement, ch: string): void {
  const p = w.querySelector('p')!;
  const t = p.firstChild as Text;
  t.data = t.data + ch;
}

function edit(src: string, raw = false): { md: string; before: string; after: string; editable: string | null; refused: string | null } {
  const reserved = (flagsOf(src) & HTML_FLAG_RESERVED) !== 0;
  const refused = unsupportedReason(mountForSession(render(src), reserved), src);   // the pipeline (U10 b, c)
  const w = mountForSession(render(src), false, raw);                                 // defence in depth: no data-mdr-x
  const editable = unsupportedReason(w, src);
  const before = normalizeHtml(w.innerHTML);
  typeAtStart(w, 'X');
  const md = serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
  const after = normalizeHtml(mountForSession(render(md)).innerHTML);
  return { md, before, after, editable, refused };
}

describe('REV-1: document-controlled attributes steer the serializer', () => {
  it('data-md: an invisible carrier writes hidden Markdown into the source on the first edit', () => {
    const src = 'Fix the typo here <span data-md="[bank login](https://evil.example/phish)" style="display:none">.</span> please';
    const r = expect.soft;
    const { md, refused } = edit(src);
    r(refused).toBe('reserved');                                // U10 c: the block is refused (was: editable)
    // expected: no payload; the carrier keeps no data-md (U10 d removes it), so `toContain('data-md=')` is gone
    r(md).not.toContain('https://evil.example/phish)');
    r(md).toContain('Fix the typo');
    const raw = edit(src, true);                              // the serializer alone, data-md in the DOM (U10 e)
    r(raw.md).not.toContain('https://evil.example/phish)');
    r(raw.md).toContain('Fix the typo');
  });

  it('data-md + data-md-block: the payload can be whole blocks (a heading, a link definition)', () => {
    const src = 'Hello <span data-md="&#10;&#10;# Injected heading&#10;&#10;[x]: https://evil.example" data-md-block style="display:none">.</span> world';
    const { md, refused } = edit(src);
    expect.soft(refused).toBe('reserved');                      // U10 c (added)
    expect.soft(md).not.toMatch(/^# Injected heading$/m);
    const raw = edit(src, true);                              // U10 e (added)
    expect.soft(raw.md).not.toMatch(/^# Injected heading$/m);
    expect.soft(raw.md).not.toMatch(/^\[x\]:/m);
    expect.soft(raw.md).toContain('world');
  });

  it('data-mdr-ui: the carrier and its text are deleted from the source on the first edit', () => {
    const src = 'Keep <span data-mdr-ui>THIS TEXT</span> safe';
    const { md, editable, before, refused } = edit(src);
    expect.soft(refused).toBe('reserved');                     // U10 c (added)
    expect.soft(editable).toBeNull();                        // without data-mdr-x (sanitized: no data-mdr-ui left)
    expect.soft(before).toContain('THIS TEXT');              // the user sees it in the preview
    expect.soft(md).toContain('THIS TEXT');                  // observed: gone
  });

  it('data-lang on an inline <pre>: the attribute value is written as the fence info string, newlines included', () => {
    const src = 'Text <pre data-lang="js&#10;&#10;# Injected via data-lang">x</pre> more';
    const { md, editable, refused } = edit(src);
    expect.soft(refused).toBe('reserved');                     // U10 c (was: editable)
    expect.soft(editable).not.toBeNull();                    // U10 e: a language that would leave its fence line is refused even without data-mdr-x (was: editable)
    expect.soft(md).not.toMatch(/^# Injected via data-lang$/m);
  });

  it('a raw <a> whose href / title holds blank lines: the link is written across lines and breaks the block', () => {
    for (const src of [
      'See <a href="https://ok.example/&#10;&#10;# Injected via href">the site</a> now',
      'See <a href="https://ok.example/" title="t&#10;&#10;# Injected via title">the site</a> now',
    ]) {
      const { md, editable } = edit(src);
      expect.soft(editable).toBeNull();
      expect.soft(md, src).not.toMatch(/^# Injected via/m);
    }
  });

  it('class="md-math": plain text turns into a formula on the first edit', () => {
    const src = 'Price <span class="md-math md-math--inline">E</span> today';
    const { md, editable, refused } = edit(src);
    expect.soft(refused).toBe('reserved');                     // U10 c (added)
    expect.soft(editable).toBeNull();                        // without data-mdr-x
    expect.soft(md).not.toContain('$E$');                    // observed: `$E$` (renders as math)
    expect.soft(md).toContain('E</span> today');             // the element stays raw HTML with its text
  });
});
