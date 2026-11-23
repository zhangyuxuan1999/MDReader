// @vitest-environment jsdom
// test/v6-vr-predicate.test.ts — verify-review (stage 2f, after fix round 5): rule "J19 extended", the predicate.
// (1) White box: rawInUrl, BLANK_GLYPHS and VISIBLE_CP are taken from src/preview/serialize.ts's own text (the code
//     that runs) and asked about every code point U+0000..U+10FFFF: which ones it lets through raw whose general
//     category is not L, N, P or S, and which L / N / P / S ones it holds back (the blank list).
// (2) Black box, through the real serializeBlock (no hints: the predicate path; no source spelling): a link destination
//     https://e.example/a%XXb for every code point of the BMP and of the assigned / sampled code points above, and the
//     bare-URL / <url> path (link text = URL) for every code point the white box calls blocked plus a sample of the
//     allowed. Every code point written raw must be one the predicate allows; every one written raw by a writer is
//     counted per general category.
// (3) U+FFFC OBJECT REPLACEMENT CHARACTER: a symbol (So) the predicate lets through, but Chromium draws it with no ink
//     and about 0.3 px wide in the app's fonts (bench/verify/v6-vr-blank.mjs, v6-vr-fffc.mjs): an escape of it in a URL
//     without a source spelling (here: a link of the block DOM, as a reference link defined in another block renders) is
//     written raw. FAILS today (the defining case); pre-r5's serializer is printed for comparison.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-vr-predicate.test.ts   (V6VR_OUT=<file> writes the lists;
// V6VR_FULL=1 checks every BMP code point and more above it through the serializer: about 60 s, run it in the background)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockKind } from '../src/shared/types';
import { serializeBlock } from '../src/preview/serialize';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const SRC = readFileSync(resolve(process.cwd(), 'src/preview/serialize.ts'), 'utf8');
function extract(re: RegExp): string { const m = SRC.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; }
const blankDecl = extract(/const BLANK_GLYPHS[^\n]*\n/);
const visDecl = extract(/const VISIBLE_CP = [^\n]*\n/);
const fnDecl = extract(/function rawInUrl\(c: string\): boolean \{[\s\S]*?\n\}\n/);
const markerDecl = extract(/const MARKER_CHARS = [^\n]*\n/);
const js = [markerDecl, blankDecl, visDecl, fnDecl].join('\n')
  .replace(/: ReadonlySet<number>/g, '').replace(/\(c: string\): boolean/, '(c)').replace(/!\)/g, ')').replace(/\.codePointAt\(0\)!/g, '.codePointAt(0)');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const make = new Function('PUA_RAW', js + '\nreturn { rawInUrl, BLANK_GLYPHS };') as (p: string) => { rawInUrl: (c: string) => boolean; BLANK_GLYPHS: Set<number> };
const { rawInUrl, BLANK_GLYPHS } = make('');

const GC = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So', 'Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Co', 'Cn'];
const GC_RE = GC.map((g) => [g, new RegExp(`^\\p{${g === 'Cn' ? 'Cn' : g}}$`, 'u')] as const);
function gc(c: string): string { for (const [g, re] of GC_RE) if (re.test(c)) return g; return 'Cs'; }
const hex = (cp: number): string => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

