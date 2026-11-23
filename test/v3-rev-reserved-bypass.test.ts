// @vitest-environment jsdom
// test/v3-rev-reserved-bypass.test.ts — verify-review (stage 2c, 0.2.0). Repros for REV-1 and REV-2.
//
// U10 (CONTRACT §11): a block whose raw HTML carries a name the app reserves (data-l, data-lang, data-md…,
// class md-… / mdr-…) must be flagged by the worker (HTML_FLAG_RESERVED → data-mdr-x on the wrapper), so the
// serializer refuses it and interactions.ts does not toggle its checkboxes. rawHtmlReserved() (src/worker/md.ts)
// decides that by scanning the raw HTML token text "the way an HTML tokenizer would". It differs from the
// HTML parser in two ways, each of which puts a reserved name into the block DOM WITHOUT the flag:
//
//   REV-1  RAWTEXT / RCDATA elements (<style>, <xmp>, <title>, <textarea>, <noembed>, <noframes>, <iframe>,
//          <script>). In the browser `<!--` inside them is plain text and their end tag closes them; the scan
//          treats `<!--` as a comment start and skips to `-->`, so every tag between the end tag and `-->` is
//          invisible to it — and fully parsed (and kept by DOMPurify) in the DOM.
//   REV-2  Named character references in a class value: `&Tab;` (U+0009) and `&NewLine;` (U+000A) are class
//          separators. decodeNumericRefs() decodes only numeric references, so `class="a&Tab;md-math"` reads
//          as ONE token to the scan and as the two tokens `a`, `md-math` to the browser.
//
// Every case below asserts { planted: true, reserved: true }: the reserved name IS in the sanitized DOM (as the
// preview mounts it), and the worker's flag must then be set. All "bypass" cases FAIL today with reserved:false.
// The consequence tests show what the unflagged names do: a checkbox click toggles a task on another line
// (interactions.ts), and one typed letter turns a hidden raw <span> into a visible formula ($…$) in the source.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED, type BusEvents, type EventBus } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import { attachInteractions } from '../src/preview/interactions';

let mdk: Markdown;
beforeAll(() => {
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
});

/** Renders `src` as ONE block the way the worker does and mounts it the way createPreview.mountItem does. */
function mount(src: string, id = 5): { w: HTMLElement; reserved: boolean } {
  const r = mdk.renderBlock(src, { references: {} });
  const w = document.createElement('section');
  w.className = 'md-block';
  w.dataset.id = String(id);
  w.replaceChildren(sanitizeToFragment(r.html));
  wrapCodeFences(w);
  const reserved = (r.flags & HTML_FLAG_RESERVED) !== 0;
  if (reserved) w.setAttribute('data-mdr-x', '');
  return { w, reserved };
}

const probe = (src: string, sel: string): { planted: boolean; reserved: boolean } => {
  const { w, reserved } = mount(src);
  return { planted: w.querySelector(sel) !== null, reserved };
};

