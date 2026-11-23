// @vitest-environment jsdom
// test/r6-cr-holes.test.ts — challenge-refs (0.2.0 stage 2g, round 6): attacks on rule S (S1 HIDDEN, S2 writers) and on the
// guard at unit level, along the session's own path (the worker's rendering, wrapCodeFences, the marks and stamps begin()
// sets, sourceStyleHints, the gate, S4 and the guard at the start as begin() runs them, then an edit, serializeBlock
// editing: true), for the TREE's serializer and for the serializer before round 6 (a snapshot taken before round 6;
// since round 7, CONTRACT §11 Checkpoint I, the frozen copy of the released 0.2.0, test/fixtures/src-0.2.0) side by side.
// Every case prints one line "R6CR <case> tree=<verdict> pre=<verdict>" with the written source (invisible characters as
// <hex>); verdicts: same (source byte-identical apart from the edit), REVEAL (a reference or a percent-escape of a
// character that is not plainly visible is now raw although the user did not type it), refused:<why>, or diff (another
// byte change). The test fails on every REVEAL of the tree (the M1 class) and records the rest.
// Characters are built from code points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-cr-holes.test.ts   (R6CR_OUT=<file> writes the lines)
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import * as tree from '../src/preview/serialize';
import * as treeFid from '../src/preview/fidelity';
import { writeReveals } from '../src/preview/inlineEdit';
import * as pre from './fixtures/src-0.2.0/preview/serialize';
import * as preFid from './fixtures/src-0.2.0/preview/fidelity';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

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
type Impl = 'tree' | 'pre';
interface Out { ok: boolean; why: string; out: string | null }
type Refs = Record<string, { href: string; title?: string }>;
/** A session on `src`: types `typed` right after the last `after` in the block's text (or, with `del`, deletes the
 *  `del` characters right after it), then serializes. */
function session(impl: Impl, src: string, typed = 'X', after = 'words', refs: Refs = {}, del = 0, extra: tree.SerializeHints = {}): Out {
  const S = (impl === 'tree' ? tree : pre) as typeof tree;
  const F = impl === 'tree' ? treeFid : preFid;
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: refs as never }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = kindOf(w);
  const no = (why: string): Out => ({ ok: false, why, out: null });
  const u = S.unsupportedReason(w, src);
  if (u !== null) return no('unsupported:' + u);
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true, ...extra } as tree.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, kind, hints); } catch { return no('markers'); }
  if (!F.baselineFaithful(w, kind, base)) return no('gate');
  if (impl === 'tree') {
    if (hints.hidden && !F.baselineFaithful(w, kind, S.serializeBlock(w, kind, { ...hints, hidden: undefined }))) return no('S4');
    if (writeReveals(src, base) !== null) return no('guard-start');
  }
  const tw = document.createTreeWalker(w, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(after)) last = n as Text;
  if (!last) return no('no-text');
  const at = last.data.lastIndexOf(after) + after.length;
  last.data = last.data.slice(0, at) + typed + last.data.slice(at + del);
  const out = S.serializeBlock(w, kind, hints);
  if (impl === 'tree' && writeReveals(src, out, new Map(Array.from(typed, (c) => [c, 1]))) !== null) return { ok: false, why: 'guard-write', out };
  return { ok: true, why: '', out };
}
const NAMED_REFS: Record<string, number> = { shy: 0xad, zwj: 0x200d, zwnj: 0x200c, emsp: 0x2003, ensp: 0x2002, thinsp: 0x2009, lrm: 0x200e, rlm: 0x200f, NoBreak: 0x2060, nbsp: 0xa0 };
function decodeRef(r: string): string | null {
  const body = r.slice(1, -1);
  if (body[0] === '#') { const hx = body[1] === 'x' || body[1] === 'X'; const cp = parseInt(body.slice(hx ? 2 : 1), hx ? 16 : 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null; }
  return NAMED_REFS[body] !== undefined ? String.fromCodePoint(NAMED_REFS[body]) : null;
}
const NOT_PLAIN = (c: string): boolean => c !== ' ' && c !== '\n' && c !== '\t' && !tree.plainlyVisible(c);
function rawCount(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of s) if (NOT_PLAIN(c)) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}
/** The verdict of a written source against the expected one (`want`) and the source (`src`, `typed`). */
function verdict(r: Out, src: string, want: string, typed: string): string {
  if (!r.ok) return 'refused:' + r.why;
  if (r.out === want) return 'same';
  const a = rawCount(src), b = rawCount(r.out!);
  for (const c of typed) if (NOT_PLAIN(c)) a.set(c, (a.get(c) ?? 0) + 1);
  for (const [c, k] of b) if (k > (a.get(c) ?? 0)) return 'REVEAL';
  // a reference of a character that is not plainly visible lost while a raw one of it was written (a swap: the count of
  // raw ones stays equal because the session dropped a raw one the rendering did not show)
  const refs = (x: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of x.match(/&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g) ?? []) {
      const d = decodeRef(r);
      if (d && NOT_PLAIN(d)) m.set(d, (m.get(d) ?? 0) + 1);
    }
    return m;
  };
  const ra = refs(want), rb = refs(r.out!);
  for (const [c, k] of ra) if ((rb.get(c) ?? 0) < k && (b.get(c) ?? 0) > 0) return 'REVEAL-SWAP';
  // a revealed character that swapped places with a raw one the session dropped (the count stays equal)
  const shownRaw = (s: string): string => s.replace(/[\x20-\x7e\n]/g, '');
  const rawOut = [...shownRaw(r.out!)].filter(NOT_PLAIN).join(''), rawWant = [...shownRaw(want)].filter(NOT_PLAIN).join('');
  if (rawOut.length < rawWant.length) return 'raw-to-reference';   // (S2: an occurrence the source held raw becomes a reference)
  if (rawOut !== rawWant) return 'REVEAL?';
  return 'diff';
}
const typedIn = (src: string, typed: string, after: string, del = 0): string => { const i = src.lastIndexOf(after) + after.length; return src.slice(0, i) + typed + src.slice(i + del); };