describe('J19 extended: the predicate rawInUrl', () => {
  it('white box: every code point', () => {
    const notLNPS: string[] = [];
    const lnpsBlocked: string[] = [];
    const perGc: Record<string, number> = {};
    const LNPS = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const ok = rawInUrl(c);
      const lnps = LNPS.test(c);
      if (ok) perGc[lnps ? 'LNPS' : gc(c)] = (perGc[lnps ? 'LNPS' : gc(c)] ?? 0) + 1;
      if (ok && !lnps) notLNPS.push(`${hex(cp)} ${gc(c)}`);
      if (!ok && lnps) lnpsBlocked.push(`${hex(cp)} ${gc(c)}`);
    }
    // with a marker-range character held raw by the source (PUA_RAW)
    const withPua = make(String.fromCodePoint(0xe000));
    const puaOk = [0xe000, 0xe001, 0xfdd0].map((cp) => `${hex(cp)}=${withPua.rawInUrl(String.fromCodePoint(cp))}`);
    const out = `WHITE allowedPerGc=${JSON.stringify(perGc)}\nallowed-not-LNPS (${notLNPS.length}): ${notLNPS.join(', ')}\nLNPS-blocked (${lnpsBlocked.length}): ${lnpsBlocked.join(', ')}\nblank list: ${[...BLANK_GLYPHS].map(hex).join(', ')}\nPUA_RAW=U+E000: ${puaOk.join(' ')}\n`;
    console.log(out);
    if (process.env.V6VR_OUT) writeFileSync(process.env.V6VR_OUT + '.white', out);
    expect(notLNPS).toEqual(['U+0020 Zs']);
    expect(lnpsBlocked.map((x) => x.split(' ')[0]).sort()).toEqual([...BLANK_GLYPHS].map(hex).sort());
  }, 60_000);

  it('black box: the serializer writes raw only what the predicate allows (destinations, BMP and beyond)', () => {
    const cps: number[] = [];
    // V6VR_FULL=1: every code point of the BMP (about 60 s); default: every 9th, plus every one that is not L / N / P / S
    const full = process.env.V6VR_FULL === '1';
    for (let cp = 0x80; cp <= 0xffff; cp++) if ((cp < 0xd800 || cp > 0xdfff) && (full || cp % 9 === 0 || !/^[\p{L}\p{N}\p{P}\p{S}]$/u.test(String.fromCodePoint(cp)) || BLANK_GLYPHS.has(cp))) cps.push(cp);
    for (let cp = 0x10000; cp <= 0x10ffff; cp++) {
      const c = String.fromCodePoint(cp);
      if (/\P{Cn}/u.test(c) ? cp % (full ? 7 : 61) === 0 || /[\p{Cf}\p{Mn}\p{Zs}]/u.test(c) || (cp % (full ? 1 : 97) === 0 && /\p{Co}/u.test(c)) || BLANK_GLYPHS.has(cp) : cp % 4099 === 0) cps.push(cp);
    }
    const p = document.createElement('p');
    const sec = document.createElement('section');
    sec.className = 'md-block';
    sec.appendChild(p);
    document.body.appendChild(sec);
    const wrong: string[] = [];
    const rawPerGc: Record<string, number> = {};
    let checked = 0, unreadable = 0;
    const K = 1200;
    for (let i = 0; i < cps.length; i += K) {
      const chunk = cps.slice(i, i + K);
      p.replaceChildren();
      for (const cp of chunk) {
        const a = document.createElement('a');
        a.setAttribute('href', 'https://e.example/a' + encodeURIComponent(String.fromCodePoint(cp)) + 'b');
        a.textContent = 'l';
        p.append(a, document.createTextNode(' '));
      }
      const md = serializeBlock(sec, BlockKind.Prose, { editing: true });
      const dests = Array.from(md.matchAll(/\]\(<?https:\/\/e\.example\/a([\s\S]*?)b>?\)/g)).map((m) => m[1]);
      if (dests.length !== chunk.length) { unreadable += chunk.length; continue; }
      chunk.forEach((cp, k) => {
        const c = String.fromCodePoint(cp);
        const d = dests[k];
        checked++;
        const raw = d === c;
        if (raw) rawPerGc[gc(c)] = (rawPerGc[gc(c)] ?? 0) + 1;
        if (raw && !rawInUrl(c)) wrong.push(`${hex(cp)} ${gc(c)} written raw`);
        if (!raw && d.toUpperCase() !== encodeURIComponent(c).toUpperCase()) wrong.push(`${hex(cp)} ${gc(c)} written as ${JSON.stringify(d)}`);
      });
    }
    const out = `BLACK dest checked=${checked} unreadable=${unreadable} rawPerGc=${JSON.stringify(rawPerGc)} wrong(${wrong.length})=${wrong.slice(0, 40).join('; ')}\n`;
    console.log(out);
    if (process.env.V6VR_OUT) writeFileSync(process.env.V6VR_OUT + '.dest', out);
    expect(unreadable).toBe(0);
    expect(wrong).toEqual([]);
  }, 100_000);

  it('black box: bare URL / <url> spelling of the link text holds back what the predicate blocks', () => {
    const blocked: number[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (!rawInUrl(c) && (cp <= 0xffff || /\P{Cn}/u.test(c) || cp % 4099 === 0)) blocked.push(cp);
    }
    const sample = blocked.filter((cp, i) => BLANK_GLYPHS.has(cp) || (process.env.V6VR_FULL === '1' ? cp <= 0x3000 || i % 13 === 0 : (cp <= 0x3000 && i % 3 === 0) || i % 131 === 0));
    const sec = document.createElement('section');
    sec.className = 'md-block';
    const p = document.createElement('p');
    sec.appendChild(p);
    document.body.replaceChildren(sec);
    const wrong: string[] = [];
    let checked = 0;
    for (const cp of sample) {
      const c = String.fromCodePoint(cp);
      const href = 'https://e.example/a' + encodeURIComponent(c) + 'b';
      // the link text as markdown-it's normalizeLinkText shows it (decoded)
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = 'https://e.example/a' + c + 'b';
      p.replaceChildren(document.createTextNode('See '), a, document.createTextNode(' words'));
      let md = '';
      try { md = serializeBlock(sec, BlockKind.Prose, { editing: true }); } catch (e) { wrong.push(`${hex(cp)} threw ${String(e)}`); continue; }
      checked++;
      if (md.includes(c) && c.trim() !== '') wrong.push(`${hex(cp)} ${gc(c)} raw in ${JSON.stringify(md.replace(c, '<RAW>'))}`);
    }
    const out = `BLACK bare/auto checked=${checked} of ${blocked.length} blocked wrong(${wrong.length})=${wrong.slice(0, 40).join('; ')}\n`;
    console.log(out);
    if (process.env.V6VR_OUT) writeFileSync(process.env.V6VR_OUT + '.bare', out);
    expect(wrong).toEqual([]);
  }, 100_000);

  it('U+FFFC, drawn blank, stays an escape in a URL without a source spelling', () => {
    const sec = document.createElement('section');
    sec.className = 'md-block';
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.setAttribute('href', 'https://e.example/a%EF%BF%BCb');
    a.textContent = 'r';
    p.append(document.createTextNode('See '), a, document.createTextNode(' words'));
    sec.appendChild(p);
    document.body.replaceChildren(sec);
    const obj = String.fromCodePoint(0xfffc);
    const tree = serializeBlock(sec, BlockKind.Prose, { editing: true });
    const pre = (pre5.serializeBlock as typeof serializeBlock)(sec, BlockKind.Prose, { editing: true });
    const show = (s: string): string => JSON.stringify(s.replace(/[^\x20-\x7e]/g, (c) => '<' + c.codePointAt(0)!.toString(16) + '>'));
    console.log(`FFFC tree=${show(tree)} pre=${show(pre)}`);
    expect(tree.includes(obj), show(tree)).toBe(false);
  });
});
