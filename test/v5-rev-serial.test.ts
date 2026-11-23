// @vitest-environment jsdom
// test/v5-rev-serial.test.ts — verify-review (0.2.0 round 4 re-verification): variations of J19 to J22 (CONTRACT §11,
// "Smaller rules" of the stage-2d review decisions) that the fixer's test/r4-s-serial.test.ts does not take:
//   J19: other places a marker-range code point can reach the output (autolink, linkify, title, alt, a nested
//        link-in-image, every one of the first four marker candidates escaped in a destination).
//   J20: other characters' runs (the class: no step a click runs before a session is quadratic in a run).
//   J21: the whitespace after a digit…digit formula at the end of a heading, an item, before a hard break.
//   J22: a TeX that ends in other whitespace (NBSP as Chromium types a trailing space, U+3000 from an IME).
// Special characters are built with String.fromCharCode (no typed escapes, tooling hazard). Bounded: < 20 s.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, serializeBlock, serializeBlockWithCaret, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

const C = (n: number): string => String.fromCharCode(n);
const BS = C(92);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  document.body.appendChild(w);
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
const formulas = (w: Element): number => w.querySelectorAll('.md-math').length;
const hintsOf = (src: string) => ({ ...sourceStyleHints(src), editing: true });
function texts(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!(n as Text).parentElement?.closest('.katex, .md-math, .md-math-src')) out.push(n as Text);
  return out;
}
const pct = (c: number): string => encodeURIComponent(C(c));
// (regex classes built from code points: no literal invisible characters in this file)
const MARKER_RE = new RegExp('[' + C(0xe000) + '-' + C(0xf8ff) + C(0xfdd0) + '-' + C(0xfdef) + ']');
const INVISIBLE_RE = new RegExp('[' + [0x200b, 0xfeff, 0xa0, 0x202e, 0x3000].map(C).join('') + C(0xe000) + '-' + C(0xf8ff) + ']');

describe('J19 variations: the caret marker is never a code point the output holds', () => {
  const cases: [string, string][] = [
    ['autolink pct E001', '<https://e.example/?q=' + pct(0xe001) + '> first line'],
    ['linkify pct E001', 'https://e.example/?q=' + pct(0xe001) + ' first line'],
    ['title raw E001', '[x](https://e.example/ "t' + C(0xe001) + '") first line'],
    ['alt raw E001', '![a' + C(0xe001) + '](i.png) first line'],
    ['image in link, both pct', '[![i](a' + pct(0xe001) + '.png)](https://e.example/' + pct(0xe000) + ') first line'],
    ['first four candidates pct in dests', [0xe000, 0xe001, 0xe002, 0xe003, 0xe004].map((c) => '[x](https://e.example/' + pct(c) + ')').join(' ') + ' first line'],
    ['first four raw in text, more pct', C(0xe000) + C(0xe001) + C(0xe002) + C(0xe003) + ' [x](https://e.example/' + pct(0xe004) + pct(0xe005) + ') first line'],
    ['FDD0 pct in dest', '[x](https://e.example/' + pct(0xfdd0) + ') first line'],
    ['lower-case escape', '[x](https://e.example/?q=%ee%80%81) first line'],
  ];
  for (const [name, first] of cases) {
    it(`${name}: the caret stays on line 2 and nothing invisible is added`, () => {
      const src = first + '\nsecond line words';
      const w = mount(src);
      const t = texts(w).find((x) => x.data.includes('words'))!;
      const out = serializeBlockWithCaret(w, kindOf(src), t, t.data.indexOf('words'), hintsOf(src))!;
      const at = out.indexOf(CARET_MARK);
      expect(at, JSON.stringify(out)).toBeGreaterThan(0);
      expect(out.slice(0, at).split('\n').length - 1, JSON.stringify(out)).toBe(1);
      const md = serializeBlock(w, kindOf(src), hintsOf(src));
      // no marker-range code point that the source does not hold raw
      const raw = new Set(Array.from(src).filter((c) => MARKER_RE.test(c)));
      const added = Array.from(md).filter((c) => MARKER_RE.test(c) && !raw.has(c));
      expect(added.map((c) => c.charCodeAt(0).toString(16)), JSON.stringify(md)).toEqual([]);
      expect(baselineFaithful(w, kindOf(src), md), JSON.stringify(md)).toBe(true);
    });
  }
});

