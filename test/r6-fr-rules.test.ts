// @vitest-environment jsdom
// test/r6-fr-rules.test.ts — fix-refs (0.2.0 stage 2g, fix round 6): rule S of CONTRACT §11 "Round-5 verification
// decisions" as a table, along the session's own path (the worker's rendering, wrapCodeFences, the marks and stamps begin()
// sets, sourceStyleHints, the gate, then one character typed elsewhere in the block, serializeBlock editing: true).
// (a) a character of every general category rawInUrl rejects, the blank list and the named references people write, in
//     every spelling (named, decimal, hex with x / X and lower / upper digits), in every context: the source afterwards is
//     byte-identical outside the typed character (a setext heading is written ATX: an accepted normalisation).
// (b) the same character raw and as a reference in one block (both written as the reference); a reference in inline code
//     and in a code block (not decoded: unchanged); an escaped reference that shows its characters (unchanged).
// Characters are built from code points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-fr-rules.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason, type SerializeHints } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import { writeReveals } from '../src/preview/inlineEdit';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

const ch = (cp: number): string => String.fromCodePoint(cp);
const hex = (cp: number): string => cp.toString(16);
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));

function kindOf(w: Element): BlockKind {
  const top = w.firstElementChild;
  if (!top) return BlockKind.Prose;
  if (top.tagName === 'UL' || top.tagName === 'OL') return BlockKind.List;
  if (/^H[1-6]$/.test(top.tagName)) return BlockKind.Heading;
  if (top.tagName === 'TABLE') return BlockKind.Table;
  if (top.tagName === 'BLOCKQUOTE') return BlockKind.Quote;
  if (top.tagName === 'PRE' || top.classList.contains('md-codewrap')) return BlockKind.Code;
  return BlockKind.Prose;
}

interface Outcome { accepted: boolean; why: string; base: string | null; out: string | null }
/** A session on `src` (as begin() prepares it) that types `typed` right after the last `after` of the block's text. */
function session(src: string, typed = 'X', after = 'words', extra: SerializeHints = {}): Outcome {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = kindOf(w);
  const no = (why: string): Outcome => ({ accepted: false, why, base: null, out: null });
  if (unsupportedReason(w, src) !== null) return no('unsupported:' + unsupportedReason(w, src));
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  stampAtoms(w);
  const hints: SerializeHints = { ...sourceStyleHints(src), stamped: true, editing: true, ...extra };
  let base: string;
  try { base = serializeBlock(w, kind, hints); } catch { return no('markers'); }
  if (!baselineFaithful(w, kind, base)) return no('gate');
  // begin(): S4 (the baseline written without rule S passes the gate too) and the guard at the start
  if (hints.hidden && !baselineFaithful(w, kind, serializeBlock(w, kind, { ...hints, hidden: undefined }))) return no('S4');
  if (writeReveals(src, base) !== null) return no('guard-start');
  const tw = document.createTreeWalker(w, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(after)) last = n as Text;
  if (!last) return no('no-text');
  const at = last.data.lastIndexOf(after) + after.length;
  last.data = last.data.slice(0, at) + typed + last.data.slice(at);
  return { accepted: true, why: '', base, out: serializeBlock(w, kind, hints) };
}
const typedIn = (src: string, typed = 'X', after = 'words'): string => { const i = src.lastIndexOf(after) + after.length; return src.slice(0, i) + typed + src.slice(i); };

