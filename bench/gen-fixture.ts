// bench/gen-fixture.ts — seeded Markdown fixture generator (SPEC §11).
//   node bench/gen-fixture.ts            → bench/fixtures/{small,medium,large,pathological}.md
// Mix (by block count): 40% zh/en paragraphs, 20% nested loose lists with tasks, 15% fences
// (ts/py/json, some 2k lines), 10% tables, 10% headings, 5% quotes/math/HTML. Erasable-syntax TS only,
// so Node ≥ 23 runs it directly; the generator itself is pure and unit-testable.

export type FixtureName = 'small' | 'medium' | 'large' | 'pathological';
export const FIXTURE_BYTES: Record<Exclude<FixtureName, 'pathological'>, number> = {
  small: 50 * 1024,
  medium: 1024 * 1024,
  large: 10 * 1024 * 1024,
};

export type Rng = () => number;

/** mulberry32: small, fast, deterministic. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH = '性能 是 一种 特性 编辑器 需要 在 大文件 下 保持 流畅 输入 滚动 跳转 都 不应 卡顿 渲染 线程 分段 缓存 结构 稳定 标识 段落 标题 列表 表格 代码块 引用 公式 预览 同步 草稿 保存 主题'.split(' ');
const EN = 'the quick brown fox jumps over lazy dog markdown editor worker structure block render cache viewport scroll sync stable identity paragraph heading list table fence quote math preview draft save theme performance budget frame'.split(' ');
const INLINE = ['**%s**', '*%s*', '`%s`', '[%s](https://example.com/%s)', '~~%s~~', '%s'];
const LANGS = ['ts', 'py', 'json'] as const;

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

function words(rng: Rng, n: number, zh: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = pick(rng, zh ? ZH : EN);
    if (rng() < 0.08) w = pick(rng, INLINE).replace(/%s/g, w);
    out.push(w);
  }
  return out.join(zh ? '' : ' ');
}

export function paragraph(rng: Rng): string {
  const zh = rng() < 0.5;
  const sentences = int(rng, 2, 9);
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) parts.push(words(rng, int(rng, 12, 40), zh) + (zh ? '。' : '.'));
  return parts.join(zh ? '' : ' ');
}

export function heading(rng: Rng, level: number): string {
  return `${'#'.repeat(level)} ${words(rng, int(rng, 2, 6), rng() < 0.5)}`;
}

export function list(rng: Rng): string {
  const lines: string[] = [];
  const items = int(rng, 3, 8);
  const ordered = rng() < 0.3;
  for (let i = 0; i < items; i++) {
    const marker = ordered ? `${i + 1}.` : '-';
    const task = rng() < 0.4 ? (rng() < 0.5 ? '[ ] ' : '[x] ') : '';
    lines.push(`${marker} ${task}${words(rng, int(rng, 3, 12), rng() < 0.5)}`);
    if (rng() < 0.5) {
      const nested = int(rng, 1, 3);
      for (let j = 0; j < nested; j++) lines.push(`  - ${words(rng, int(rng, 2, 8), rng() < 0.5)}`);
    }
    if (rng() < 0.5) lines.push(''); // loose list
  }
  return lines.join('\n').replace(/\n+$/, '');
}

function codeLine(rng: Rng, lang: (typeof LANGS)[number], i: number): string {
  switch (lang) {
    case 'ts':
      return pick(rng, [
        `export function f${i}(x: number): number { return x * ${int(rng, 2, 9)} + ${i}; }`,
        `const v${i} = await load('${pick(rng, EN)}'); // ${pick(rng, ZH)}`,
        `if (v${i} > ${int(rng, 0, 100)}) { console.log("${pick(rng, EN)}"); }`,
        `type T${i} = { id: number; name: string; tags: string[] };`,
      ]);
    case 'py':
      return pick(rng, [
        `def f${i}(x):\n    return x * ${int(rng, 2, 9)} + ${i}`,
        `v${i} = [w for w in words if len(w) > ${int(rng, 1, 5)}]  # ${pick(rng, ZH)}`,
        `print(f"${pick(rng, EN)} {v${i}}")`,
        `class C${i}:\n    pass`,
      ]);
    case 'json':
      return `  "k${i}": {"n": ${int(rng, 0, 9999)}, "s": "${pick(rng, EN)}", "b": ${rng() < 0.5}},`;
  }
}

export function fence(rng: Rng, budget = Infinity): string {
  const lang = pick(rng, LANGS);
  const long = budget > 200_000 && rng() < 0.03; // 2k-line fences only while plenty of budget remains
  const n = long ? 2000 : int(rng, 3, 40);
  const lines: string[] = ['```' + lang];
  if (lang === 'json') lines.push('{');
  for (let i = 0; i < n; i++) lines.push(codeLine(rng, lang, i));
  if (lang === 'json') lines.push('  "end": true\n}');
  lines.push('```');
  return lines.join('\n');
}

export function table(rng: Rng): string {
  const cols = int(rng, 2, 5);
  const rows = int(rng, 2, 12);
  const head = Array.from({ length: cols }, (_, i) => `${pick(rng, ZH)}${i}`);
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (let r = 0; r < rows; r++) lines.push(`| ${head.map(() => (rng() < 0.5 ? pick(rng, EN) : String(int(rng, 0, 9999)))).join(' | ')} |`);
  return lines.join('\n');
}

export function misc(rng: Rng): string {
  const k = rng();
  if (k < 0.4) return `> ${words(rng, int(rng, 6, 20), rng() < 0.5)}\n> ${words(rng, int(rng, 4, 12), rng() < 0.5)}`;
  if (k < 0.7) return rng() < 0.5 ? `行内公式 $E = mc^${int(rng, 2, 5)}$ 与 $\\sum_{i=1}^{n} i^2$。` : `$$\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$`;
  if (k < 0.85) return `<div class="note">\n  <p>${words(rng, 8, false)}</p>\n</div>`;
  return '---';
}

/** Generates a document of at least `targetBytes` UTF-16 code units. */
export function generateDoc(targetBytes: number, seed: number): string {
  const rng = mulberry32(seed);
  const parts: string[] = ['# Fixture ' + seed, ''];
  let size = 0;
  let level = 2;
  while (size < targetBytes) {
    const k = rng();
    let block: string;
    if (k < 0.4) block = paragraph(rng);
    else if (k < 0.6) block = list(rng);
    else if (k < 0.75) block = fence(rng, targetBytes - size);
    else if (k < 0.85) block = table(rng);
    else if (k < 0.95) {
      level = rng() < 0.3 ? 2 : Math.min(4, level + (rng() < 0.5 ? 1 : 0));
      block = heading(rng, level);
    } else block = misc(rng);
    parts.push(block, '');
    size += block.length + 2;
  }
  return parts.join('\n');
}

