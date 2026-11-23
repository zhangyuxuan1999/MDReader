// @vitest-environment jsdom
// test/r6-fr-pres.test.ts — fix-refs (0.2.0 stage 2g, fix round 6): M3 (CONTRACT §11, Round-5 verification decisions) at the
// unit level. The session DOMs below are what Chromium left after a format command of the session (⌘B / ⌘I, once or twice)
// on a document's own styled element — part of it, the whole of it, bold, italic, both, with a colour, nested spans, a
// bold span in bold text, the font shorthand, in a list item and a quote — captured in the app with
// bench/verify/r6-fr-bold.mjs (stamps included). The write must be what the session showed (the source the app wrote
// after Esc, checked there against the re-rendered block). Then the join side: what the browser adds is never written,
// and an element whose style attribute the browser removed (its clean-up of a join) keeps its record.
// pre-r6's serializer was asked too: it put the recorded style back (the test failed without the change). Since round 7
// (CONTRACT §11 Checkpoint I) that snapshot is gone and `pre6` is the frozen copy of the released 0.2.0
// (test/fixtures/src-0.2.0), which has M3: it writes what the session showed, as the tree.
// Run: perl -e 'alarm 60; exec @ARGV' npx vitest run test/r6-fr-pres.test.ts
import { describe, expect, it } from 'vitest';
import { BlockKind } from '../src/shared/types';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
import * as pre6 from './fixtures/src-0.2.0/preview/serialize';

const FIXTURES: Array<{ name: string; src: string; html: string; want: string }> = [
 {
  "name": "unbold-part",
  "src": "Para <span style=\"font-weight:bold\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\">heavy</span><span style=\"font-weight:bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span>heavy</span> <span style=\"font-weight:bold\">words</span> end text"
 },
 {
  "name": "unbold-whole",
  "src": "Para <span style=\"font-weight:bold\">heavy</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\">heavy</span> end text</p>\n",
  "want": "Para <span>heavy</span> end text"
 },
 {
  "name": "unitalic-part",
  "src": "Para <span style=\"font-style:italic\">slanted words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\">slanted</span><span style=\"font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span>slanted</span> <span style=\"font-style:italic\">words</span> end text"
 },
 {
  "name": "unitalic-whole",
  "src": "Para <span style=\"font-style:italic\">slanted</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\">slanted</span> end text</p>\n",
  "want": "Para <span>slanted</span> end text"
 },
 {
  "name": "both-unbold",
  "src": "Para <span style=\"font-weight:bold;font-style:italic\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"font-style: italic;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\">heavy</span><span style=\"font-weight:bold;font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span style=\"font-style: italic;\">heavy</span> <span style=\"font-weight:bold;font-style:italic\">words</span> end text"
 },
 {
  "name": "both-unitalic",
  "src": "Para <span style=\"font-weight:bold;font-style:italic\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"font-weight: bold;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\">heavy</span><span style=\"font-weight:bold;font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span style=\"font-weight: bold;\">heavy</span> <span style=\"font-weight:bold;font-style:italic\">words</span> end text"
 },
 {
  "name": "both-both",
  "src": "Para <span style=\"font-weight:bold;font-style:italic\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\">heavy</span><span style=\"font-weight:bold;font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;font-style:italic&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span>heavy</span> <span style=\"font-weight:bold;font-style:italic\">words</span> end text"
 },
 {
  "name": "color-unbold",
  "src": "Para <span style=\"font-weight:bold;color:red\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"color: red;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;color:red&quot;}\">heavy</span><span style=\"font-weight:bold;color:red\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold;color:red&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span style=\"color: red;\">heavy</span> <span style=\"font-weight:bold;color:red\">words</span> end text"
 },
 {
  "name": "nested-unbold",
  "src": "Para <span style=\"font-weight:bold\">a <span style=\"font-style:italic\">heavy</span> b</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\"><b>a </b><span style=\"font-style: italic;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\">heavy</span><b> b</b></span> end text</p>\n",
  "want": "Para <span>**a** <span style=\"font-style:italic\">heavy</span> **b**</span> end text"
 },
 {
  "name": "nested-unitalic",
  "src": "Para <span style=\"font-weight:bold\">a <span style=\"font-style:italic\">heavy words</span> b</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"font-weight:bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\">a <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\">heavy</span><span style=\"font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\"> words</span> b</span> end text</p>\n",
  "want": "Para <span style=\"font-weight:bold\">a <span>heavy</span> <span style=\"font-style:italic\">words</span> b</span> end text"
 },
 {
  "name": "bold-normalspan",
  "src": "Para **x <span style=\"font-weight:normal\">light words</span> y** end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <strong>x <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:normal&quot;}\">light</span><span style=\"font-weight:normal\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:normal&quot;}\"> words</span> y</strong> end text</p>\n",
  "want": "Para **x <span>light</span> <span style=\"font-weight:normal\">words</span> y** end text"
 },
 {
  "name": "bold-in-red",
  "src": "Para <span style=\"color:red\">red words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"color:red\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;color:red&quot;}\"><b>red</b> words</span> end text</p>\n",
  "want": "Para <span style=\"color:red\">**red** words</span> end text"
 },
 {
  "name": "unbold-rebold",
  "src": "Para <span style=\"font-weight:bold\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\"><b>heavy</b></span><span style=\"font-weight:bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span>**heavy**</span> <span style=\"font-weight:bold\">words</span> end text"
 },
 {
  "name": "font-shorthand",
  "src": "Para <span style=\"font:bold 16px serif\">heavy words</span> end text",
  "html": "<p data-l=\"0\" class=\"is-focus\">Para <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font:bold 16px serif&quot;}\">heavy</span><span style=\"font:bold 16px serif\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font:bold 16px serif&quot;}\"> words</span> end text</p>\n",
  "want": "Para <span style=\"font-style: normal; font-variant: normal; font-size-adjust: none; font-language-override: normal; font-kerning: auto; font-optical-sizing: auto; font-feature-settings: normal; font-variation-settings: normal; font-stretch: normal; font-size: 16px; line-height: normal; font-family: serif;\">heavy</span> <span style=\"font:bold 16px serif\">words</span> end text"
 },
 {
  "name": "item-unbold",
  "src": "- Para <span style=\"font-weight:bold\">heavy words</span> end text\n- two",
  "html": "<ul>\n<li data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\">heavy</span><span style=\"font-weight:bold\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-weight:bold&quot;}\"> words</span> end text</li>\n<li data-l=\"1\">two</li>\n</ul>\n",
  "want": "- Para <span>heavy</span> <span style=\"font-weight:bold\">words</span> end text\n- two"
 },
 {
  "name": "quote-unitalic",
  "src": "> Para <span style=\"font-style:italic\">slanted words</span> end text",
  "html": "<blockquote data-l=\"0\">\n<p data-l=\"0\" class=\"is-focus\">Para <span style=\"\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\">slanted</span><span style=\"font-style:italic\" data-mdr-o=\"\" data-mdr-ps=\"{&quot;style&quot;:&quot;font-style:italic&quot;}\"> words</span> end text</p>\n</blockquote>\n",
  "want": "> Para <span>slanted</span> <span style=\"font-style:italic\">words</span> end text"
 }
];
const kindOf = (src: string): BlockKind => (src.startsWith('- ') ? BlockKind.List : src.startsWith('> ') ? BlockKind.Quote : BlockKind.Prose);
function write(src: string, html: string, which: 'tree' | 'pre' = 'tree'): string {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.innerHTML = html;
  document.body.replaceChildren(w);
  const ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : (pre6 as unknown as { serializeBlock: typeof serializeBlock; sourceStyleHints: typeof sourceStyleHints });
  return ser.serializeBlock(w, kindOf(src), { ...ser.sourceStyleHints(src), stamped: true, editing: true });
}
const q = '&quot;';
const ps = (style: string): string => `data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}${style}${q}}"`;

