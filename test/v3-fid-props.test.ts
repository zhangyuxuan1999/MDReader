// @vitest-environment jsdom
// verify-fidelity (0.2.0 stage 2c) — property tests over the real pipeline (worker markdown-it → sanitizer →
// mount → browser-like DOM edits → serializeBlock → render again), with an oracle that differs from the
// previous verifier's: the U12 gate's own canonicalForm (structure, text, hrefs, alt, TeX, checkbox state)
// plus (a) the list cache equals the uncached path after EVERY edit of a sequence on the same live DOM (I4),
// (b) no internal marker character the DOM does not hold reaches the output (pickMarkers), (c) for a block
// that renders inside a document with reference definitions the re-render is done with those references.
// Env: MDR_V3_N (sequences per family, default 60), MDR_V3_SEED (default 11), MDR_V3_VERBOSE=1.
// The test FAILS when a counterexample is found; the failing cases are printed (family, source, edits, md).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful, canonicalForm } from '../src/preview/fidelity';

const N = Number(process.env.MDR_V3_N ?? 60);
const SEED = Number(process.env.MDR_V3_SEED ?? 11);
const VERBOSE = process.env.MDR_V3_VERBOSE === '1';
const ch = (n: number): string => String.fromCodePoint(n);
const NBSP = ch(0xa0);

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});
const render = (src: string, refs: References = {}): string => mdk.renderBlock(src, { references: { ...refs } }).html;
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
function refsOf(text: string): References {
  const env: { references: References } = { references: {} };
  mdk.md.parse(text, env);
  return env.references;
}
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];

/** Canonical form, and the hrefs as a second check (canonicalForm keeps them too; explicit for messages). */
const canon = (el: Node): string => {
  let s = canonicalForm(el).replace(new RegExp(NBSP, 'g'), ' ').replace(/ +/g, ' ').replace(/<(\/?)del>/g, '<$1s>');
  // accepted spellings (K5): a <br> at the edge of formatting moves outside it; a trailing <br> is the
  // browser's placeholder of an emptied line and renders nothing
  for (let k = 0; k < 4; k++) {
    s = s.replace(/<br\/>(<\/(?:strong|em|s|a)>)/g, '$1<br/>').replace(/(<(?:strong|em|s|a [^>]*)>)<br\/>/g, '<br/>$1').replace(/ <br\/>/g, '<br/>')
      .replace(/<a [^>]*><\/a>/g, '').replace(/ (<\/a>)/g, '$1 ')
      .replace(/ ?<br\/>(<\/(?:p|li|h\d|td|th)>|<ul|<ol|<p>|<p |<blockquote)/g, '$1').replace(/ (<\/(?:p|li|h\d|td|th)>)/g, '$1')
      // K16: an empty paragraph has no source form; K5 (cosmetic): the space after a task checkbox, formatting
      // that holds only whitespace (its edge whitespace moves outside)
      .replace(/<p><\/p>/g, '').replace(/(<input [^>]*\/>) ?/g, '$1 ').replace(/<(strong|em|s)>( ?)<\/\1>/g, '$2')
      .replace(/<(strong|em|s)> /g, ' <$1>').replace(/ <\/(strong|em|s)>/g, '</$1> ').replace(/ +/g, ' ').replace(/<strong><\/strong>|<em><\/em>|<s><\/s>/g, '');
  }
  return s;
};
const markerCount = (s: string): Map<number, number> => {
  const m = new Map<number, number>();
  for (const c of s) { const cp = c.codePointAt(0)!; if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xfdd0 && cp <= 0xfdef)) m.set(cp, (m.get(cp) ?? 0) + 1); }
  return m;
};

export interface Fail { family: string; src: string; edits: string[]; md: string; why: string; a?: string; b?: string; dom?: string }

