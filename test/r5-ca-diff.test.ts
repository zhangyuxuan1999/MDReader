// @vitest-environment jsdom
// test/r5-ca-diff.test.ts — challenge-atoms (stage 2f, fix round 5): unit-level differential of the session's writes,
// the tree's serialize.ts (with stampAtoms + stamped, as inlineEdit begin() does) against the serializer before round 5 (since round 7, CONTRACT §11
// Checkpoint I, the frozen copy of the released 0.2.0, test/fixtures/src-0.2.0, which has round 5's repairs), over
// generated blocks (paragraphs, list items, task items, quotes, table cells, headings) holding URLs in every spelling
// (escaped visible and invisible characters, raw characters, entities, backslash escapes, %20, parentheses, angle
// brackets, autolinks, bare URLs, images, reference links) next to formulas, code and emphasis; three edits each (a
// typed character after a word, the last character of the last text deleted, a word typed at the start).
// Every difference between the two writes is classified:
//   same                 identical
//   url-escape-kept      equal once %XX are decoded; the tree holds fewer raw stay-escaped characters (J19 extended asks)
//   url-spelling-kept    equal once %XX are decoded, same raw stay-escaped count; the tree's URLs are the source's spelling
//   url-more-raw         equal once %XX are decoded; the tree holds MORE raw stay-escaped characters (a defect)
//   other                anything else (printed, a defect unless explained)
// Tree-only checks per edit: the hrefs after a re-render equal the hrefs before the edit (BAD-href), and no raw
// stay-escaped character the source did not hold raw (BAD-raw, by kind of spelling).
// Run: R5CA_N=700 perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-ca-diff.test.ts   (R5CA_SEED, default 1)
// Prints a RESULT line with the counts and up to 12 examples per class. Special characters are built from code points.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
const REFS: References = { R: { href: 'https://r.example/a%E2%80%8Bb', title: '' }, V: { href: 'https://r.example/%E4%B8%AD', title: '' } };

function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: { ...REFS } }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return w;
}
const urls = (w: Element): string[] => Array.from(w.querySelectorAll('a[href], img[src]')).map((e) => e.getAttribute(e.tagName === 'A' ? 'href' : 'src') ?? '');
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1,h2,h3,h4,h5,h6') ? BlockKind.Heading : BlockKind.Prose);
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const staysEscaped = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
const rawCount = (s: string): number => Array.from(s).filter(staysEscaped).length;
const decodeAll = (s: string): string => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/g, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));

let seed = Number(process.env.R5CA_SEED ?? 1);
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