// ---------------------------------------------------------------- the characters
const NAMED: Array<[string, number]> = [['shy', 0xad], ['zwnj', 0x200c], ['zwj', 0x200d], ['lrm', 0x200e], ['rlm', 0x200f], ['emsp', 0x2003], ['ensp', 0x2002], ['thinsp', 0x2009], ['hairsp', 0x200a], ['NoBreak', 0x2060]];
/** One code point of every general category rawInUrl rejects (but Cs: no reference names one) and the blank list. */
const CATEGORY: Array<[string, number]> = [
  ['Mn', 0x301], ['Mc', 0x903], ['Me', 0x20dd], ['Zs', 0x3000], ['Zl', 0x2028], ['Zp', 0x2029], ['Cc', 0xc], ['Cf', 0x202e],
  ['Cf-tag', 0xe0041], ['Co', 0xe000], ['Cn', 0x378],
  ['blank-115F', 0x115f], ['blank-1160', 0x1160], ['blank-3164', 0x3164], ['blank-FFA0', 0xffa0], ['blank-2800', 0x2800], ['blank-FFFC', 0xfffc],
];
const CHARS: Array<[string, number, string | null]> = [
  ...NAMED.map(([n, cp]) => [n, cp, n] as [string, number, string]),
  ...CATEGORY.map(([n, cp]) => [n, cp, null] as [string, number, null]),
];
function spellings(cp: number, name: string | null): string[] {
  const out = [`&#${cp};`, `&#x${hex(cp)};`, `&#X${hex(cp).toUpperCase()};`];
  if (name) out.unshift(`&${name};`);
  return out;
}

// ---------------------------------------------------------------- the contexts: [name, source, expected | null (= source + X)]
type Ctx = [string, (e: string) => string, ((e: string) => string) | null];
const CONTEXTS: Ctx[] = [
  ['paragraph', (e) => `Lead a${e}b words`, null],
  ['emphasis', (e) => `Lead *a${e}b* words`, null],
  ['link text', (e) => `Lead [a${e}b](https://e.example/p) words`, null],
  ['atx heading', (e) => `# Lead a${e}b words`, null],
  ['setext heading', (e) => `Lead a${e}b words\n===`, (e) => `# Lead a${e}b wordsX`],
  ['table cell', (e) => `| h | k |\n| --- | --- |\n| a${e}b | words |`, null],
  ['tight item', (e) => `- Lead a${e}b words\n- two`, null],
  ['loose item', (e) => `- Lead a${e}b words\n\n- two`, null],
  ['task item', (e) => `- [ ] Lead a${e}b words\n- [x] two`, null],
  ['quote', (e) => `> Lead a${e}b words`, null],
  ['image alt', (e) => `Lead ![a${e}b](i.png) words`, null],
  ['link title', (e) => `Lead [t](https://e.example/p "a${e}b") words`, null],
  ['image title', (e) => `Lead ![i](i.png "a${e}b") words`, null],
  ['raw html attribute', (e) => `Lead <span title="a${e}b">t</span> words`, null],
];

describe('rule S (a): a hidden character keeps its spelling in every context', () => {
  const tally: Record<string, number> = {};
  for (const [ctxName, mk, exp] of CONTEXTS) {
    for (const [name, cp, named] of CHARS) {
      it(`${ctxName} / ${name}`, () => {
        for (const e of spellings(cp, named)) {
          const src = mk(e);
          const r = session(src);
          const key = r.accepted ? 'accepted' : 'refused:' + r.why;
          tally[key] = (tally[key] ?? 0) + 1;
          const want = exp ? exp(e) : typedIn(src);
          const line = `${ctxName} / ${name} / ${e}: ${key} base=${show(r.base)} out=${show(r.out)} want=${show(want)}`;
          if (!r.accepted) {
            // refused: only where the gate refused before rule S as well (S4) — a CR / LS / PS the text cannot hold
            expect(['S4', 'gate'], line).toContain(r.why);
            continue;
          }
          expect(r.out, line).toBe(want);
          expect(writeReveals(src, r.out!), line).toBe(null);
        }
      });
    }
  }
  it('tally', () => { console.log('R6-FR S(a) tally ' + JSON.stringify(tally)); });
  it('U+000D: the HTML parser shows a CR of Markdown text or a title as a line feed (not HIDDEN); in a raw HTML attribute it stays a CR, written in the source spelling', () => {
    // text: the reference becomes a soft line break (rendering-neutral, as before round 6), never a raw CR
    const t = session('Lead a&#13;b words');
    expect(t.out).toBe('Lead a\nb wordsX');
    expect(writeReveals('Lead a&#13;b words', t.out!)).toBe(null);
    for (const e of ['&#13;', '&#xd;', '&#XD;']) expect(session(`Lead <span title="a${e}b">t</span> words`).out).toBe(`Lead <span title="a${e}b">t</span> wordsX`);
  });
});