/** One check of the live DOM `w` after edits. */
function judge(w: HTMLElement, kind: BlockKind, src: string, refs: References, family: string, edits: string[], fails: Fail[]): string | null {
  if (unsupportedReason(w, src) !== null) return null;
  // as a session: a block whose untouched baseline the U12 gate refuses is never edited
  if (edits.length === 0) { const h = { ...sourceStyleHints(src), editing: true }; if (!baselineFaithful(w, kind, serializeBlock(w, kind, h))) return null; }
  const hints = { ...sourceStyleHints(src), editing: true };
  const md = serializeBlock(w, kind, hints);
  if (md.trim() === '') return md;                 // the U9 deletion path
  const unc = serializeBlock(w, kind, { ...hints, uncached: true });
  if (md !== unc) { fails.push({ family, src, edits: [...edits], md, why: 'I4 cache != uncached', a: unc }); return md; }
  // markers: every PUA / noncharacter in the output is one the DOM holds, as often
  const inDom = markerCount(w.innerHTML + Array.from(w.querySelectorAll('*')).map((e) => Array.from(e.attributes).map((a) => a.value).join('')).join(''));
  const inMd = markerCount(md);
  for (const [cp, n] of inMd) if ((inDom.get(cp) ?? 0) < n) { fails.push({ family, src, edits: [...edits], md, why: `marker U+${cp.toString(16)} leaked (${n})` }); return md; }
  for (const [cp, n] of markerCount(w.textContent ?? '')) if ((inMd.get(cp) ?? 0) < n) { fails.push({ family, src, edits: [...edits], md, why: `document char U+${cp.toString(16)} lost (${inMd.get(cp) ?? 0}/${n})` }); return md; }
  const again = mount(render(md, refs));
  const a = canon(w), b = canon(again);
  if (a !== b) fails.push({ family, src, edits: [...edits], md, why: 'I3 render differs', a, b, dom: w.innerHTML });
  return md;
}

// ---------------------------------------------------------------- browser-like DOM edits
function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const p = (n as Text).parentElement;
    if (!p || p.closest('.md-math, .katex, pre, code, [data-mdr-ui]')) continue;
    // whitespace between block elements is not a place the caret can type into
    if (['UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'SECTION', 'DIV'].includes(p.tagName)) continue;
    if (/^[ \t\r\n]*$/.test((n as Text).data)) continue;
    out.push(n as Text);
  }
  return out;
}
const TYPED = ['*', '_', '`', '$', '[', ']', '~', '<', '>', '&', '#', '|', '\\', '!', '(', ')', '"', '1.', '1)', '-', '+', '=', '---', '===', '```', '~~~',
  '$$', '**', '__', '~~', '&amp;', '&nbsp;', '<b>', '</b>', '<!--', '[x]', '[ ]', '\\*', '- - -', '* * *', '_ _ _', '中', 'a', '9', ':', '^', '{', '}', '%',
  '# ', ' #', '> ', '- ', '+ ', '2. ', '\t', '|-|', ':-:', '[a]', '![x]', '[a](b)', '<x@y>', '&#42;', ch(0xe000), ch(0xe001), ch(0xe002), ch(0xe003), ch(0xfdd0), ch(0xf8ff)];
