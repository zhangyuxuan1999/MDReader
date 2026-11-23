// @vitest-environment jsdom
// test/r3-t-reserved-diff.test.ts — fix-trust (stage 2d, round 3): differential test of U15 (CONTRACT §11, H1).
//
// Claim: whenever an element of a block's sanitized DOM carries a reserved attribute (data-l, data-lang, data-md…)
// or a reserved class token (md-…, mdr-…) that the DOCUMENT supplied, the worker flagged that block
// (HTML_FLAG_RESERVED → data-mdr-x on the wrapper).
//
// How a document-supplied name is told from the worker's own: every case is generated twice from one template,
// once with the reserved name ("data-l", "md-math", …) and once with a NEUTRAL twin that differs in exactly one
// letter ("data-q", "qd-math", …), that letter spelled the same way in both (plain, upper case, a decimal or
// hexadecimal reference with or without `;`, leading zeros). Letters are letters to markdown-it, to the segmenter
// and to the HTML parser, so both documents tokenize, segment, parse and sanitize alike, and the worker emits its
// own names (data-l on its line tokens, md-code, md-math, …) identically in both. A reserved name present in the
// reserved variant's DOM but absent at the same place (element path + attribute value / class token) in the
// neutral variant's DOM therefore came from the document. Each document is cut into blocks by the real segmenter;
// each block is rendered by the worker's markdown-it instance (math on) and mounted alone, the way
// createPreview.mountItem mounts it (sanitizeToFragment, wrapCodeFences): a half-tag at the end of one block cannot
// reach into the next one.
//
// The generator (seeded; bench/verify/r3-t-gen.mjs, shared with the Chromium run bench/verify/r3-t-chromium.mjs) builds raw HTML from the tricks of REV-1 / REV-2 and their neighbours: RAWTEXT / RCDATA /
// PLAINTEXT elements, comments of every ending, bogus comments, CDATA, foreign content (svg, math), template,
// noscript, end tags with attributes, named and numeric references as class separators, case, NUL and other
// controls inside names, form feed and slash as separators, missing whitespace, duplicate attributes, unquoted
// values, tags cut by a blank line inside a glued container, document text and worker markup read into a tag that
// a raw-HTML token left open, and names that only reach the DOM through Markdown (fence info, link title, image alt,
// heading, code span, autolink, footnote-like labels, entities in text, math). The same corpus was run through the
// round-2 scan (a snapshot taken before round 3) to show that the generator does reach the bypass class.
// fix-pre (round 7, CONTRACT §11 Checkpoint I): that snapshot was deleted at the release of 0.2.0; `old` is now the frozen
// copy of the released 0.2.0 (test/fixtures/src-0.2.0), which has round 3's repair, so the two expectations about what
// the round-2 scan missed (18 of the REV cases, some of the generated ones) are now what 0.2.0 does: it misses none.
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';

import { generate, rng, viaMarkdown } from '../bench/verify/r3-t-gen.mjs';

type Pair = [string, string];

let mdk: Markdown;
/** The released 0.2.0 worker (test/fixtures/src-0.2.0; was the round-2 one), for the "the old scan missed these" counts. */
let old: Markdown | null = null;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
  try {
    const [m, k] = await Promise.all([import('./fixtures/src-0.2.0/worker/md'), import('./fixtures/src-0.2.0/worker/math')]);
    if (await k.loadMath()) { old = m.createMarkdown(DEFAULT_RENDER_OPTIONS) as unknown as Markdown; old.enableMath(); }
  } catch { old = null; }
});

// ------------------------------------------------------------------ rendering and signatures
const RES_ATTR = /^data-(?:l|lang|md.*)$/s;   // the names the app reads (U10 a)
const RES_CLASS = /^mdr?-/i;