const INVIS = [0x200b, 0xfeff, 0xa0, 0x202e, 0x3000, 0xad, 0x2060, 0xe000, 0x301, 0x3164];
const VIS = [0x4e2d, 0xe9, 0x2603, 0x1f600, 0x20ac];
function piece(kind: 'escInvis' | 'escVis' | 'rawInvis' | 'rawVis' | 'entInvis' | 'entVis' | 'bs' | 'sp' | 'plain'): string {
  const c = C(kind.endsWith('Invis') ? pick(INVIS) : pick(VIS));
  switch (kind) {
    case 'escInvis': case 'escVis': { const e = encodeURIComponent(c); return rnd() < 0.3 ? e.toLowerCase() : e; }
    case 'rawInvis': return c === C(0xa0) || c === C(0x3000) ? C(0x200b) : c;   // (a raw space ends a URL)
    case 'rawVis': return c;
    case 'entInvis': case 'entVis': return '&#x' + c.codePointAt(0)!.toString(16) + ';';
    case 'bs': return '\\_';
    case 'sp': return '%20';
    default: return 'p';
  }
}
const KINDS = ['escInvis', 'escVis', 'rawInvis', 'rawVis', 'entInvis', 'entVis', 'bs', 'sp', 'plain'] as const;
function url(allowEnt: boolean): { u: string; kinds: string[] } {
  const ks: string[] = [];
  let u = 'https://e.example/' + pick(['a', 'path/', '?q=', '#f', '']);
  const n = 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    let k = pick([...KINDS]);
    if (!allowEnt && (k === 'entInvis' || k === 'entVis' || k === 'bs')) k = 'escInvis';
    ks.push(k); u += piece(k) + 'z';
  }
  return { u, kinds: ks };
}
function inline(): { s: string; kinds: string[] } {
  const r = rnd();
  if (r < 0.25) { const { u, kinds } = url(true); return { s: `[l](${u})`, kinds: kinds.map((k) => 'dest:' + k) }; }
  if (r < 0.35) { const { u, kinds } = url(true); return { s: `[l](${u} "t")`, kinds: kinds.map((k) => 'dest:' + k) }; }
  if (r < 0.45) { const { u, kinds } = url(true); return { s: `![i](${u}.png)`, kinds: kinds.map((k) => 'img:' + k) }; }
  if (r < 0.6) { const { u, kinds } = url(false); return { s: `<${u}>`, kinds: kinds.map((k) => 'auto:' + k) }; }
  if (r < 0.72) { const { u, kinds } = url(false); return { s: `${u} `, kinds: kinds.map((k) => 'bare:' + k) }; }
  if (r < 0.77) return { s: pick(['[r][R]', '[v][V]']), kinds: ['ref'] };
  return { s: pick(['$x^2$', '$\\frac{a}{b}$', '`co|de`', '**b**', '*e*', '中文', 'word', '<kbd>K</kbd>', '&amp;']), kinds: [] };
}
function block(): { src: string; kinds: string[] } {
  const parts: string[] = []; const kinds: string[] = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) { const p = inline(); parts.push(p.s); kinds.push(...p.kinds); }
  // the same href twice, once in another spelling, now and then
  if (rnd() < 0.15) { const a = 'https://e.example/d' + C(0x200b) + 'q'; const b = 'https://e.example/d%E2%80%8Bq'; parts.push(rnd() < 0.5 ? `[a](${a}) [b](${b})` : `[b](${b}) [a](${a})`); kinds.push('dup'); }
  const body = parts.join(' and ') + ' words';
  const shape = pick(['p', 'li', 'task', 'quote', 'cell', 'h']);
  const src = shape === 'p' ? `See ${body}\nsecond line words` : shape === 'li' ? `- See ${body}\n- next words` : shape === 'task' ? `- [x] See ${body}\n- [ ] next words`
    : shape === 'quote' ? `> See ${body}\n> more words` : shape === 'cell' ? `| See ${body.replace(/\|/g, '\\|')} | c |\n|---|---|\n| d | words |` : `## See ${body}`;
  return { src, kinds };
}

type Ser = { serializeBlock: typeof serializeBlock; sourceStyleHints: typeof sourceStyleHints };
function run(which: 'tree' | 'pre', src: string, edit: number): { md: string | null; refused: boolean; before: string[] } {
  const w = mount(src);
  const before = urls(w);
  const kind = kindOf(w);
  const ser: Ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : (pre5 as unknown as Ser);
  if (which === 'tree') stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}) };
  try {
    const base = ser.serializeBlock(w, kind, { ...hints, editing: true });
    if (unsupportedReason(w, src) !== null || !baselineFaithful(w, kind, base)) { w.remove(); return { md: null, refused: true, before }; }
  } catch { w.remove(); return { md: null, refused: true, before }; }
  const texts: Text[] = [];
  const tw = document.createTreeWalker(w, 4, { acceptNode: (n) => ((n.parentElement?.closest('.md-math, a, code, kbd')) ? 2 : 1) });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/\S/.test((n as Text).data)) texts.push(n as Text);
  if (edit === 0) { const t = texts.find((x) => x.data.includes('words')); if (t) t.data = t.data.replace('words', 'wordsX'); }
  else if (edit === 1) { const t = [...texts].reverse().find((x) => x.data.trim().length > 1); if (t) t.data = t.data.replace(/\S(\s*)$/, '$1'); }
  else { const t = texts[0]; if (t) t.data = 'Yy ' + t.data; }
  let md: string | null = null;
  try { md = ser.serializeBlock(w, kind, { ...hints, editing: true }); } catch { md = null; }
  w.remove();
  return { md, refused: false, before };
}