function edit(r: () => number, w: HTMLElement): string | null {
  const ts = textNodes(w);
  const k = r();
  if (ts.length > 0 && k < 0.55) {
    const t = pick(r, ts);
    const at = Math.floor(r() * (t.data.length + 1));
    let ins = pick(r, TYPED);
    // Chromium: a typed space at a text edge or next to a space is NBSP
    if (ins === ' ') ins = NBSP;
    t.data = t.data.slice(0, at) + ins + t.data.slice(at);
    return `type ${JSON.stringify(ins)} at ${at} of ${JSON.stringify(t.data.slice(0, 30))}`;
  }
  if (ts.length > 0 && k < 0.7) {
    const t = pick(r, ts);
    if (t.data.length === 0) return null;
    const at = Math.floor(r() * t.data.length);
    const n = 1 + Math.floor(r() * Math.min(4, t.data.length - at));
    const gone = t.data.slice(at, at + n);
    t.data = t.data.slice(0, at) + t.data.slice(at + n);
    // Chromium removes an inline element the deletion left empty
    for (let e = t.parentElement; e && t.data === '' && ['STRONG', 'EM', 'DEL', 'S', 'A'].includes(e.tagName) && (e.textContent ?? '') === ''; e = e.parentElement) { const up = e.parentElement; e.remove(); if (!up) break; }
    return `delete ${JSON.stringify(gone)}`;
  }
  if (ts.length > 0 && k < 0.82) {
    // Shift+Enter: a <br> at a random point (also at element edges)
    const t = pick(r, ts);
    const at = Math.floor(r() * (t.data.length + 1));
    const rest = t.splitText(at);
    t.parentNode!.insertBefore(w.ownerDocument.createElement('br'), rest);
    return `br at ${at} in <${t.parentElement!.tagName.toLowerCase()}>`;
  }
  if (k < 0.9) {
    // empty an inline element or a list item (the browser leaves a <br> placeholder in an emptied line)
    const cands = Array.from(w.querySelectorAll('li, strong, em, del, a, p, td, h1, h2, h3'));
    if (cands.length === 0) return null;
    const e = pick(r, cands);
    if (e.tagName === 'LI') {
      const nested = Array.from(e.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
      const box = e.querySelector(':scope > input');
      e.replaceChildren(...(box ? [box, w.ownerDocument.createTextNode(' ')] : []), w.ownerDocument.createElement('br'), ...nested);
      return `empty li${box ? ' (task)' : ''}${nested.length ? ' (over nested)' : ''}`;
    }
    if (['P', 'TD', 'H1', 'H2', 'H3'].includes(e.tagName)) { e.replaceChildren(w.ownerDocument.createElement('br')); return `empty ${e.tagName}`; }
    e.remove();
    return `remove <${e.tagName.toLowerCase()}>`;
  }
  // wrap a slice of a text node in formatting (⌘B / ⌘I)
  if (ts.length === 0) return null;
  const t = pick(r, ts);
  if (t.data.length < 2) return null;
  const a = Math.floor(r() * (t.data.length - 1));
  const b = a + 1 + Math.floor(r() * (t.data.length - a - 1));
  if (/^\s*$/.test(t.data.slice(a, b))) return null;      // (formatting that holds only whitespace: see the verifier's notCovered)
  const mid = t.splitText(a);
  mid.splitText(b - a);
  const tag = pick(r, ['strong', 'em', 'del']);
  // ⌘B / ⌘I inside the same formatting toggles it off in Chromium: never nest the same kind
  if (t.parentElement?.closest(tag === 'del' ? 'del, s' : tag === 'strong' ? 'strong, b' : 'em, i')) return null;
  const e = w.ownerDocument.createElement(tag);
  mid.replaceWith(e);
  e.appendChild(mid);
  return `wrap ${JSON.stringify(mid.data)} in <${tag}>`;
}

// ---------------------------------------------------------------- corpus
const LONG_LIST = Array.from({ length: 10 }, (_, i) => `- item ${i} **b${i}** and [l${i}](https://e.example/${i})`).join('\n');
const LONG_TASK = Array.from({ length: 9 }, (_, i) => `- [${i % 2 ? 'x' : ' '}] task ${i} \`c${i}\``).join('\n');
const LONG_OL = Array.from({ length: 9 }, (_, i) => `${i + 3}. 第${i}项 *em* $x_${i}$`).join('\n');
const LONG_NESTED = Array.from({ length: 8 }, (_, i) => `- top ${i}\n  - sub ${i}a\n  - sub ${i}b`).join('\n');
const LONG_LOOSE = Array.from({ length: 8 }, (_, i) => `- loose ${i}\n\n  para ${i}`).join('\n\n');
const LONG_PUA = Array.from({ length: 9 }, (_, i) => `- pua ${i} ${i % 3 === 0 ? ch(0xe000 + i) : ''} x`).join('\n');
const BASES = [
  'plain text with **bold**, *em*, ~~del~~, `code` and [link](https://e.example/a "t").',
  '中文段落，**加粗**与*斜体*，以及 $a+b$ 公式和 <https://e.example/x> 链接。',
  'line one\nline two  \nline three\\\nline four',
  '# Heading with *em* and `code`',
  '## 标题 **粗** #',
  '- a\n- b\n- c',
  '1. one\n2. two\n3. three',
  '- [ ] todo\n- [x] done',
  '> quote *em*\n> second line',
  '> - in quote\n> - list',
  '| a | b |\n|:--|--:|\n| *x* | `y` |\n| $z$ | [l](https://e.example) |',
  'see https://e.example/path?q=1 and mail a@b.example now',
  'text ![img](https://e.example/i.png "title") after',
  '***bold em*** and **a**~~b~~ and *a*~~b~~',
  'a _b_ c __d__ e',
  '- outer\n  - inner *x*\n  - inner2\n- outer2',
  'para with &amp; &lt; &copy; entities and &nbsp;spaces',
  `pua ${ch(0xe000)} ${ch(0xe001)} ${ch(0xe002)} ${ch(0xe003)} chars`,
  `| pua | ${ch(0xe002)} |\n|---|---|\n| ${ch(0xe000)} | b |`,
  LONG_LIST, LONG_TASK, LONG_OL, LONG_NESTED, LONG_LOOSE, LONG_PUA,
];

function runFamily(family: string, seed: number, sources: string[], steps: number, refsDoc = ''): Fail[] {
  const r = rng(seed);
  const fails: Fail[] = [];
  for (let n = 0; n < N; n++) {
    const src = pick(r, sources);
    const refs = refsDoc ? refsOf(refsDoc) : {};
    const w = mount(render(src, refs));
    const kind = kindOf(src);
    const edits: string[] = [];
    const before = fails.length;
    if (judge(w, kind, src, refs, family, edits, fails) === null) continue;   // untouched block (the gate's baseline)
    for (let k = 0; k < steps && fails.length === before; k++) {
      const e = edit(r, w);
      if (e === null) continue;
      edits.push(e);
      judge(w, kind, src, refs, family, edits, fails);
    }
  }
  return fails;
}
function report(fails: Fail[]): void {
  const seen = new Set<string>();
  for (const f of fails) {
    const key = f.why + '|' + f.edits[f.edits.length - 1]?.split(' ')[0];
    if (!VERBOSE && seen.has(key)) continue;
    seen.add(key);
    console.log(`[${f.family}] ${f.why}\n  src   ${JSON.stringify(f.src)}\n  edits ${JSON.stringify(f.edits)}\n  md    ${JSON.stringify(f.md)}${f.a !== undefined ? `\n  shown ${f.a}\n  again ${f.b}` : ''}${f.dom ? `\n  dom   ${JSON.stringify(f.dom)}` : ''}`);
  }
}

describe('v3-fid property families', () => {
  it('sequences of browser-like edits on the corpus (I3, I4, markers)', () => {
    const fails = runFamily('edits', SEED, BASES, 6);
    report(fails);
    expect(fails.length).toBe(0);
  }, 110_000);

  it('the same blocks inside a document with reference definitions for every bracket word', () => {
    const defs = '[a]: https://ref.example/a\n[b]: https://ref.example/b\n[x]: https://ref.example/x\n[ ]: https://ref.example/sp\n[l]: https://ref.example/l\n[y]: https://ref.example/y\n';
    const fails = runFamily('refs', SEED + 1, BASES, 6, defs);
    report(fails);
    expect(fails.length).toBe(0);
  }, 110_000);

  it('the U12 gate never passes a baseline that renders differently in its document (references)', () => {
    const defs = '[foo]: https://ref.example/foo\n[bar]: https://ref.example/bar\n[x]: https://ref.example/x\n[ẞ]: https://ref.example/ss\n[^1]: https://ref.example/fn\n';
    const refs = refsOf(defs);
    const cases = [
      '\\[foo] text', '[foo\\] text', '&#91;foo&#93; text', '\\[foo\\]', 'a \\[x] b', '[\\[foo\\]](https://e.example)', '*\\[foo]* x',
      '- \\[x] not a task', '- [ ] \\[foo]', '| \\[foo] | b |\n|---|---|\n| c | d |', '# \\[foo] heading', '> \\[foo]', '\\[^1] note',
      '\\[SS] fold', '[foo][] and \\[bar]', '\\[foo][bar]', '!\\[foo]', '\\![foo]', '[a]\\[foo]', '`[foo]` and \\[foo]', '[foo]: not\\ def',
      '\\[foo]: https://x.example', 'x\n\\[foo]: https://x.example', '[foo]\n\\[bar]', '\\[\nfoo]', '\\[foo\n]',
    ];
    const bad: string[] = [];
    for (const src of cases) {
      const w = mount(render(src, refs));
      const kind = kindOf(src);
      if (unsupportedReason(w, src) !== null) continue;
      const base = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
      const gate = baselineFaithful(w, kind, base);
      const inDoc = canon(mount(render(base, refs)));
      if (gate && inDoc !== canon(w)) bad.push(`${JSON.stringify(src)} → ${JSON.stringify(base)}: shown ${canon(w)} / in doc ${inDoc}`);
    }
    for (const b of bad) console.log('FALSE PASS ' + b);
    expect(bad).toEqual([]);
  }, 60_000);
});
