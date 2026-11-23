// @vitest-environment jsdom
// test/r6-cr-diff.test.ts — challenge-refs (0.2.0 stage 2g, fix round 6): a differential of the session's writes, the
// tree's serialize.ts against the one before round 6 (a snapshot; since round 7, CONTRACT §11 Checkpoint I, the frozen
// copy of the released 0.2.0, test/fixtures/src-0.2.0), with a generator of its own (not fix-refs'):
// Chinese text with the &emsp;&emsp; indent idiom and raw U+3000, references of 30 characters that are not plainly visible
// (named, decimal, hex in both cases, leading zeros), raw emoji sequences, visible references (&copy; &#65; &amp; &hellip;),
// &nbsp; and raw NBSP, escaped references, links and images with titles and alts, bare URLs / autolinks / www / e-mail
// links with percent-escapes, raw HTML (title, abbr, kbd, sub, a coloured span), inline code, formulas; raw invisible
// characters at the edges of table cells and in sanitized attributes (the REVEAL-SWAP class) on a small share; blocks:
// paragraphs, two-line paragraphs, tight / loose / task lists, a list in a quote, tables, ATX and setext headings.
// Edits: A (X typed after the last word), B (the last character deleted), C (Q typed at the start of the first text).
// Classes: same | S (equal once every reference of a character that is not plainly visible is read as the character,
// and the tree holds fewer raw ones) | S-escape (the same, a `\` next to it differs) | M2 | refused-both:<why> |
// refusal-tree:<why> / refusal-pre:<why> | other. Tree-only checks: REVEAL (writeReveals finds a raw character more than
// source + typed) and SWAP (a reference of a character that is not plainly visible is gone while the tree writes it raw).
// Run: R6CR_N=1000 R6CR_SEED=1 perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-cr-diff.test.ts   (R6CR_OUT=<file>)
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
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
const UTILS = new MarkdownIt().utils;
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

let seed = Number(process.env.R6CR_SEED ?? 1) * 7919 + 13;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const INVIS = [0xad, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2062, 0x2063, 0x2066, 0x2067, 0x2068, 0x2069, 0x202a, 0x202d,
  0x202e, 0x2002, 0x2003, 0x2009, 0x200a, 0x205f, 0x3000, 0x3164, 0x1160, 0x2800, 0xfffc, 0x34f, 0x61c, 0x180e, 0xe0041, 0xfe0f, 0x301];
