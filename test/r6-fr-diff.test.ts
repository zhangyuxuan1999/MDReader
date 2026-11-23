// @vitest-environment jsdom
// test/r6-fr-diff.test.ts — fix-refs (0.2.0 stage 2g, fix round 6): differential of the session's writes, the tree's
// serialize.ts against the serializer before round 6 (since round 7, CONTRACT §11 Checkpoint I, the frozen copy of
// the released 0.2.0, test/fixtures/src-0.2.0, which has round 6's changes), over generated blocks (paragraphs, list
// items, task items, quotes, table cells, headings) holding character references and raw occurrences of invisible and
// visible characters, escaped references, percent-escapes of invisible characters in bare URLs, autolinks and link
// destinations, link and image titles, image alts, raw HTML attributes, inline code, formulas and emphasis; three edits each
// (A: a character typed after the last word; B: the last character of the last text deleted; C: a character typed at the
// start). Each block goes through the session's path (worker rendering, marks, stampAtoms, sourceStyleHints, the gate; the
// tree also with begin()'s S4 check and the guard at the start). Every difference is classified:
//   same            identical
//   S               equal once the tree's references of HIDDEN characters are read back as the characters; the tree holds
//                   fewer raw ones (rule S asks for it)
//   S-escape        the same, and an escape next to a hidden character differs (`\_`, `\\`: the reference's `&` / `;`
//                   are the characters next to it now)
//   M2              equal once %EF%BF%BC is decoded (U+FFFC stays an escape)
//   refusal-*       one side refused the block (the gate, S4, the guard at the start)
//   other           anything else (printed: a defect unless explained)
// Tree-only checks: the write adds no counted character beyond what was typed (writeReveals: 0), and the write renders as
// the edited block shows (the gate on the edited DOM) whenever pre's does.
// Run: R6FR_N=1000 R6FR_SEED=1 perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-fr-diff.test.ts   (R6FR_OUT=<file>)
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import * as tree from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import { writeReveals } from '../src/preview/inlineEdit';
import * as pre from './fixtures/src-0.2.0/preview/serialize';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

let seed = Number(process.env.R6FR_SEED ?? 1);
const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const INVIS = [0x200c, 0x200d, 0x202e, 0xad, 0x2060, 0x200e, 0x3000, 0x2003, 0x3164, 0xe000, 0x301, 0xfffc, 0x2009, 0x200b, 0xfeff];
const NAMES: Record<number, string> = { 0x200c: 'zwnj', 0x200d: 'zwj', 0xad: 'shy', 0x2060: 'NoBreak', 0x200e: 'lrm', 0x2003: 'emsp', 0x2009: 'thinsp' };
function ref(cp: number): string {
  const k = rnd();
  if (k < 0.3 && NAMES[cp]) return `&${NAMES[cp]};`;
  if (k < 0.55) return `&#${cp};`;
  if (k < 0.8) return `&#x${cp.toString(16)};`;
  return `&#X${cp.toString(16).toUpperCase()};`;
}
const pct = (cp: number): string => encodeURIComponent(C(cp));
function piece(): string {
  const cp = pick(INVIS);
  const r = rnd();
  if (r < 0.16) return `a${ref(cp)}b`;
  if (r < 0.22) return `c${C(cp)}d`;                                   // raw
  if (r < 0.27) return pick(['&amp;', '&lt;x', '&copy;', '&#65;', '&nbsp;', 'R&D', '\\&shy;', '&amp;zwnj;']);
  if (r < 0.34) return `https://e.example/p${pct(cp)}q`;
  if (r < 0.39) return `<https://e.example/p${pct(cp)}q>`;
  if (r < 0.44) return `[l](https://e.example/p${pct(cp)}q)`;
  if (r < 0.49) return `[t](https://e.example/p "ti${ref(cp)}tle")`;
  if (r < 0.54) return `![al${ref(cp)}t](i.png)`;
  if (r < 0.58) return `![i](i.png "x${ref(cp)}y")`;
  if (r < 0.63) return `<span title="s${ref(cp)}t">sp</span>`;
  if (r < 0.67) return `\`co${ref(cp)}de\``;
  if (r < 0.71) return `*em${ref(cp)}ph*`;
  if (r < 0.74) return `**st${ref(cp)}**`;
  if (r < 0.77) return pick(['$x^2$', '$\\frac{a}{b}$']);
  if (r < 0.80) return `${ref(cp)}_u`;
  return pick(['word', '中文', 'alpha', 'beta', 'x_y', 'a*b']);
}
function line(): string { const n = 2 + Math.floor(rnd() * 4); const p: string[] = []; for (let i = 0; i < n; i++) p.push(piece()); return p.join(' ') + ' words'; }
function block(): string {
  const r = rnd();
  if (r < 0.3) return line();
  if (r < 0.45) return `- ${line()}\n- ${line()}`;
  if (r < 0.55) return `- [ ] ${line()}\n- [x] ${line()}`;
  if (r < 0.65) return `> ${line()}`;
  if (r < 0.75) return `| h | k |\n| --- | --- |\n| ${line().replace(/\|/g, '')} | words |`;
  if (r < 0.85) return `## ${line()}`;
  return `${line()}\n${line()}`;
}
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1,h2,h3,h4,h5,h6') ? BlockKind.Heading : BlockKind.Prose);