describe('J20 variations: runs of other characters stay linear (guard + serialize + gate)', () => {
  const time = (f: () => void): number => { const t0 = performance.now(); f(); return performance.now() - t0; };
  const run = (unit: string, n: number): string => 'x ' + unit.repeat(n) + ' y';
  // ('*a', '$a', '`$', '~~a', '![' build thousands of elements: jsdom's own DOM cost grows faster than linear there, so
  // they are timed in Chromium by bench/verify/v5-rev-h29.mjs, where they are linear: x3.3-4.7 for 4x the length)
  for (const unit of ['*', '_', '[', '<', '$', '&', '~', '|', '(', '!', '_a', '[a', '&a', '<a', '](', BS + '*']) {
    it(`run of ${JSON.stringify(unit)}: 4x the length costs less than 8x the time`, () => {
      const cost = (n: number): number => {
        const src = run(unit, n);
        const w = mount(src);
        const kind = kindOf(src);
        let md = '';
        const g = time(() => unsupportedReason(w, src));
        const s = time(() => { md = serializeBlock(w, kind, hintsOf(src)); });
        const f = time(() => baselineFaithful(w, kind, md));
        w.remove();
        return g + s + f;
      };
      const n = Math.floor(4000 / unit.length);
      cost(n);                                      // warm-up
      const a = cost(n), b = cost(4 * n);
      expect(b < 120 || b < 8 * Math.max(a, 5), `${JSON.stringify(unit)}: ${a.toFixed(1)} ms -> ${b.toFixed(1)} ms`).toBe(true);
    }, 20000);
  }
});

/** Opens the first inline formula of `src` as the session does (its TeX in a `code.md-math-src`), sets `tex`. */
function editTex(src: string, tex: string): { md: string; now: number } {
  const w = mount(src);
  const m = w.querySelector('.md-math')!;
  const e = document.createElement('code');
  e.className = 'md-math-src md-math--inline';
  e.textContent = tex;
  m.replaceWith(e);
  const md = serializeBlock(w, kindOf(src), hintsOf(src));
  return { md, now: formulas(mount(md)) };
}

describe('J22 variations: a TeX that ends in other whitespace stays a formula (or the source is unchanged)', () => {
  for (const [name, end] of [['NBSP', C(0xa0)], ['U+3000', C(0x3000)], ['em space', C(0x2003)], ['backslash + NBSP', BS + C(0xa0)], ['NBSP + space', C(0xa0) + ' ']] as const) {
    for (const src of ['Area $x+1$ here.', 'Area $x+1$', '- Area $x+1$ here']) {
      it(`${name} at the TeX end in ${JSON.stringify(src)}`, () => {
        const r = editTex(src, 'x+1' + end);
        expect(r.now === 1 || r.md === src, JSON.stringify(r.md)).toBe(true);
      });
    }
  }
});

/** The text node holding `needle` gets `by` instead; serialize; re-render. */
function after(src: string, needle: string, by: string): { md: string; now: number } {
  const w = mount(src);
  const t = texts(w).find((x) => x.data.includes(needle));
  if (!t) throw new Error(`no text ${needle}`);
  t.data = t.data.replace(needle, by);
  const md = serializeBlock(w, kindOf(src), hintsOf(src));
  return { md, now: formulas(mount(md)) };
}

describe('J21 variations: whitespace after a digit…digit formula at other line ends', () => {
  const WS = [['U+3000', C(0x3000)], ['em space', C(0x2003)], ['NBSP', C(0xa0)], ['thin space', C(0x2009)], ['U+3000 x2', C(0x3000) + C(0x3000)]] as const;
  const srcs: [string, string][] = [
    ['heading end', '## 等于 $10$。'],
    ['item end', '- 等于 $10$。\n- b'],
    ['quote end', '> 等于 $10$。'],
    ['before a soft break', '等于 $10$。\nnext'],
    ['task item end', '- [ ] 等于 $10$。'],
    ['inside bold at the end', '等于 **$10$。**'],
  ];
  for (const [wn, ws] of WS) for (const [sn, src] of srcs) {
    it(`${wn} replacing the full stop, ${sn}`, () => {
      const r = after(src, '。', ws);
      expect(r.now, JSON.stringify(r.md)).toBe(1);
    });
  }
});

describe('J19 class: an autolink / bare URL whose percent-escapes decode to characters the serializer drops or changes', () => {
  const hrefs = (w: Element): string[] => Array.from(w.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
  for (const esc of ['%E2%80%8B', '%EF%BB%BF', '%C2%A0', '%20', '%E2%80%AE', '%E3%80%80', '%EE%80%81']) {
    for (const [kind, line] of [['autolink', '<https://e.example/?q=a' + esc + 'b>'], ['linkify', 'https://e.example/?q=a' + esc + 'b']] as const) {
      it(`${kind} ${esc}: refused at the click, or written with the same href and no added invisible character`, () => {
        const src = 'See ' + line + ' here\nsecond line words';
        const w = mount(src);
        const kind0 = kindOf(src);
        const before = hrefs(w);
        const reason = unsupportedReason(w, src);
        const md0 = serializeBlock(w, kind0, hintsOf(src));
        const gate = baselineFaithful(w, kind0, md0);
        if (reason !== null || !gate) return;            // refused (K4): nothing can be written
        // the session edits another word of the block
        const t = texts(w).find((x) => x.data.includes('words'))!;
        t.data = t.data.replace('words', 'wordsX');
        const md = serializeBlock(w, kind0, hintsOf(src));
        const again = mount(md);
        expect(hrefs(again), JSON.stringify(md)).toEqual(before);
        const invisible = (s: string): number => Array.from(s).filter((c) => INVISIBLE_RE.test(c)).length;
        expect(invisible(md), JSON.stringify(md)).toBe(invisible(src));
      });
    }
  }
});
