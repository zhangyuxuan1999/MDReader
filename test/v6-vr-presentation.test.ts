// @vitest-environment jsdom
// test/v6-vr-presentation.test.ts — verify-review (stage 2f, after fix round 5): P-G (c) writes a stamped element's
// presentation attributes exactly as recorded at the session start. ⌘B / ⌘I on part of a document's own
// <span style="font-weight:bold"> / <span style="font-style:italic">: Chromium splits the span (the copy keeps every
// attribute, the stamp included) and sets style="" on the part the user un-bolded. The DOMs below are the session DOMs
// Chromium produced (captured with bench/verify/v6-vr-bold.mjs on the candidate build). FAILS today when the write puts
// the recorded style back on the part the user changed (the screen shows it normal, the source writes it bold);
// pre-r5's serializer is printed for comparison (it wrote the live style).
// Run: perl -e 'alarm 60; exec @ARGV' npx vitest run test/v6-vr-presentation.test.ts
import { describe, expect, it } from 'vitest';
import { BlockKind } from '../src/shared/types';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const q = '&quot;';
const CASES: Array<[string, string, string, RegExp]> = [
  ['unbold-span', 'Para <span style="font-weight:bold">heavy words</span> end text',
    `<p data-l="0">Para <span style="" data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}font-weight:bold${q}}">heavy</span><span style="font-weight:bold" data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}font-weight:bold${q}}"> words</span> end text</p>`,
    /font-weight:bold[^>]*>heavy/],
  ['unitalic-span', 'Para <span style="font-style:italic">slanted words</span> end text',
    `<p data-l="0">Para <span style="" data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}font-style:italic${q}}">slanted</span><span style="font-style:italic" data-mdr-o="" data-mdr-ps="{${q}style${q}:${q}font-style:italic${q}}"> words</span> end text</p>`,
    /font-style:italic[^>]*>slanted/],
];
describe('P-G (c): a formatting command the user gave on a document\'s styled element reaches the source', () => {
  for (const [name, src, html, wrong] of CASES) {
    it(name, () => {
      const w = document.createElement('section');
      w.className = 'md-block';
      w.innerHTML = html;
      document.body.replaceChildren(w);
      const tree = serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), stamped: true, editing: true });
      const pre = (pre5.serializeBlock as typeof serializeBlock)(w, BlockKind.Prose, { ...pre5.sourceStyleHints(src), editing: true });
      console.log(`PRES ${name}: tree=${JSON.stringify(tree)} pre=${JSON.stringify(pre)}`);
      expect(wrong.test(tree), tree).toBe(false);
    });
  }
});