describe('rule S (b): raw and reference together, code, escaped references', () => {
  const zwnj = ch(0x200c), shy = ch(0xad);
  it('the same character raw and as a reference: both written as the reference', () => {
    const r = session(`Lead a${zwnj}b and c&zwnj;d words`);
    expect(r.accepted).toBe(true);
    expect(r.out).toBe('Lead a&zwnj;b and c&zwnj;d wordsX');
    const r2 = session(`Lead a&#x200c;b and c${zwnj}d words`);
    expect(r2.out).toBe('Lead a&#x200c;b and c&#x200c;d wordsX');
    // the first spelling of the source is the one used
    const r3 = session('Lead a&#8204;b and c&zwnj;d words');
    expect(r3.out).toBe('Lead a&#8204;b and c&#8204;d wordsX');
  });
  it('a reference inside inline code is not decoded: unchanged; one outside it keeps its spelling', () => {
    expect(session('Lead `a&shy;b` words').out).toBe('Lead `a&shy;b` wordsX');
    expect(session('Lead `a&shy;b` and c&shy;d words').out).toBe('Lead `a&shy;b` and c&shy;d wordsX');
    // raw in the code, a reference in the text: the code keeps its raw character (code is not changed)
    expect(session(`Lead \`a${shy}b\` and c&shy;d words`).out).toBe(`Lead \`a${shy}b\` and c&shy;d wordsX`);
  });
  it('a reference inside a code block is not decoded: unchanged', () => {
    const src = '```\na&shy;b words\n```';
    const r = session(src, 'X', 'words', { fence: { open: '```', close: '```' } });
    expect(r.accepted).toBe(true);
    expect(r.out).toBe('```\na&shy;b wordsX\n```');
  });
  it('an escaped reference that shows its characters stays as it is', () => {
    expect(session('Lead \\&shy; words').out).toBe('Lead \\&shy; wordsX');
    expect(session('Lead \\&#x200c; words').out).toBe('Lead \\&#x200c; wordsX');
    // `&amp;shy;` shows the same five characters; the serializer's own spelling of a literal `&` before a name is `\&`
    const r = session('Lead &amp;shy; and a&shy;b words');
    expect(r.accepted).toBe(true);
    expect(r.out).toBe('Lead \\&shy; and a&shy;b wordsX');
  });
  it('a percent-escape of a bare URL the user edits: its text keeps an escape, its destination the percent-escape', () => {
    const r = session('See https://e.example/a%E2%80%AEb here words', 'Z', 'example/');
    expect(r.accepted).toBe(true);
    expect(r.out).toBe('See [https://e.example/Za&#x202E;b](https://e.example/a%E2%80%AEb) here words');
  });
  it('a typed character that is hidden is written as the reference too (the safe direction)', () => {
    expect(session('Lead a&zwnj;b words', zwnj).out).toBe('Lead a&zwnj;b words&zwnj;');
  });
  it('a backslash or an underscore next to a hidden character still reads back', () => {
    expect(session('Lead a\\\\&zwnj;b words').out).toBe('Lead a\\\\&zwnj;b wordsX');
    const r = session('Lead &#x3164;\\_a and a\\_&#x3164; words');
    expect(r.accepted).toBe(true);
    expect(r.out).toBe('Lead &#x3164;\\_a and a\\_&#x3164; wordsX');
  });
});