const lines: string[] = [];
interface Case { name: string; src: string; typed?: string; after?: string; refs?: Refs; want?: string; del?: number; extra?: tree.SerializeHints }
function run(c: Case): { t: string; p: string; tOut: string | null } {
  const typed = c.typed ?? 'X', after = c.after ?? 'words', del = c.del ?? 0;
  const want = c.want ?? typedIn(c.src, typed, after, del);
  const rt = session('tree', c.src, typed, after, c.refs ?? {}, del, c.extra);
  const rp = session('pre', c.src, typed, after, c.refs ?? {}, del, c.extra);
  const t = verdict(rt, c.src, want, typed), p = verdict(rp, c.src, want, typed);
  lines.push(`R6CR ${c.name} tree=${t} pre=${p} src=${show(c.src)} treeOut=${show(rt.out)} preOut=${show(rp.out)}`);
  return { t, p, tOut: rt.out };
}

const ZWJ = C(0x200d), SHY = C(0xad), RLO = C(0x202e), NBSP = C(0xa0), ZWNJ = C(0x200c), WJ = C(0x2060);

// ---------------------------------------------------------------- H: a raw occurrence the rendering does not show
const HOLES: Case[] = [
  { name: 'H1 raw ZWJ in a link destination + &zwj; in text', src: `Lead y&zwj;z [x](https://e.example/a${ZWJ}b) words` },
  { name: 'H1b raw RLO in a link destination + &#x202E; in text', src: `Lead y&#x202E;z [x](https://e.example/a${RLO}b) words` },
  { name: 'H1c raw SHY in an image source + &shy; in text', src: `Lead y&shy;z ![i](i${SHY}.png) words` },
  { name: 'H1d raw WJ in a link destination + &NoBreak; in link text', src: `Lead [y&NoBreak;z](https://e.example/a${WJ}b) words` },
  { name: 'H1e raw ZWNJ in a destination + &zwnj; in an image alt', src: `Lead ![y&zwnj;z](i${ZWNJ}.png) words` },
  { name: 'H1f raw ZWJ in a destination + &zwj; in a link title', src: `Lead [x](https://e.example/a${ZWJ}b "y&zwj;z") words` },
  { name: 'H2 raw SHY in an HTML comment + &shy; in text', src: `Lead y&shy;z <!-- c${SHY}d --> words` },
  { name: 'H3 raw SHY in a stripped attribute + &shy; in text', src: `Lead <span onclick="c${SHY}d">s</span> y&shy;z words` },
  { name: 'H3b raw SHY in a stripped element + &shy; in text', src: `Lead <script>c${SHY}d</script> y&shy;z words` },
  { name: 'H4 raw RLO in an autolink destination (shown decoded) + &#x202E; in text', src: `Lead y&#x202E;z <https://e.example/a${RLO}b> words` },
  { name: 'H5 raw ZWJ in a bare URL + &zwj; in text', src: `Lead y&zwj;z https://e.example/a${ZWJ}b words` },
  { name: 'H6 reference link: the definition title holds &shy; (as the worker decodes it)', src: 'Lead [x][r] words', refs: { R: { href: 'https://e.example/r', title: `t${SHY}t` } } },
  { name: 'H6b reference link: the definition destination holds a ZWJ escape', src: 'Lead [x][r] words', refs: { R: { href: 'https://e.example/a%E2%80%8Db' } } },
  { name: 'H6c collapsed reference image: alt and definition title', src: 'Lead ![a&shy;b][r] words', refs: { R: { href: 'i.png', title: `t${SHY}t` } } },
  { name: 'H7 NBSP swap: raw NBSP in text + &nbsp; in an alt', src: `Lead x${NBSP}y ![a&nbsp;b](i.png) words` },
  { name: 'H7b NBSP: &nbsp; in a link title', src: 'Lead [t](https://e.example/p "a&nbsp;b") words' },
  { name: 'H8 two spellings of one character', src: 'Lead a&zwnj;b and c&#x200C;d words' },
  { name: 'H8b two spellings, decimal first', src: 'Lead a&#8205;b and c&zwj;d words' },
  { name: 'H8c leading zeros', src: 'Lead a&#x000200D;b words' },
  { name: 'H8d leading zeros decimal', src: 'Lead a&#0008205;b words' },
  { name: 'H9 reference without semicolon (literal)', src: 'Lead a&shyb words' },
  { name: 'H9b unknown name (literal)', src: 'Lead a&zzwj;b words' },
  { name: 'H9c legacy name without semicolon in raw HTML', src: 'Lead <span title="a&shyb">t</span> words' },
  { name: 'H9d decimal without semicolon in raw HTML', src: 'Lead <span title="a&#173b">t</span> words' },
  { name: 'H10 abbr title', src: 'Lead <abbr title="a&shy;b">t</abbr> words' },
  { name: 'H10b img alt in raw HTML', src: 'Lead <img src="i.png" alt="a&zwj;b"> words' },
  { name: 'H10c data attribute', src: 'Lead <span data-x="a&zwj;b">t</span> words' },
  { name: 'H10d text inside raw inline HTML', src: 'Lead <span>a&shy;b</span> words' },
  { name: 'H10e text inside raw <kbd>', src: 'Lead <kbd>a&zwnj;b</kbd> words' },
  { name: 'H11 heading with a raw SHY and a &zwnj;', src: `# Lead a${SHY}b c&zwnj;d words` },
  { name: 'H12 formula TeX with &shy; (not decoded)', src: 'Lead $a&shy;b$ words' },
  { name: 'H12b formula TeX with a raw ZWJ and text &zwj;', src: `Lead $a${ZWJ}b$ and y&zwj;z words` },
  { name: 'H13 combining mark as a reference', src: 'Lead e&#x301; words' },
  { name: 'H13b combining mark reference after a letter in emphasis', src: 'Lead *e&#769;* words' },
  { name: 'H14 tag characters', src: 'Lead a&#xE0041;&#xE007F;b words' },
  { name: 'H14b flag tag sequence', src: `Lead ${C(0x1f3f4)}&#xE0067;&#xE0062;&#xE007F; words` },
  { name: 'H15 bidi isolate', src: 'Lead a&#x2066;b&#x2069;c words' },
  { name: 'H16 strikethrough', src: 'Lead ~~a&shy;b~~ words' },
  { name: 'H16b strong', src: 'Lead **a&zwnj;b** words' },
  { name: 'H17 nested quote list', src: '> - Lead a&zwj;b words\n> - two' },
  { name: 'H18 escaped reference shows its characters', src: 'Lead \\&zwj; and a&zwj;b words' },
  { name: 'H18b backslash before the ampersand of &amp;', src: 'Lead \\&amp;zwj; words' },
  { name: 'H19 hidden char at paragraph start', src: '&zwnj;Lead words' },
  { name: 'H19b hidden char at paragraph end', src: 'Lead words&zwnj;', want: 'Lead wordsX&zwnj;' },
  { name: 'H19c emsp at paragraph start', src: '&emsp;Lead words' },
  { name: 'H19d hidden at item start', src: '- &shy;Lead words\n- two' },
  { name: 'H19e hidden at cell end', src: '| h |\n| --- |\n| words&zwj; |', want: '| h |\n| --- |\n| wordsX&zwj; |' },
  { name: 'H19f emsp at emphasis edge', src: 'Lead *&emsp;a* words' },
  { name: 'H20 www link with an escape', src: 'Lead www.e.example/a%E2%80%8Db words' },
  { name: 'H20b email autolink with an escape', src: 'Lead <a%E2%80%8Db@e.example> words' },
  { name: 'H21 reference in a fence info string', src: '```a&shy;b\nwords\n```' },
  { name: 'H21b reference in a fence info string, with the fence hint', src: '```a&shy;b\nwords\n```', extra: { fence: { open: '```', close: '```' } } as tree.SerializeHints },
  { name: 'H22 setext heading', src: 'Lead a&lrm;b words\n---', want: '## Lead a&lrm;b wordsX' },
  { name: 'H23 a hidden char that is ALSO raw inside inline code', src: `Lead \`c${ZWJ}d\` y&zwj;z words` },
  { name: 'H25 reference in a link destination (decoded, then percent-encoded)', src: 'Lead [x](https://e.example/a&shy;b) words' },
  { name: 'H25b reference in an image source', src: 'Lead ![i](i&zwj;.png) words' },
  { name: 'H25c reference in a link destination + the same in text', src: 'Lead [x](https://e.example/a&shy;b) y&shy;z words' },
  { name: 'H26 bare URL followed by a reference', src: 'Lead https://e.example/a&shy;b words' },
  { name: 'H27 astral hidden char at a segment edge before an escaped underscore', src: 'Lead a&#xE0041;**\\_x** words' },
  { name: 'H27b astral hidden char before a span starting with an escaped underscore', src: 'Lead a&#xE0041;<span>\\_x\\_</span> words' },
  { name: 'H27c astral hidden char after an element, before an underscore', src: 'Lead **b**&#xE0041;\\_x words' },
  { name: 'H27d BMP hidden char at a segment edge before an escaped underscore', src: 'Lead a&shy;**\\_x** words' },
  { name: 'H27e astral hidden char then a star', src: 'Lead a&#xE0041;*x* and y&#xE0041;\\*z words' },
  { name: 'H24 a reference of U+0009 (tab, not guarded)', src: 'Lead a&#9;b words' },
  { name: 'H24b a reference of U+000C (FF)', src: 'Lead a&#12;b words' },
  { name: 'H24c &#133; in raw HTML title (Windows-1252: U+2026)', src: 'Lead <span title="a&#133;b">t</span> words' },
  { name: 'H24d &#x9D; in raw HTML title (C1 control stays)', src: 'Lead <span title="a&#x9D;b">t</span> words' },
  { name: 'H24e &#x9D; in text (markdown-it: U+FFFD)', src: 'Lead a&#x9D;b words' },
];

