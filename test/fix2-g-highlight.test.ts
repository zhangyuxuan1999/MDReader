// test/fix2-g-highlight.test.ts — fix-gate (stage 2b): highlight.ts registers highlight.js/lib/common's
// languages itself (so md.ts can be bundled on the main thread without highlight.js, U12). The worker's
// highlighting must not change: same languages, same aliases, byte-identical output against lib/common
// (run in a separate Node process, so the two do not share one highlight.js instance).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import hljs from 'highlight.js/lib/core';
import { describe, expect, it } from 'vitest';
import { highlightCode, registerLanguages } from '../src/worker/highlight';

const ROOT = resolve(__dirname, '..');
const SAMPLES: Array<[string, string]> = [
  ['ts', 'const x: number = 1; // c\nexport function f<T>(a: T): T { return a; }\n'],
  ['js', 'let s = `t ${1}`; /re/g.test("a");\n'],
  ['python', 'def f(x):\n    return x  # c\nprint(f"{1}")\n'],
  ['html', '<div class="a">x &amp; <b>y</b></div>\n'],
  ['bash', 'for f in *.md; do echo "$f"; done\n'],
  ['json', '{"a": [1, true, null]}\n'],
  ['rust', 'fn main() { let v: Vec<u8> = vec![1]; }\n'],
  ['sql', 'SELECT a, COUNT(*) FROM t WHERE b = \'x\' GROUP BY a;\n'],
  ['yaml', 'a: 1\nb: [x, "y"]\n'],
  ['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'],
  ['php', '<?php echo $a; ?>\n'],
  ['wasm', '(module (func $f (result i32) i32.const 1))\n'],
];

describe('fix-gate: highlight.ts keeps highlight.js/lib/common behaviour', () => {
  it('registers exactly lib/common\'s languages', () => {
    const common = readFileSync(resolve(ROOT, 'node_modules/highlight.js/lib/common.js'), 'utf8');
    const names = Array.from(common.matchAll(/registerLanguage\('([^']+)'/g), (m) => m[1]);
    expect(names.length).toBe(36);
    registerLanguages();
    expect(hljs.listLanguages().slice().sort()).toEqual(names.slice().sort());
  });

  it('highlights byte-identically to lib/common (aliases, cap, unknown language)', () => {
    const script = `
      const hljs = require('highlight.js/lib/common');
      const samples = JSON.parse(process.argv[1]);
      const out = samples.map(([lang, code]) => hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : null);
      process.stdout.write(JSON.stringify({ out, langs: hljs.listLanguages().sort(), aliases: ['ts','js','sh','py','html','yml','md','c++','cs','kt','rs','golang'].map((a) => hljs.getLanguage(a)?.name ?? null) }));`;
    const ref = JSON.parse(execFileSync(process.execPath, ['-e', script, JSON.stringify(SAMPLES)], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 }));
    const mine = SAMPLES.map(([lang, code]) => highlightCode(code, lang, 30000));
    expect(mine).toEqual(ref.out);
    expect(mine.every((h) => h !== null)).toBe(true);
    expect(hljs.listLanguages().slice().sort()).toEqual(ref.langs);
    expect(['ts', 'js', 'sh', 'py', 'html', 'yml', 'md', 'c++', 'cs', 'kt', 'rs', 'golang'].map((a) => hljs.getLanguage(a)?.name ?? null)).toEqual(ref.aliases);
    expect(highlightCode('const x = 1;', 'ts', 5)).toBeNull();
    expect(highlightCode('x', 'nosuchlang', 30000)).toBeNull();
    expect(highlightCode('x', '', 30000)).toBeNull();
  });

  it('no worker source imports highlight.js/lib/common (it is declared side-effectful)', () => {
    for (const f of ['md.ts', 'highlight.ts', 'core.ts', 'render.worker.ts']) {
      expect(readFileSync(resolve(ROOT, 'src/worker', f), 'utf8'), f).not.toMatch(/from 'highlight\.js\/lib\/common'/);
    }
  });
});