/** Reserved names in a mounted block: `path@name=value` and `path.token`, path = child indices and tag names. */
function signature(w: Element): string[] {
  const out: string[] = [];
  const walk = (e: Element, path: string): void => {
    let i = 0;
    for (const c of Array.from(e.children)) {
      const p = `${path}/${i++}${c.localName}`;
      for (const a of Array.from(c.attributes)) {
        const n = a.name.toLowerCase();
        // data-l with its value (the worker's are line numbers, so a document's that replaced one shows); data-lang by
        // name only: its value is the fence's info string, the document's text by design (and escaped by the worker).
        if (RES_ATTR.test(n)) out.push(n === 'data-lang' ? `${p}@${n}` : `${p}@${n}=${a.value}`);
      }
      for (const t of Array.from(c.classList)) if (RES_CLASS.test(t)) out.push(`${p}.${t}`);
      walk(c, p);
    }
  };
  walk(w, '');
  return out;
}

interface BlockOut { src: string; flagged: boolean; oldFlagged: boolean; sig: string[] }

function mountBlocks(doc: string, withOld: boolean): BlockOut[] {
  const lines = doc.replace(/\r\n?/g, '\n').split('\n');   // as createDoc normalises line ends
  return segmentAll(lines).map((s) => {
    const src = lines.slice(s.start, s.start + s.count).join('\n');
    const r = mdk.renderBlock(src, { references: {} });
    const w = document.createElement('section');
    w.className = 'md-block';
    w.replaceChildren(sanitizeToFragment(r.html));
    wrapCodeFences(w);
    const oldFlagged = withOld && old ? (old.renderBlock(src, { references: {} }).flags & HTML_FLAG_RESERVED) !== 0 : false;
    return { src, flagged: (r.flags & HTML_FLAG_RESERVED) !== 0, oldFlagged, sig: signature(w) };
  });
}