type Ser = typeof tree;
function run(which: 'tree' | 'pre', src: string, edit: 'A' | 'B' | 'C'): { out: string | null; why: string; faithful: boolean } {
  const ser = (which === 'tree' ? tree : pre) as unknown as Ser;
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = kindOf(w);
  if (ser.unsupportedReason(w, src) !== null) return { out: null, why: 'unsupported', faithful: false };
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  ser.stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), stamped: true, editing: true };
  let base: string;
  try { base = ser.serializeBlock(w, kind, hints); } catch { return { out: null, why: 'markers', faithful: false }; }
  if (!baselineFaithful(w, kind, base)) return { out: null, why: 'gate', faithful: false };
  if (which === 'tree') {
    const h = hints as tree.SerializeHints;
    if (h.hidden && !baselineFaithful(w, kind, tree.serializeBlock(w, kind, { ...h, hidden: undefined }))) return { out: null, why: 'S4', faithful: false };
    if (writeReveals(src, base) !== null) return { out: null, why: 'guard-start', faithful: false };
  }
  const texts: Text[] = [];
  const tw = document.createTreeWalker(w, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.trim() !== '' && !(n.parentElement?.closest('.md-math, code, pre'))) texts.push(n as Text);
  if (texts.length === 0) return { out: null, why: 'no-text', faithful: false };
  if (edit === 'A') { const t = texts[texts.length - 1]; t.data += 'X'; }
  else if (edit === 'B') { const t = texts[texts.length - 1]; t.data = t.data.slice(0, -1); }
  else { const t = texts[0]; t.data = 'Q' + t.data; }
  let out: string | null = null;
  try { out = ser.serializeBlock(w, kind, hints); } catch { return { out: null, why: 'throw', faithful: false }; }
  return { out, why: '', faithful: baselineFaithful(w, kind, out) };
}

// Harness repair (round 7, integrate): the body takes 22-36 s, over the 30 s default under load.
describe('differential: the tree against pre-r6', { timeout: 120_000 }, () => {
  it('every difference is one that S, M2 or M3 asks for', () => {
    const N = Number(process.env.R6FR_N ?? 1000);
    const cls: Record<string, number> = {};
    const ex: Record<string, string[]> = {};
    const bad: string[] = [];
    const add = (k: string, s: string): void => { cls[k] = (cls[k] ?? 0) + 1; (ex[k] ??= []).length < 6 && ex[k].push(s); };
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
          if (writeReveals(src, t.out) !== null) bad.push('reveals ' + line);
          if (p.out !== null && p.faithful && !t.faithful) bad.push('unfaithful ' + line);
        }
        if (t.out === null || p.out === null) { add(t.out === p.out ? 'refused-both:' + t.why : t.out === null ? 'refusal-tree:' + t.why : 'refusal-pre:' + p.why, line); continue; }
        if (t.out === p.out) { add('same', line); continue; }
        const h = tree.sourceStyleHints(src).hidden;
        // (both outputs decoded alike: a spelling can also stand literally in code, which neither side changes)
        const decode = (s: string): string => { let d = s; if (h) for (const [c, sp] of h) d = d.split(sp).join(c); return d; };
        const dec = decode(t.out);
        p.out = decode(p.out);
        const decPct = (s: string): string => s.replace(/%EF%BF%BC/g, C(0xfffc));
        if (dec === p.out) add('S', line);
        else if (dec.replace(/\\([_\\*])/g, '$1') === p.out.replace(/\\([_\\*])/g, '$1')) add('S-escape', line);
        else if (decPct(dec) === decPct(p.out)) add('M2', line);
        else add('other', line);
      }
    }
    const fmt = (o: Record<string, string[]>): string => Object.entries(o).map(([k, v]) => `[${k}]\n  ` + v.join('\n  ')).join('\n');
    const res = `RESULT seed=${process.env.R6FR_SEED ?? 1} blocks=${N} cases=${cases} classes=${JSON.stringify(cls)} bad=${bad.length}\nEXAMPLES\n${fmt(ex)}\nBAD\n${bad.slice(0, 30).join('\n')}\n`;
    console.log(res);
    if (process.env.R6FR_OUT) writeFileSync(process.env.R6FR_OUT, res);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