describe('challenge-refs: holes of rule S', () => {
  for (const c of HOLES) {
    it(c.name, () => {
      const { t } = run(c);
      expect(t, lines[lines.length - 1]).not.toMatch(/^REVEAL/);
    });
  }
});



// ---------------------------------------------------------------- T: a raw occurrence the session drops (not shown)
const IDSP = C(0x3000), EMSP = C(0x2003);
const TRIMS: Case[] = [
  { name: 'T1 raw U+3000 at paragraph start (trimmed) + &#x3000; inside', src: `${IDSP}${IDSP}Lead y&#x3000;z words` },
  { name: 'T2 raw U+3000 at paragraph end (trimmed) + &#12288; inside', src: `Lead y&#12288;z words${IDSP}`, want: `Lead y&#12288;z wordsX${IDSP}` },
  { name: 'T3 heading: raw U+3000 at start + reference', src: `# ${IDSP}Head y&#x3000;z words` },
  { name: 'T4 table cell: raw U+3000 at cell start + reference', src: `| h |\n| --- |\n| ${IDSP}a y&#x3000;z words |` },
  { name: 'T5 list item: raw U+3000 at item start + reference', src: `- ${IDSP}a y&#x3000;z words\n- two` },
  { name: 'T6 raw EMSP at paragraph start + &emsp; inside', src: `${EMSP}Lead y&emsp;z words` },
  { name: 'T6b &emsp;&emsp; indent idiom + raw EMSP at paragraph end', src: `&emsp;&emsp;Lead words${EMSP}`, want: `&emsp;&emsp;Lead wordsX${EMSP}` },
  { name: 'T7 raw U+3000 indent only (no reference)', src: `${IDSP}${IDSP}Lead words` },
  { name: 'T8 quote: raw U+3000 at start + reference', src: `> ${IDSP}Lead y&#x3000;z words` },
  { name: 'T9 hard-break line end: raw U+3000 before a backslash break + reference', src: `Lead y&#x3000;z${IDSP}\\\nwords` },
  { name: 'T10 list item end: raw U+3000 + reference', src: `- a y&#x3000;z words${IDSP}\n- two`, want: `- a y&#x3000;z wordsX${IDSP}\n- two` },
  { name: 'T11 task item text start: raw U+3000 + reference', src: `- [ ] ${IDSP}a y&#x3000;z words\n- [x] two` },
  { name: 'T12 quote end: raw EMSP + reference', src: `> a y&emsp;z words${EMSP}`, want: `> a y&emsp;z wordsX${EMSP}` },
  { name: 'T13 cell end: raw LRM is not trimmed (not whitespace)', src: `| h |\n| --- |\n| ${C(0x200e)}a y&lrm;z words |` },
  { name: 'T14 two-line paragraph: raw U+3000 at the end of line 1 + reference', src: `Lead y&#x3000;z${IDSP}\nwords` },
];
describe('challenge-refs: dropped raw occurrences', () => {
  for (const c of TRIMS) {
    it(c.name, () => {
      run(c);   // (recorded; the verdicts go into the answer)
    });
  }
});