describe('session write differential: tree vs pre-r5', () => {
  it('classifies every difference', () => {
    const N = Number(process.env.R5CA_N ?? 700);
    const cls: Record<string, number> = {};
    const ex: Record<string, string[]> = {};
    const bad: Record<string, number> = {};
    const badEx: Record<string, string[]> = {};
    const add = (k: string, e: string): void => { cls[k] = (cls[k] ?? 0) + 1; (ex[k] ??= []).length < 12 && ex[k].push(e); };
    const addBad = (k: string, e: string): void => { bad[k] = (bad[k] ?? 0) + 1; (badEx[k] ??= []).length < 6 && badEx[k].push(e); };
    let refusedTree = 0, refusedPre = 0, cases = 0;
    for (let i = 0; i < N; i++) {
      const { src, kinds } = block();
      for (let e = 0; e < 3; e++) {
        cases++;
        const t = run('tree', src, e);
        const p = run('pre', src, e);
        document.body.replaceChildren();
        if (t.refused) refusedTree++;
        if (p.refused) refusedPre++;
        if (t.refused || p.refused) { if (t.refused !== p.refused) add('refusal-differs', `${show(src)} tree=${t.refused} pre=${p.refused}`); continue; }
        const line = `src=${show(src)}\n      tree=${show(t.md)}\n      pre =${show(p.md)}`;
        if (t.md === null || p.md === null) { add(t.md === p.md ? 'both-threw' : 'throw-differs', line); continue; }
        // tree-only checks
        const after = urls(mount(t.md));
        document.body.replaceChildren();
        if (JSON.stringify(after) !== JSON.stringify(t.before)) addBad('href-changed', line);
        if (rawCount(t.md) > rawCount(src)) addBad('raw-added:' + (kinds.some((k) => k.includes('ent')) ? 'entity' : kinds.includes('dup') ? 'dup' : 'neither:' + [...new Set(kinds)].sort().join('+')), line);
        if (t.md === p.md) { add('same', ''); continue; }
        if (decodeAll(t.md) === decodeAll(p.md)) {
          const tr = rawCount(t.md), pr = rawCount(p.md);
          add(tr < pr ? 'url-escape-kept' : tr > pr ? 'url-more-raw' : 'url-spelling-kept', line);
        } else { const bt = t.md.split('](').length, bp = p.md.split('](').length; add(bt < bp ? 'other:tree-fewer-[](' : bt > bp ? 'other:tree-more-[](' : 'other:misc', line); }
      }
    }
    const fmt = (o: Record<string, string[]>): string => Object.entries(o).map(([k, v]) => `  [${k}]\n` + v.filter(Boolean).map((x) => '    ' + x).join('\n')).join('\n');
    console.log(`RESULT seed=${process.env.R5CA_SEED ?? 1} blocks=${N} cases=${cases} refusedTree=${refusedTree} refusedPre=${refusedPre} classes=${JSON.stringify(cls)} treeBad=${JSON.stringify(bad)}\nEXAMPLES\n${fmt(ex)}\nBAD\n${fmt(badEx)}`);
    if (process.env.R5CA_OUT) writeFileSync(process.env.R5CA_OUT, `RESULT seed=${process.env.R5CA_SEED ?? 1} blocks=${N} cases=${cases} refusedTree=${refusedTree} refusedPre=${refusedPre} classes=${JSON.stringify(cls)} treeBad=${JSON.stringify(bad)}\nEXAMPLES\n${fmt(ex)}\nBAD\n${fmt(badEx)}\n`);
  }, 100_000);
});