const NAMES: Record<number, string> = { 0xad: 'shy', 0x200c: 'zwnj', 0x200d: 'zwj', 0x200e: 'lrm', 0x200f: 'rlm', 0x2060: 'NoBreak', 0x2061: 'af', 0x2062: 'it', 0x2063: 'ic', 0x2002: 'ensp', 0x2003: 'emsp', 0x2009: 'thinsp', 0x200a: 'hairsp', 0x205f: 'MediumSpace' };
function ref(cp: number): string {
  const k = rnd();
  if (k < 0.35 && NAMES[cp]) return `&${NAMES[cp]};`;
  if (k < 0.5) return `&#${cp};`;
  if (k < 0.6) return `&#000${cp};`;
  if (k < 0.8) return `&#x${cp.toString(16)};`;
  if (k < 0.9) return `&#X${cp.toString(16).toUpperCase()};`;
  return `&#x00${cp.toString(16).toUpperCase()};`;
}
const pct = (cp: number): string => encodeURIComponent(C(cp));
const EMOJI = [C(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467), C(0x1f44d, 0x1f3fd), C(0x1f1e8, 0x1f1f3), '1' + C(0xfe0f, 0x20e3), C(0x2764, 0xfe0f)];
function piece(): string {
  const cp = pick(INVIS);
  const r = rnd();
  if (r < 0.14) return `a${ref(cp)}b`;
  if (r < 0.18) return `中${ref(cp)}文`;
  if (r < 0.22) return pick(EMOJI);
  if (r < 0.26) return pick(['&copy;', '&#65;', '&amp;', '&hellip;', '&lt;x&gt;', '&quot;q&quot;', 'R&D', '\\&zwnj;', '&amp;shy;', 'a&nbsp;b', `c${C(0xa0)}d`]);
  if (r < 0.30) return `https://e.example/p${pct(cp)}q`;
  if (r < 0.33) return `<https://e.example/p${pct(cp)}q>`;
  if (r < 0.35) return `www.e.example/p${pct(cp)}q`;
  if (r < 0.37) return `<u${pct(cp)}v@e.example>`;
  if (r < 0.40) return `[l${ref(cp)}k](https://e.example/p${pct(cp)}q)`;
  if (r < 0.43) return `[t](https://e.example/p "ti${ref(cp)}tle")`;
  if (r < 0.46) return `![al${ref(cp)}t](i.png "x${ref(cp)}y")`;
  if (r < 0.49) return pick([`<span title="s${ref(cp)}t">sp</span>`, `<abbr title="a${ref(cp)}b">ab</abbr>`, `<kbd>k${ref(cp)}d</kbd>`, `<sub>s${ref(cp)}</sub>`, `<span style="color:red">r${ref(cp)}d</span>`]);
  if (r < 0.52) return `\`co${ref(cp)}de\``;
  if (r < 0.56) return pick([`*em${ref(cp)}ph*`, `**st${ref(cp)}**`, `~~de${ref(cp)}l~~`]);
  if (r < 0.58) return pick(['$x^2$', '$\\frac{a}{b}$', '$中$']);
  if (r < 0.60) return `c${C(cp)}d`;                               // raw, shown
  if (r < 0.61) return `<span onclick="o${C(cp)}">s</span>`;       // raw, sanitized away
  return pick(['word', '中文', '正文内容', 'alpha', 'beta', 'x_y', 'a*b', '段落']);
}
function line(): string { const n = 2 + Math.floor(rnd() * 4); const p: string[] = []; for (let i = 0; i < n; i++) p.push(piece()); return p.join(' ') + ' words'; }
function cell(): string {
  let t = line().replace(/\|/g, '');
  const r = rnd();
  if (r < 0.06) t = C(pick([0x3000, 0x2003, 0x200e])) + t;     // raw at the cell start (trimmed by markdown-it)
  return t;
}
function block(): string {
  const r = rnd();
  if (r < 0.22) return (rnd() < 0.3 ? '&emsp;&emsp;' : rnd() < 0.2 ? C(0x3000, 0x3000) : '') + line();
  if (r < 0.32) return `${line()}\n${line()}`;
  if (r < 0.42) return `- ${line()}\n- ${line()}`;
  if (r < 0.48) return `- ${line()}\n\n- ${line()}`;
  if (r < 0.56) return `- [ ] ${line()}\n- [x] ${line()}`;
  if (r < 0.62) return `> - ${line()}\n> - ${line()}`;
  if (r < 0.80) return `| h | k |\n| --- | --- |\n| ${cell()} | ${cell()} |\n| ${cell()} | words |`;
  if (r < 0.92) return `## ${line()}`;
  return `${line()}\n---`;
}
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') && !w.querySelector('blockquote') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1,h2,h3,h4,h5,h6') ? BlockKind.Heading : BlockKind.Prose);

const NOT_PLAIN = (c: string): boolean => c !== ' ' && c !== '\n' && c !== '\t' && !tree.plainlyVisible(c);
const REF = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,8});/g;
function refsOf(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of s.match(REF) ?? []) { const d = UTILS.unescapeAll(r); if (d !== r && Array.from(d).length === 1 && NOT_PLAIN(d)) m.set(d, (m.get(d) ?? 0) + 1); }
  return m;
}
function rawOf(s: string): Map<string, number> { const m = new Map<string, number>(); for (const c of s) if (NOT_PLAIN(c)) m.set(c, (m.get(c) ?? 0) + 1); return m; }
const readRefs = (s: string): string => s.replace(REF, (r) => { const d = UTILS.unescapeAll(r); return d !== r && Array.from(d).length === 1 && NOT_PLAIN(d) ? d : r; });

