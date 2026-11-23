// test/r3-t-reserved-fp.test.ts — fix-trust (stage 2d, round 3): the false-positive budget of U15 (CONTRACT §11, H1).
// Every block of README.md, docs/*.md and test-data/*.md (not huge.md), cut by the real segmenter and rendered by the
// worker, is flagged by the round-3 scan and by the round-2 scan (a snapshot taken before round 3; since round 7, CONTRACT
// §11 Checkpoint I, the released 0.2.0's, test/fixtures/src-0.2.0: "newly flagged" is then what the tree flags and 0.2.0
// does not, none expected); the test prints how many
// blocks only the new scan flags and why (which rule, and where in the raw HTML the name sits). Asserted: the new scan
// never un-flags a block the old one flagged, every newly flagged block holds raw HTML, and test-data / README gain
// none (they hold no reserved name and no tag left open).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Token } from 'markdown-it';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { segmentAll } from '../src/worker/segmenter';

const root = new URL('../', import.meta.url);
const files = [
  ...readdirSync(new URL('docs/', root)).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ...readdirSync(new URL('test-data/', root)).filter((f) => f.endsWith('.md') && f !== 'huge.md').map((f) => `test-data/${f}`),
  'README.md',
];
// R3T_FP_NODE_MODULES=1 measures, without asserting, on every README.md / *.md one or two levels inside node_modules
// (real-world raw HTML: badges, centred logos, <details>); the gate runs the project's own documents only.
if (process.env.R3T_FP_NODE_MODULES) {
  const nm = new URL('node_modules/', root);
  const add = (dir: string): void => {
    let ents: string[] = [];
    try { ents = readdirSync(new URL(dir, nm)); } catch { return; }
    for (const e of ents) if (/\.md$/i.test(e)) files.push(`node_modules/${dir}${e}`);
  };
  for (const d of readdirSync(nm)) {
    if (d.startsWith('.')) continue;
    if (d.startsWith('@')) { let sub: string[] = []; try { sub = readdirSync(new URL(`${d}/`, nm)); } catch { /* none */ } for (const x of sub) add(`${d}/${x}/`); }
    else add(`${d}/`);
  }
}

// The same rules as src/worker/md.ts, split by alternative, to name the reason.
const RULES: Array<[string, RegExp]> = [
  ['data-l / data-lang', /data-(?:lang|l)(?![a-z0-9_.:-])/],
  ['data-md…', /data-md/],
  ['md- / mdr- token start', /(?<![a-z0-9_-])mdr?-/],
];
const decode = (s: string): string => s.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g, (_m, h: string | undefined, d: string | undefined) => {
  const cp = h !== undefined ? parseInt(h, 16) : parseInt(d!, 10);
  return !Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '?' : String.fromCodePoint(cp);
});
/** Where the first match sits: inside a comment, inside a tag (an attribute), or in text between tags. */
function where(raw: string, at: number): string {
  const before = raw.slice(0, at);
  const co = before.lastIndexOf('<!--');
  if (co >= 0 && before.indexOf('-->', co) < 0) return 'in a comment';
  const lt = before.lastIndexOf('<'), gt = before.lastIndexOf('>');
  return lt > gt ? 'inside a tag' : 'in text between tags';
}
/** The first raw-HTML token's reason: a substring rule (with where the name sits), else the open-tag rule. */
function reasonOf(tokens: Token[]): string | null {
  const raw: string[] = [];
  const collect = (ts: Token[]): void => {
    for (const t of ts) {
      if (t.type === 'html_block' || t.type === 'html_inline') raw.push(t.content);
      if (t.children && t.type !== 'image') collect(t.children);
    }
  };
  collect(tokens);
  for (const c of raw) {
    const low = decode(c).toLowerCase();
    for (const [name, re] of RULES) {
      const m = re.exec(low);
      if (m) return `${name}, ${where(low, m.index)}: ${JSON.stringify(c.slice(0, 60))}`;
    }
  }
  return raw.length ? 'a tag that may stay open (mayEndInTag)' : null;
}

describe('U15 false-positive budget over the project\'s documents', () => {
  it('counts the blocks the text scan flags that the round-2 scan did not', async () => {
    const now = createMarkdown(DEFAULT_RENDER_OPTIONS);
    // The control worker: the released 0.2.0 (test/fixtures/src-0.2.0; it was the round-2 one, deleted at the release).
    let old: ReturnType<typeof createMarkdown> | null = null;
    try { old = (await import('./fixtures/src-0.2.0/worker/md')).createMarkdown(DEFAULT_RENDER_OPTIONS) as unknown as ReturnType<typeof createMarkdown>; } catch { old = null; }
    let blocks = 0, withHtml = 0, flaggedNew = 0, flaggedOld = 0;
    const added: Array<{ file: string; line: number; reason: string; src: string }> = [];
    const removed: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(new URL(f, root), 'utf8'); } catch { continue; }
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      for (const s of segmentAll(lines)) {
        const src = lines.slice(s.start, s.start + s.count).join('\n');
        blocks++;
        const tokens = now.md.parse(src, { references: {} });
        const hasHtml = JSON.stringify(tokens).includes('"html_');
        if (hasHtml) withHtml++;
        const a = (now.renderBlock(src, { references: {} }).flags & HTML_FLAG_RESERVED) !== 0;
        const b = old ? (old.renderBlock(src, { references: {} }).flags & HTML_FLAG_RESERVED) !== 0 : false;
        if (a) flaggedNew++;
        if (b) flaggedOld++;
        if (a && !b) added.push({ file: f, line: s.start + 1, reason: reasonOf(tokens) ?? '?', src: src.slice(0, 90) });
        if (b && !a) removed.push(`${f}:${s.start + 1}`);
      }
    }
    const reasons = new Map<string, number>();
    for (const x of added) { const k = x.reason.replace(/: ".*$/, ''); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    const top = [...reasons.entries()].sort((p, q) => q[1] - p[1]);
    const byFile = new Map<string, number>();
    for (const x of added) byFile.set(x.file, (byFile.get(x.file) ?? 0) + 1);
    console.log(`r3-t fp: files ${files.length}, blocks ${blocks}, with raw HTML ${withHtml}, flagged round 3 ${flaggedNew}, round 2 ${flaggedOld}, `
      + `newly flagged ${added.length}, no longer flagged ${removed.length}\n  reasons: ${top.map(([r, n]) => `${n} × ${r}`).join('; ')}\n`
      + `  by file: ${[...byFile.entries()].map(([f, n]) => `${f} ${n}`).join(', ')}\n`
      + added.slice(0, 12).map((x) => `  ${x.file}:${x.line} [${x.reason}] ${JSON.stringify(x.src)}`).join('\n'));
    expect(removed).toEqual([]);
    expect(added.filter((x) => x.reason === '?')).toEqual([]);
    expect(added.filter((x) => x.file.startsWith('test-data/') || x.file === 'README.md')).toEqual([]);
    if (process.env.R3T_FP_NODE_MODULES) return;
  });
});