// ---------------------------------------------------------------- M2: U+FFFC escaped in every URL construct
const FFFC_ESC = '%EF%BF%BC';
const M2: Case[] = [
  { name: 'M2a reference link written inline: definition href holds the escape', src: 'Lead [x][r] words', refs: { R: { href: `https://e.example/a${FFFC_ESC}b` } } },
  { name: 'M2b reference image written inline', src: 'Lead ![i][r] words', refs: { R: { href: `https://e.example/a${FFFC_ESC}b.png` } } },
  { name: 'M2c link destination', src: `Lead [x](https://e.example/a${FFFC_ESC}b) words` },
  { name: 'M2d image source', src: `Lead ![i](https://e.example/a${FFFC_ESC}b.png) words` },
  { name: 'M2e raw <a href>', src: `Lead <a href="https://e.example/a${FFFC_ESC}b">t</a> words` },
  { name: 'M2f bare URL edited', src: `See https://e.example/a${FFFC_ESC}b here`, typed: 'Z', after: 'example/', want: 'See [https://e.example/Za&#xFFFC;b](https://e.example/a%EF%BF%BCb) here' },
  { name: 'M2g autolink edited', src: `See <https://e.example/a${FFFC_ESC}b> here`, typed: 'Z', after: 'example/', want: 'See [https://e.example/Za&#xFFFC;b](https://e.example/a%EF%BF%BCb) here' },
  { name: 'M2h autolink untouched, typed elsewhere', src: `See <https://e.example/a${FFFC_ESC}b> here words` },
  { name: 'M2i bare www link edited', src: `See www.e.example/a${FFFC_ESC}b here`, typed: 'Z', after: 'example/' },
  { name: 'M2j &#xFFFC; in text', src: 'Lead a&#xFFFC;b words' },
];
describe('challenge-refs: M2', () => {
  for (const c of M2) {
    it(c.name, () => {
      const { t, tOut } = run(c);
      expect(t, lines[lines.length - 1]).not.toMatch(/^REVEAL/);
      if (tOut) expect(tOut.includes(String.fromCodePoint(0xfffc)), lines[lines.length - 1]).toBe(false);
    });
  }
});