function run(which: 'tree' | 'pre', src: string, edit: 'A' | 'B' | 'C'): { out: string | null; why: string } {
  const S = (which === 'tree' ? tree : pre) as typeof tree;
  const F = which === 'tree' ? treeFid : preFid;
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = kindOf(w);
  const u = S.unsupportedReason(w, src);
  if (u !== null) return { out: null, why: 'unsupported:' + u };
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true } as tree.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, kind, hints); } catch { return { out: null, why: 'markers' }; }
  if (!F.baselineFaithful(w, kind, base)) return { out: null, why: 'gate' };
  if (which === 'tree') {
    if (hints.hidden && !F.baselineFaithful(w, kind, S.serializeBlock(w, kind, { ...hints, hidden: undefined }))) return { out: null, why: 'S4' };
    if (writeReveals(src, base) !== null) return { out: null, why: 'guard-start' };
  }
  const texts: Text[] = [];
  const tw = document.createTreeWalker(w, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.trim() !== '' && !(n.parentElement?.closest('.md-math, code, pre'))) texts.push(n as Text);
  if (texts.length === 0) return { out: null, why: 'no-text' };
  if (edit === 'A') texts[texts.length - 1].data += 'X';
  else if (edit === 'B') texts[texts.length - 1].data = texts[texts.length - 1].data.slice(0, -1);
  else texts[0].data = 'Q' + texts[0].data;
  try { return { out: S.serializeBlock(w, kind, hints), why: '' }; } catch { return { out: null, why: 'throw' }; }
}

describe('challenge-refs differential: the tree against pre-r6', () => {
  it('classes', () => {
    const N = Number(process.env.R6CR_N ?? 300);
    const cls: Record<string, number> = {};
    const ex: Record<string, string[]> = {};
    const add = (k: string, s: string): void => { cls[k] = (cls[k] ?? 0) + 1; (ex[k] ??= []).length < 5 && ex[k].push(s); };
    const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));
    let cases = 0;
    for (let b = 0; b < N; b++) {
      const src = block();
      for (const edit of ['A', 'B', 'C'] as const) {
        cases++;
        const t = run('tree', src, edit);
        const p = run('pre', src, edit);
        const line = `${edit} src=${show(src)} tree=${show(t.out)}(${t.why}) pre=${show(p.out)}(${p.why})`;
        if (t.out !== null) {
          if (writeReveals(src, t.out, new Map([['X', 1], ['Q', 1]])) !== null) add('TREE-REVEAL', line);
          const rs = refsOf(src), rt = refsOf(t.out), wt = rawOf(t.out);
          for (const [c, k] of rs) if ((rt.get(c) ?? 0) < k && (wt.get(c) ?? 0) > 0) { add('TREE-SWAP', line); break; }
        }
        if (t.out === null || p.out === null) { add(t.out === p.out ? 'refused-both:' + t.why : t.out === null ? 'refusal-tree:' + t.why : 'refusal-pre:' + p.why, line); continue; }
        if (t.out === p.out) { add('same', line); continue; }
        const dt = readRefs(t.out), dp = readRefs(p.out);
        const decPct = (s: string): string => s.replace(/%EF%BF%BC/g, C(0xfffc));
        if (dt === dp) add('S', line);
        else if (dt.replace(/\\([_\\*~$])/g, '$1') === dp.replace(/\\([_\\*~$])/g, '$1')) add('S-escape', line);
        else if (decPct(dt) === decPct(dp)) add('M2', line);
        else add('other', line);
      }
    }
    const fmt = (o: Record<string, string[]>): string => Object.entries(o).map(([k, v]) => `[${k}]\n  ` + v.join('\n  ')).join('\n');
    const res = `RESULT seed=${process.env.R6CR_SEED ?? 1} blocks=${N} cases=${cases} classes=${JSON.stringify(cls)}\nEXAMPLES\n${fmt(ex)}\n`;
    console.log(res.slice(0, 3000));
    if (process.env.R6CR_OUT) writeFileSync(process.env.R6CR_OUT, res);
  });
});