describe('REV-1: a RAWTEXT / RCDATA element hides tags from rawHtmlReserved', () => {
  const cases: Array<[string, string, string]> = [
    ['style (html_block), forged li[data-l]', '<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I agree</li></ul>-->', 'li[data-l="-4"]'],
    ['style inline in a paragraph, class md-math', 'Read <style><!--</style><span class="md-math"><code>x</code></span>--> this', 'span.md-math'],
    ['xmp inline, class md-math', 'Read <xmp><!--</xmp><span class="md-math"><code>x</code></span>--> this', 'span.md-math'],
    ['title inline, data-l', 'a <title><!--</title><b data-l="9">x</b>--> b', 'b[data-l="9"]'],
    ['textarea (html_block), data-l', '<textarea><!--</textarea><b data-l="9">x</b>-->', 'b[data-l="9"]'],
    ['noembed inline, class md-block', 'a <noembed><!--</noembed><span class="md-block" data-id="1">x</span>--> b', 'span.md-block'],
    ['noframes inline, data-lang', 'a <noframes><!--</noframes><b data-lang="x">y</b>--> b', 'b[data-lang]'],
    ['iframe inline, data-l', 'a <iframe><!--</iframe><b data-l="9">x</b>--> b', 'b[data-l="9"]'],
    ['script inline, data-l', 'a <script><!--</script><b data-l="9">x</b>--> b', 'b[data-l="9"]'],
  ];
  for (const [name, src, sel] of cases) {
    it(`bypass: ${name}`, () => {
      expect(probe(src, sel), src).toEqual({ planted: true, reserved: true });
    });
  }
  // No `<!--` at all (so the serializer's 'comment' refusal does not apply): inside <style> the CDATA token is
  // text; the browser ends the RAWTEXT at `</style x="a><b title=">` (an end tag whose attribute value holds
  // `a><b title=`), the scan instead skips the "bogus comment" to the FIRST `>` and resumes inside that value,
  // where `<b title="…">` swallows `<span class=` as an attribute value.
  it('bypass: style + CDATA token, no comment (inline, class md-math)', () => {
    const src = 'Read <style><![CDATA[</style x="a><b title="><span class="md-math"><code>X</code></span>"]]> this';
    expect(probe(src, 'span.md-math'), src).toEqual({ planted: true, reserved: true });
  });
  it('control: the same names without the trick are flagged', () => {
    expect(probe('<ul><li data-l="-4"><input type="checkbox"> I agree</li></ul>', 'li[data-l="-4"]')).toEqual({ planted: true, reserved: true });
    expect(probe('Read <span class="md-math"><code>x</code></span> this', 'span.md-math')).toEqual({ planted: true, reserved: true });
  });
  it('control: a real comment hides nothing from the DOM either', () => {
    // fix-trust r3, lead decision U15 (CONTRACT §11): the scan decides on the token TEXT, a comment's included, so this
    // block is flagged (an intended false positive; was `reserved: false`). Nothing is planted, as before.
    expect(probe('a <!-- <b data-l="9">x</b> --> b', 'b[data-l="9"]')).toEqual({ planted: false, reserved: true });
  });
});

describe('REV-2: a named whitespace reference in a class value hides a reserved class token', () => {
  const cases: Array<[string, string, string]> = [
    ['&Tab; before md-math', 'Read <span class="&Tab;md-math"><code>x</code></span> this', 'span.md-math'],
    ['&NewLine; between tokens, md-block', 'a <span class="x&NewLine;md-block" data-id="1">y</span> b', 'span.md-block'],
    ['&Tab; in an html_block section', '<section class="&Tab;md-block" data-id="1">\n<p>x</p>\n</section>', 'section.md-block'],
    ['&Tab; mdr- prefix', 'a <b class="&Tab;mdr-thing">y</b> b', 'b.mdr-thing'],
  ];
  for (const [name, src, sel] of cases) {
    it(`bypass: ${name}`, () => {
      expect(probe(src, sel), src).toEqual({ planted: true, reserved: true });
    });
  }
});

/** A minimal bus that records what interactions.ts emits. */
function recordingBus(): { bus: EventBus; edits: Array<BusEvents['source:edit']> } {
  const edits: Array<BusEvents['source:edit']> = [];
  const bus = {
    emit(name: string, payload: unknown) { if (name === 'source:edit') edits.push(payload as BusEvents['source:edit']); },
    on() { return () => {}; },
  } as unknown as EventBus;
  return { bus, edits };
}

