// fix-trust (stage 2b): U10 (a) over the project's own documents and test-data: every flagged token literally carries a
// reserved name (the findings documents quote forged attributes unescaped); test-data has none.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, rawHtmlReserved } from '../src/worker/md';

const root = new URL('../', import.meta.url);
const files = [
  ...readdirSync(new URL('docs/', root)).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
  ...readdirSync(new URL('test-data/', root)).filter((f) => f.endsWith('.md') && f !== 'huge.md').map((f) => `test-data/${f}`),
  'README.md',
];

describe('U10 (a) corpus', () => {
  it('a raw-HTML token is flagged only when its own text carries a reserved name (no false positives)', () => {
    const md = createMarkdown(DEFAULT_RENDER_OPTIONS).md;
    const hits: string[] = [];
    let html = 0;
    for (const f of files) {
      let text: string;
      try { text = readFileSync(new URL(f, root), 'utf8'); } catch { continue; }
      const walk = (ts: ReturnType<typeof md.parse>): void => {
        for (const t of ts) {
          if (t.type === 'html_block' || t.type === 'html_inline') { html++; if (rawHtmlReserved(t.content)) hits.push(`${f}: ${t.content.slice(0, 80)}`); }
          if (t.children && t.type !== 'image') walk(t.children);
        }
      };
      walk(md.parse(text, { references: {} }));
    }
    console.log(`files ${files.length}, raw-HTML tokens ${html}, flagged ${hits.length}`);
    const literal = /\bdata-(?:l|lang|md[\w-]*)(?=[\s=>/])|\bclass=["']?[^"'>]*\bmdr?-/i;
    expect(hits.filter((h) => !literal.test(h.slice(h.indexOf(': ') + 2)))).toEqual([]);
    expect(hits.filter((h) => h.startsWith('test-data/') || h.startsWith('README'))).toEqual([]);
  });
});
