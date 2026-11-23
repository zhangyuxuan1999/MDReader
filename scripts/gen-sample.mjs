// Generates large markdown files for performance testing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outDir = new URL('../test-data/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const lorem = '这是一个用于性能测试的段落。Markdown 编辑器需要在大文件下保持流畅：输入、滚动、跳转都不应卡顿。The quick brown fox jumps over the lazy dog. 中文与 English 混排，**加粗**、*斜体*、`行内代码`、[链接](https://example.com) 和 ~~删除线~~。';

function section(i) {
  const parts = [];
  parts.push(`## 第 ${i} 节 Section ${i}`);
  parts.push('');
  parts.push(lorem);
  parts.push('');
  parts.push(`### 子标题 ${i}.1`);
  parts.push('');
  parts.push('- 列表项 A');
  parts.push('- 列表项 B 带 **粗体**');
  parts.push('  - 嵌套项');
  parts.push('- [ ] 待办事项');
  parts.push('- [x] 已完成事项');
  parts.push('');
  parts.push('```ts');
  parts.push(`export function f${i}(x: number): number {`);
  parts.push(`  // section ${i}`);
  parts.push('  return x * 2 + 1;');
  parts.push('}');
  parts.push('```');
  parts.push('');
  parts.push('| 列1 | 列2 | 列3 |');
  parts.push('|-----|-----|-----|');
  parts.push(`| ${i} | ${i * 2} | ${i * 3} |`);
  parts.push(`| a | b | c |`);
  parts.push('');
  parts.push('> 引用块：性能是一种特性。');
  parts.push('');
  parts.push(`行内公式 $E = mc^2$，块级公式：`);
  parts.push('');
  parts.push('$$');
  parts.push(`\\int_0^{${i}} x^2 \\, dx = \\frac{${i}^3}{3}`);
  parts.push('$$');
  parts.push('');
  parts.push(lorem);
  parts.push('');
  return parts.join('\n');
}

function gen(sections) {
  const out = ['# 性能测试文档 Performance Test Document', '', '本文件由 scripts/gen-sample.mjs 生成。', ''];
  for (let i = 1; i <= sections; i++) out.push(section(i));
  return out.join('\n');
}

const sizes = { 'small.md': 30, 'medium.md': 600, 'large.md': 3000, 'huge.md': 10000 };
for (const [name, n] of Object.entries(sizes)) {
  const text = gen(n);
  writeFileSync(join(outDir, name), text);
  const lines = text.split('\n').length;
  console.log(`${name}: ${n} sections, ${lines} lines, ${(text.length / 1024 / 1024).toFixed(2)} MB`);
}