// ---------------------------------------------------------------- E: edits around a hidden character
const EDITS: Case[] = [
  { name: 'E1 typed right before the hidden char', src: 'Lead a&shy;b words', typed: 'X', after: 'Lead a', want: 'Lead aX&shy;b words' },
  { name: 'E2 typed right after the hidden char', src: 'Lead a&shy;b words', typed: 'X', after: 'Lead a' + SHY, want: 'Lead a&shy;Xb words' },
  { name: 'E3 the user deletes the hidden char', src: 'Lead a&shy;b words', typed: '', after: 'Lead a', del: 1, want: 'Lead ab words' },
  { name: 'E4 the user deletes the letter before it', src: 'Lead a&shy;b words', typed: '', after: 'Lead ', del: 1, want: 'Lead &shy;b words' },
  { name: 'E5 the user types the same hidden char raw', src: 'Lead a&shy;b words', typed: SHY, after: 'words', want: 'Lead a&shy;b words&shy;' },
  { name: 'E6 the user types another invisible char', src: 'Lead a&shy;b words', typed: ZWJ, after: 'words', want: 'Lead a&shy;b words' + ZWJ },
  { name: 'E7 edit in a bare URL with an escape, start', src: 'See https://e.example/a%E2%80%8Db here', typed: 'Z', after: 'https://', want: 'See [https://Ze.example/a&#x200D;b](https://e.example/a%E2%80%8Db) here' },
  { name: 'E8 edit in a bare URL with an escape, end', src: 'See https://e.example/a%E2%80%8Db here', typed: 'Z', after: 'example/a' + ZWJ + 'b', want: 'See [https://e.example/a&#x200D;bZ](https://e.example/a%E2%80%8Db) here' },
  { name: 'E9 edit in an autolink with an escape, middle', src: 'See <https://e.example/a%E2%80%AEb> here', typed: 'Z', after: 'example/', want: 'See [https://e.example/Za&#x202E;b](https://e.example/a%E2%80%AEb) here' },
  { name: 'E10 edit in an email autolink with an escape', src: 'See <a%E2%80%8Db@e.example> here', typed: 'Z', after: 'e.exam', want: 'See [a&#x200D;b@e.examZple](mailto:a%E2%80%8Db@e.example) here' },
  { name: 'E11 second session on what E7 wrote', src: 'See [https://Ze.example/a&#x200D;b](https://e.example/a%E2%80%8Db) here words' },
  { name: 'E12 link text with a hidden char and a different href', src: 'See [a&#x2060;b](https://e.example/p) words' },
];
describe('challenge-refs: edits around a hidden character', () => {
  for (const c of EDITS) {
    it(c.name, () => {
      const { t } = run(c);
      expect(t, lines[lines.length - 1]).not.toMatch(/^REVEAL/);
    });
  }
  it('lines', () => {
    for (const l of lines) console.log(l);
    if (process.env.R6CR_OUT) writeFileSync(process.env.R6CR_OUT, lines.join('\n') + '\n');
  });
});
