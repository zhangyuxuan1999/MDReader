// @vitest-environment jsdom
// test/v6-von-linktext.test.ts — verify-on (0.2.0 stage 2f, fix round 5 verification): rule "J19 extended" (an escape
// stays an escape) when the user edits the TEXT of a bare URL or an autolink in a session. The worker shows a bare
// URL / autolink with markdown-it's normalizeLinkText, which decodes the percent-escapes, so the link's text in the DOM
// holds the raw character (a bidi override, a format character …) while the source holds %XX. After the user types
// inside that text, the link is no longer the source's bare URL / autolink and the serializer writes it as
// [text](href): the TEXT comes from the DOM, raw. Along the session's own path (worker rendering, stampAtoms,
// sourceStyleHints, stamped: true; the edit: Z typed after "https://e.example/"; serializeBlock editing: true), tree and
// pre-r5. Asserts: no stay-escaped character raw in the output that the source did not hold raw (FAILS today for the
// characters listed in the RESULT lines with "raw added"). The href is checked to stay the source's.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-von-linktext.test.ts   (V6_OUT=<file> for RESULT lines)
// Special characters are built from code points (no typed escapes).
import { beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms } from '../src/preview/serialize';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const log = (s: string): void => { if (process.env.V6_OUT) appendFileSync(process.env.V6_OUT, s + '\n'); };
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const staysEscaped = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
const rawOf = (s: string): string => Array.from(s).filter(staysEscaped).map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase()).join(',');

function run(which: 'tree' | 'pre', src: string): { md: string; href: string[] } | null {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  const kind = w.querySelector('ul') ? BlockKind.List : BlockKind.Prose;
  const ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : pre5;
  if (which === 'tree') stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}) };
  const tw = document.createTreeWalker(w, 4);
  let done = false;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest('a') && t.data.startsWith('https://e.example/')) { t.data = 'https://e.example/Z' + t.data.slice(18); done = true; break; }
  }
  if (!done) { w.remove(); return null; }
  const md = ser.serializeBlock(w, kind, { ...hints, editing: true });
  w.remove();
  const r = document.createElement('div');
  r.replaceChildren(sanitizeToFragment(mdk.renderBlock(md, { references: {} }).html));
  return { md, href: Array.from(r.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '') };
}

// code points that stay escaped (J19 extended), percent-encoded as the source writes them
const CPS = [0x202e, 0x202a, 0x2066, 0x2069, 0x200e, 0x200f, 0x200c, 0x200d, 0x200b, 0x2060, 0xfeff, 0xad, 0xa0, 0x3000, 0x2028, 0xe000, 0x180e, 0x115f, 0x0301];
const enc = (cp: number): string => encodeURIComponent(String.fromCodePoint(cp));
describe('J19 extended: the text of an edited bare URL / autolink (verify-on)', () => {
  for (const cp of CPS) {
    for (const shape of ['bare', 'autolink', 'item-bare']) {
      const u = `https://e.example/a${enc(cp)}b`;
      const src = shape === 'bare' ? `See ${u} here\nsecond words` : shape === 'autolink' ? `See <${u}> here\nsecond words` : `- See ${u} here\n- second words`;
      it(`${shape} U+${cp.toString(16).toUpperCase()}`, () => {
        const t = run('tree', src);
        const p = run('pre', src);
        expect(t).not.toBeNull();
        const added = rawOf(t!.md);
        log(`RESULT ${shape} U+${cp.toString(16).toUpperCase()} | tree raw added [${added}] out ${JSON.stringify(t!.md)} | pre raw added [${p ? rawOf(p.md) : 'n/a'}] out ${JSON.stringify(p?.md)}`);
        expect(t!.href[0]).toBe(u);
        expect(added, JSON.stringify(t!.md)).toBe('');
      });
    }
  }
});
