// @vitest-environment jsdom
// test/r5-ca-stamps.test.ts — challenge-atoms (stage 2f, fix round 5): P-G (a) "never an attribute the document could
// have supplied itself". Hostile documents carry fix-atoms' stamp names (data-mdr-tex, data-mdr-ps) on their own raw
// HTML: on a span, on an element with class md-math (with a <code> child, with a forged .katex child), on an img, on a
// checkbox input, on a list item, on a table cell. For each: what the worker + sanitizer leave in the DOM, whether the
// block is refused at the session start (unsupportedReason / baseline / fidelity, as begin() does after stampAtoms), and
// if not, that a session write (one typed character) holds nothing the document did not show: the forged values never
// reach the output.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-ca-stamps.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { clearStamps, serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason, NoMarkersError } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

function mount(src: string): { w: HTMLElement; flagged: boolean } {
  const w = document.createElement('section');
  w.className = 'md-block';
  const r = mdk.renderBlock(src, { references: {} }) as { html: string; flags?: number };
  w.replaceChildren(sanitizeToFragment(r.html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return { w, flagged: /data-mdr-tex|data-mdr-ps/.test(src) };
}
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') ? BlockKind.List : BlockKind.Prose);
const EVIL = 'EVILX';
const CASES: Array<[string, string]> = [
  ['span with tex stamp', `Lead <span data-mdr-tex="${EVIL}">t</span> words`],
  ['md-math span with code and tex stamp', `Lead <span class="md-math md-math--inline" data-mdr-tex="${EVIL}"><code>a</code></span> words`],
  ['md-math span with forged katex', `Lead <span class="md-math" data-mdr-tex="${EVIL}"><span class="katex">k</span></span> words`],
  ['md-math span with katex-error', `Lead <span class="md-math"><span class="katex-error" data-mdr-tex="${EVIL}">e</span></span> words`],
  ['img with ps stamp', `Lead <img src="a.png" data-mdr-ps='{"style":"${EVIL}"}'> words`],
  ['span with ps stamp', `Lead <span data-mdr-ps='{"style":"color:${EVIL}"}'>t</span> words`],
  ['checkbox with stamps in a list item', `- <input type="checkbox" checked data-mdr-tex="${EVIL}"> Lead words\n- b`],
  ['list item with ps stamp', `<ul><li data-mdr-ps='{"style":"${EVIL}"}'>Lead words</li></ul>`],
  ['table cell with ps stamp', `<table><tr><td data-mdr-ps='{"align":"${EVIL}"}'>Lead words</td></tr></table>`],
  ['real formula next to a forged stamp', `Lead $x$ <span data-mdr-tex="${EVIL}">t</span> words`],
];

describe('hostile documents carrying the stamp names', () => {
  for (const [name, src] of CASES) {
    it(name, () => {
      const { w } = mount(src);
      const kept = Array.from(w.querySelectorAll('[data-mdr-tex], [data-mdr-ps]')).length;
      const html0 = w.innerHTML;
      stampAtoms(w);
      const kind = kindOf(w);
      const hints = { ...sourceStyleHints(src), stamped: true };
      let base: string | null = null;
      try { base = serializeBlock(w, kind, { ...hints, editing: true }); } catch (e) { if (!(e instanceof NoMarkersError)) throw e; }
      const reason = unsupportedReason(w, src);
      const refused = reason !== null || base === null || !baselineFaithful(w, kind, base);
      let md: string | null = null;
      if (!refused) {
        const tw = document.createTreeWalker(w, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); break; }
        md = serializeBlock(w, kind, { ...hints, editing: true });
      }
      clearStamps(w);
      const restored = w.innerHTML === html0;
      console.log(`RESULT ${name}: sanitizer kept ${kept} stamp attrs; refused=${refused} (${reason ?? (base === null ? 'no base' : 'fidelity?')}); write=${JSON.stringify(md)}; clearStamps restores=${restored}`);
      w.remove();
      if (md !== null) expect(md).not.toContain(EVIL);
      expect(base ?? '').not.toContain(EVIL);
    });
  }
});