describe('consequences', () => {
  it('REV-1: a click on the forged checkbox toggles the task on line 1 (another block)', () => {
    // Document: line 1 "- [ ] pay the rent", line 3 "Read the terms below.", line 5 the html_block (block id 5).
    const html = '<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I have read the terms</li></ul>-->';
    const { w } = mount(html, 5);
    const root = document.createElement('div');
    root.appendChild(w);
    document.body.appendChild(root);
    const { bus, edits } = recordingBus();
    const off = attachInteractions(root, {
      bus, setFocusLine() {}, currentFocusLine: () => null, startLineOf: (id) => (id === 5 ? 5 : id === 1 ? 1 : undefined),
      outline: () => [], isEditing: () => false,
    });
    try {
      const box = w.querySelector('input')!;
      box.click();   // a real click: the browser toggles it and fires change
      expect(edits, 'no write for a checkbox whose line map came from the document').toEqual([]);
    } finally { off(); root.remove(); }
  });

  it('REV-2: a forged .md-block[data-id] redirects a real task checkbox to another block\'s lines', () => {
    // The segmenter glues an unclosed <section> container and the Markdown up to </section> into ONE block,
    // so the task list inside carries the worker's own data-l (2) and is not raw HTML at all.
    const src = '<section class="&Tab;md-block" data-id="1">\n\n- [ ] I have read the terms\n\n</section>';
    const { w, reserved } = mount(src, 5);
    // fix-trust r3, lead decision U15: the text scan sees `md-block` after `;` and flags the block (was: false).
    expect(reserved).toBe(true);
    const root = document.createElement('div');
    root.appendChild(w);
    document.body.appendChild(root);
    const { bus, edits } = recordingBus();
    const off = attachInteractions(root, {
      bus, setFocusLine() {}, currentFocusLine: () => null, startLineOf: (id) => (id === 5 ? 40 : id === 1 ? 1 : undefined),
      outline: () => [], isEditing: () => false,
    });
    try {
      w.querySelector('input')!.click();
      // fix-trust r3: the block is flagged (U15), and a flagged block toggles no checkbox (U10, unchanged), so nothing is
      // written (was: its own line, 42). The flag-independent U16 path is covered in test/r3-t-checkbox.test.ts.
      expect(edits).toEqual([]);
    } finally { off(); root.remove(); }
  });

  it('REV-1: one typed letter turns a raw <span> hidden behind <style><![CDATA[…]]> into a formula in the source', () => {
    const src = 'Please read <style><![CDATA[</style x="a><b title="><span class="md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>"]]> the terms';
    const { w, reserved } = mount(src);
    // fix-trust r3, lead decision U15 (CONTRACT §11): the text scan flags the block (was: false), so U10 c refuses it:
    expect(reserved).toBe(true);
    const refused = unsupportedReason(w, src);
    expect(refused).toBe('reserved');                                  // no session starts (was: null)
    for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
    const hints = { ...sourceStyleHints(src), editing: true };
    const baseline = serializeBlock(w, BlockKind.Prose, hints);
    expect(baselineFaithful(w, BlockKind.Prose, baseline)).toBe(true);  // …and the fidelity gate lets it through
    const p = w.querySelector('p')!;
    (p.lastChild as Text).data += 's';
    const md = serializeBlock(w, BlockKind.Prose, hints);
    // What reaches the source: a session's serialization only when a session starts; a refused block writes nothing.
    const written = refused === null ? md : src;
    expect(written, 'the hidden raw HTML must stay raw HTML').not.toContain('$\\text{Call');
  });

  it('REV-2: one typed letter turns a hidden raw <span> into a visible formula in the source', () => {
    const src = 'Please read <span class="&Tab;md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>the terms';
    const { w, reserved } = mount(src);
    // fix-trust r3, lead decision U15 (CONTRACT §11): the text scan flags the block (was: false), so U10 c refuses it:
    expect(reserved).toBe(true);
    const refused = unsupportedReason(w, src);
    expect(refused).toBe('reserved');                                  // no session starts (was: null)
    for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
    const hints = { ...sourceStyleHints(src), editing: true };
    const baseline = serializeBlock(w, BlockKind.Prose, hints);
    expect(baselineFaithful(w, BlockKind.Prose, baseline)).toBe(true);  // …and the fidelity gate lets it through
    const p = w.querySelector('p')!;
    (p.lastChild as Text).data += 's';                                  // the user types one letter at the end
    const md = serializeBlock(w, BlockKind.Prose, hints);
    // What reaches the source: a session's serialization only when a session starts; a refused block writes nothing.
    const written = refused === null ? md : src;
    expect(written, 'the hidden raw HTML must stay raw HTML').not.toContain('$\\text{Call');
  });
});
