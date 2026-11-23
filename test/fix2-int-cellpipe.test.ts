// @vitest-environment jsdom
// test/fix2-int-cellpipe.test.ts — integrator (stage 2b): the `|` inside a link destination / title, an image
// alt or a raw HTML attribute in a table cell (noted by fix-serial-1 and fix-serial-2, not one of their items).
// INV 2 / U12: either the serializer keeps the row intact, or the fidelity gate refuses the block. A session
// must never start on such a block and then write a row that splits.
import { beforeAll, describe, expect, it } from 'vitest';
import { wrapCodeFences } from '../src/preview/createPreview';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { BlockKind, DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';

let mdk: Markdown;
beforeAll(() => {
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
});

function mount(src: string): HTMLElement {
  const r = mdk.renderBlock(src, { references: {} });
  const w = document.createElement('section');
  w.className = 'md-block';
  w.dataset.id = '1';
  if (r.flags & HTML_FLAG_TRUSTED) w.innerHTML = r.html;
  else w.replaceChildren(sanitizeToFragment(r.html));
  wrapCodeFences(w);
  if (r.flags & HTML_FLAG_RESERVED) w.setAttribute('data-mdr-x', '');
  document.body.appendChild(w);
  return w;
}

const SOURCES = [
  '| a | b |\n|---|---|\n| [l](http://x/a\\|b) | 2 |',
  '| a | b |\n|---|---|\n| <abbr title="a\\|b">t</abbr> | 2 |',
  '| a | b |\n|---|---|\n| ![a\\|b](i.png) | 2 |',
  '| a | b |\n|---|---|\n| [l](http://x "t\\|u") | 2 |',
];

describe('a | inside a link/title/alt/attribute in a table cell (INV 2 via U12)', () => {
  for (const src of SOURCES) {
    it(src.split('\n')[2], () => {
      const w = mount(src);
      try {
        if (unsupportedReason(w)) return; // refused before the gate: fine
        const hints = { ...sourceStyleHints(src), editing: true };
        const baseline = serializeBlock(w, BlockKind.Table, hints);
        if (!baselineFaithful(w, BlockKind.Table, baseline)) return; // refused by the gate: fine
        // The session would start: then typing in the last cell must not split the row.
        const cells = w.querySelectorAll('td');
        cells[cells.length - 1].append('x');
        const edited = serializeBlock(w, BlockKind.Table, hints);
        const shown = canonicalForm(w);
        const again = mount(edited);
        try {
          expect(canonicalForm(again)).toBe(shown);
        } finally {
          again.remove();
        }
      } finally {
        w.remove();
      }
    });
  }
});