/** One 5 MB paragraph; 20k one-line blocks; one 50k-line fence. */
export function generatePathological(seed: number): string {
  const rng = mulberry32(seed);
  const parts: string[] = ['# Pathological', '', '## 5 MB paragraph', ''];
  const big: string[] = [];
  let size = 0;
  while (size < 5 * 1024 * 1024) {
    const s = paragraph(rng) + ' ';
    big.push(s);
    size += s.length;
  }
  parts.push(big.join(''), '', '## 20k one-line blocks', '');
  for (let i = 0; i < 20_000; i++) parts.push(`${i}: ${words(rng, 4, i % 2 === 0)}`, '');
  parts.push('## 50k-line fence', '', '```ts');
  for (let i = 0; i < 50_000; i++) parts.push(codeLine(rng, 'ts', i));
  parts.push('```', '');
  return parts.join('\n');
}

export function generateFixture(name: FixtureName, seed = 1): string {
  return name === 'pathological' ? generatePathological(seed) : generateDoc(FIXTURE_BYTES[name], seed);
}

// ---- CLI (Node only). Library boundary: no @types/node in this project, so fs is loaded untyped.
const isCli = typeof process !== 'undefined' && Array.isArray(process.argv) && /gen-fixture\.(ts|js)$/.test(process.argv[1] ?? '');
if (isCli) {
  const fs = (await import('node:' + 'fs')) as { mkdirSync(p: string, o?: { recursive: boolean }): void; writeFileSync(p: string, d: string): void };
  const outDir = new URL('./fixtures/', import.meta.url).pathname;
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of ['small', 'medium', 'large', 'pathological'] as FixtureName[]) {
    const text = generateFixture(name);
    fs.writeFileSync(outDir + name + '.md', text);
    console.log(`${name}.md  ${(text.length / 1024).toFixed(0)} KB  ${text.split('\n').length} lines`);
  }
}