describe('M3: a format command of the session is what is written', () => {
  // (font-shorthand: jsdom's CSSOM does not split a `font` shorthand on removeProperty as Chromium does: checked in the browser,
  // bench/verify/r6-fr-bold.mjs)
  for (const f of FIXTURES.filter((x) => x.name !== 'font-shorthand')) {
    it(f.name, () => { expect(write(f.src, f.html), f.html).toBe(f.want); });
  }
  // (written against the serializer before round 6, which put the recorded style back: /font-weight:bold"?>heavy/; the
  // released 0.2.0 has the change)
  it('the released 0.2.0 (it has M3) writes what the session showed', () => {
    const f = FIXTURES.find((x) => x.name === 'unbold-part')!;
    expect(write(f.src, f.html, 'pre')).toBe(f.want);
  });
});

describe('M3: what the browser does outside a command is still not written', () => {
  it('declarations the browser adds (a join bakes computed styles) are not written', () => {
    const html = `<p>Para <span style="font-weight: bold; color: rgb(31, 34, 38); font-size: 16px; font-style: normal;" ${ps('font-weight:bold')}>heavy</span> end text</p>`;
    expect(write('Para <span style="font-weight:bold">heavy</span> end text', html)).toBe('Para <span style="font-weight:bold">heavy</span> end text');
  });
  it('a style attribute the browser removed (the clean-up of a join) leaves the record as it is', () => {
    const html = `<p>Para <span ${ps('font-weight:bold')}>heavy</span> end text</p>`;
    expect(write('Para <span style="font-weight:bold">heavy</span> end text', html)).toBe('Para <span style="font-weight:bold">heavy</span> end text');
  });
  it('only font-weight and font-style are taken off: another declaration the live style lost stays recorded', () => {
    const html = `<p>Para <span style="font-weight: bold;" ${ps('font-weight:bold;color:red')}>heavy</span> end text</p>`;
    expect(write('Para <span style="font-weight:bold;color:red">heavy</span> end text', html)).toBe('Para <span style="font-weight:bold;color:red">heavy</span> end text');
  });
  it('an unchanged element keeps its recorded bytes', () => {
    const html = `<p>Para <span style="font-weight: bold;" ${ps('font-weight:bold')}>heavy</span> end text</p>`;
    expect(write('Para <span style="font-weight:bold">heavy</span> end text', html)).toBe('Para <span style="font-weight:bold">heavy</span> end text');
  });
  it('an element without a stamp gets no style (P-G c)', () => {
    const html = '<p>Para <strong style="font-weight: 700;">heavy</strong> end text</p>';
    expect(write('Para **heavy** end text', html)).toBe('Para **heavy** end text');
  });
});