/** Reserved names of `a` that `b` does not have at the same place (multiset difference). */
function extra(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const s of b) left.set(s, (left.get(s) ?? 0) + 1);
  const out: string[] = [];
  for (const s of a) {
    const n = left.get(s) ?? 0;
    if (n > 0) left.set(s, n - 1);
    else out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ the tests
describe('U15 differential: a document-supplied reserved name in the block DOM means the block is flagged', () => {
  it('every case of REV-1 and REV-2 (docs/FINDINGS-0.2.0-r2.md H1) is flagged', () => {
    const cases = [
      '<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I agree</li></ul>-->',
      'Read <style><!--</style><span class="md-math"><code>x</code></span>--> this',
      'Read <xmp><!--</xmp><span class="md-math"><code>x</code></span>--> this',
      'a <title><!--</title><b data-l="9">x</b>--> b',
      '<textarea><!--</textarea><b data-l="9">x</b>-->',
      'a <noembed><!--</noembed><span class="md-block" data-id="1">x</span>--> b',
      'a <noframes><!--</noframes><b data-lang="x">y</b>--> b',
      'a <iframe><!--</iframe><b data-l="9">x</b>--> b',
      'a <script><!--</script><b data-l="9">x</b>--> b',
      'Read <style><![CDATA[</style x="a><b title="><span class="md-math"><code>X</code></span>"]]> this',
      'Read <span class="&Tab;md-math"><code>x</code></span> this',
      'a <span class="x&NewLine;md-block" data-id="1">y</span> b',
      '<section class="&Tab;md-block" data-id="1">\n<p>x</p>\n</section>',
      'a <b class="&Tab;mdr-thing">y</b> b',
      '<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I have read the terms</li></ul>-->',
      '<section class="&Tab;md-block" data-id="1">\n\n- [ ] I have read the terms\n\n</section>',
      'Please read <style><![CDATA[</style x="a><b title="><span class="md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>"]]> the terms',
      'Please read <span class="&Tab;md-math" style="display:none"><code>\\text{Call +1 555 0100 now}</code></span>the terms',
    ];
    const missed: string[] = [];
    let oldMissed = 0;
    for (const c of cases) {
      const blocks = mountBlocks(c, true);
      for (const b of blocks) {
        if (!b.flagged) missed.push(b.src);
        if (!b.oldFlagged) oldMissed++;
      }
    }
    expect(missed).toEqual([]);
    // (written against the round-2 scan, for which every one of them was a bypass: 18; the released 0.2.0 flags them all)
    if (old) expect(oldMissed).toBe(0);
  });

  it('the absorbed-tag shapes: document text read into a tag a raw-HTML token left open is flagged', () => {
    const docs: Pair[] = [
      ["<div>\n<b title='\n\n' data-l=7 x='a' <input type=\"checkbox\">\n\n</div>", "<div>\n<b title='\n\n' data-q=7 x='a' <input type=\"checkbox\">\n\n</div>"],
      ["<pre title='</pre>\n' class=md-math x='a'", "<pre title='</pre>\n' class=qd-math x='a'"],
      ["<p>\n<span title='\n\n' class=md-math x='a'\n\n'\n\n</p>", "<p>\n<span title='\n\n' class=qd-math x='a'\n\n'\n\n</p>"],
    ];
    for (const [a, b] of docs) {
      const ra = mountBlocks(a, true), rb = mountBlocks(b, false);
      expect(ra.length).toBe(rb.length);
      let planted = 0;
      ra.forEach((blk, i) => {
        const x = extra(blk.sig, rb[i].sig);
        if (x.length) { planted++; expect(blk.flagged, `${blk.src} → ${x.join(' ')}`).toBe(true); }
      });
      expect(planted, a).toBeGreaterThan(0);   // the browser really builds the forged name from the paragraph's text
    }
  });

  it('names that reach the DOM only through Markdown never are the document\'s', () => {
    const r = rng(0x5eed1);
    let n = 0;
    for (let i = 0; i < 600; i++) {
      const [a, b] = viaMarkdown(r);
      const ra = mountBlocks(a, false), rb = mountBlocks(b, false);
      expect(ra.length).toBe(rb.length);
      ra.forEach((blk, j) => { expect(extra(blk.sig, rb[j].sig), a).toEqual([]); n++; });
    }
    expect(n).toBeGreaterThan(600);
  });

  // R3T_DIFF_N / R3T_DIFF_SEED run a longer or another corpus (the default is what the gate runs).
  const N = Number(process.env.R3T_DIFF_N ?? 4000);
  it(`seeded generator: ${N} documents, no false negative (and the round-2 scan had some)`, () => {
    const r = rng(Number(process.env.R3T_DIFF_SEED ?? 0x13a7c0de));
    let blocks = 0, planted = 0, flagged = 0, fp = 0, oldMissed = 0, mismatch = 0;
    const missed: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const [a, b] = generate(r);
      const ra = mountBlocks(a, true), rb = mountBlocks(b, false);
      if (ra.length !== rb.length) { mismatch++; continue; }
      ra.forEach((blk, j) => {
        blocks++;
        const x = extra(blk.sig, rb[j].sig);
        if (blk.flagged) flagged++;
        if (x.length) {
          planted++;
          if (!blk.flagged) missed.push(`${JSON.stringify(blk.src)} → ${x.join(' ')}`);
          if (!blk.oldFlagged) oldMissed++;
        } else if (blk.flagged) fp++;
      });
    }
    console.log(`r3-t diff: documents ${N}, blocks ${blocks}, with a document-supplied reserved name ${planted}, flagged ${flagged}`
      + ` (of them without one: ${fp}), missed ${missed.length}, missed by the round-2 scan ${oldMissed}, segment mismatches ${mismatch},`
      + ` ${Date.now() - t0} ms`);
    expect(missed.slice(0, 10)).toEqual([]);
    expect(mismatch).toBe(0);
    expect(planted).toBeGreaterThan(500);
    // (written against the round-2 scan, which missed some; the released 0.2.0 misses none, as the tree)
    if (old) expect(oldMissed).toBe(0);
  }, 100_000);
});
