// bench/verify/inline-verify-fidelity.mjs — verifier: source fidelity of in-preview editing (CONTRACT §11).
// For every editable block of a tricky corpus + README.md + docs/SPEC.md + the head of test-data/small.md:
//   (1) click into the block, change nothing, Esc → the source must be byte-identical and no write happened;
//   (2) click, caret at the end, type "x", Backspace, Esc → list every block whose source changed, and
//       whether its rendering changed too (= real corruption, not a normalisation).
// Run: node bench/verify/inline-verify-fidelity.mjs   (own vite :5263, killed at exit)
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, stopServer, openBrowser, readRoot, check, note, measure, finish, sleep, lineDiff, ROOT } from './inline-verify-lib.mjs';

export const TRICKY = [
  '中文段落，含**粗体**和*斜体*，还有 `code` 以及[链接](https://example.com "标题")。',
  'snake_case 与 a * b 以及 5 $ 价格，路径 C:\\dir\\file 保持原样。',
  '价格从 $5 到 $10 之间都可以，另有 \\$ 转义的美元符号。',
  '硬换行在这里  \n第二行紧跟着',
  '反斜杠硬换行\\\n第二行',
  '软换行第一行\n第二行\n第三行',
  'emoji 😀 和 👍🏽 以及「引号」『书名号』——破折号……省略号！？',
  '文本里有 <div> 字样和 <span>内联标签</span>，还有 a < b > c。',
  'a | b | c 管道符出现在正文里',
  '\\# 这不是标题',
  'C#、F# 与 #标签 都在行中',
  '见[1]和[注释]，数组 arr[0] 与 [x] 复选样式文本',
  '~~删除线~~ 与 ~单波浪~ 与 ~~~',
  '<https://autolink.example.com> 和裸链接 https://bare.example.com/path?a=1&b=2 结尾',
  '![图片说明](https://example.com/a.png "图片标题")',
  '这里有一个[引用链接][ref]和[另一个][]。',
  '## 标题含 `代码` 和 [链接](https://x.com)',
  '### 标题带结尾井号 ###',
  '设置型标题\n=========',
  '二级设置型\n---------',
  '* 星号列表一\n* 星号列表二\n    * 四空格嵌套\n* 星号列表三',
  '+ 加号列表\n+ 第二项',
  '1) 右括号有序\n2) 第二项',
  '3. 从三开始\n4. 第四\n5. 第五',
  '- [ ] 待办 A\n- [x] 完成 B\n- [ ] 待办 C 含 **粗体**',
  '- 松散列表一\n\n- 松散列表二\n\n- 松散列表三',
  '- 第一项\n  - 嵌套一\n    - 更深\n  - 嵌套二\n- 第二项',
  '1. 有序\n   - 混合无序\n   - 第二\n2. 有序二',
  '> - 引用中的列表 a\n> - 引用中的列表 b\n>\n> 引用里的段落',
  '> 外层引用\n>> 内层引用\n>> 第二行',
  '> 引用第一行\n引用惰性续行',
  '```js\nconst a = 1;\n\n\nconst b = 2; // 空行在上面\n```',
  '~~~\n波浪号围栏\n~~~',
  '````md\n```\n内含三个反引号\n```\n````',
  '    缩进代码块\n    第二行',
  '```\n无语言代码块 $x$ **不是粗体**\n```',
  '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |\n| 中文 | `代码` | **粗** |',
  '| 列1 | 列2 |\n|-----|-----|\n| a \\| b | c |',
  '列A | 列B\n--- | ---\n无外侧竖线 | 表格',
  '行内公式 $E=mc^2$ 与 $\\alpha + \\beta$ 结尾',
  '$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$',
  '$$ a^2 + b^2 = c^2 $$',
  '*星号强调* 与 _下划线强调_ 与 __下划线加粗__',
  '***粗斜体*** 与 **粗体中有 *斜体* 嵌套**',
  '行尾单个空格 \n下一行',
  'HTML 实体 &copy; &amp; &lt; 以及 &nbsp;不换行',
  '\\*字面星号\\* 与 \\_字面下划线\\_',
  '链接带括号 [维基](https://zh.wikipedia.org/wiki/A_(B)) 与 [尖括号](<https://x.com/a b>)',
  '- 列表项末尾硬换行  \n  续行',
  '制表符\t在\t文本中',
  '1. 一\n2. 二\n\n   第二项的第二段\n3. 三',
  '- 列表项含代码块\n\n  ```py\n  print(1)\n  ```\n- 下一项',
  '2024年度总结：完成 100% 的目标。',
  '行首数字 1. 不是列表，但 1、2、3 是中文编号',
  '#### 四级标题 😀',
  '# 一级标题',
  '纯英文 paragraph with "quotes" and \'single\' and ... ellipsis -- dash.',
  '**加粗**紧贴中文**再加粗**，*斜体*紧贴。',
  '`a`、`b` 与 ``含 ` 反引号``',
  '行内 HTML <kbd>Ctrl</kbd>+<kbd>C</kbd> 与 <sup>上标</sup>',
  '[ref]: https://example.com',
  '<div>\n块级 HTML\n</div>',
  '---',
  '> **注意**：引用中的粗体与 `代码`',
  '- 列表中的 [链接](https://a.com) 与 $x^2$',
  '转义的标签文本 &lt;div&gt; 与 &lt;b&gt;粗&lt;/b&gt; 应保持为字面',
  '反引号内 `&lt;tag&gt;` 与 `<b>` 字面',
  '中文全角标点：，。；：？！（）【】《》、',
  '混排 English 与中文，数字 123 与单位 5kg、50%。',
];

// ---- run
const args = process.argv.slice(2);
const only = args.includes('--tricky-only');
const docs = [
  { name: 'tricky.md', text: TRICKY.join('\n\n') + '\n\n[ref]: https://example.com/ref\n[另一个]: https://example.com/other\n' },
];
if (!only) {
  docs.push({ name: 'README.md', text: readRoot('README.md') });
  docs.push({ name: 'SPEC.md', text: readRoot('docs/SPEC.md') });
  docs.push({ name: 'small-head.md', text: readRoot('test-data/small.md').split('\n').slice(0, 260).join('\n') + '\n' });
}

const EDITABLE = new Set([0, 1, 2, 3, 4, 5, 7]);
const KIND = ['Prose', 'Heading', 'Code', 'Table', 'List', 'Quote', 'Html', 'Math', 'Hr'];
const out = { docs: {}, changed: [], escWrites: [], refused: [], noSession: [], renderChanged: [], errors: [] };

await startServer();
const B = await openBrowser();
const { page } = B;
try {
  await B.boot('mode=split');
  for (const d of docs) {
    await B.loadDoc(d.text, d.name);
    const orig = await B.source();
    const blocks = (await B.blocks()).filter((b) => {
      const lines = orig.split('\n').slice(b.startLine - 1, b.startLine - 1 + b.lineCount);
      return lines.some((l) => l.trim() !== '');
    });
    let tested = 0, same = 0;
    for (const b of blocks) {
      const lines = orig.split('\n').slice(b.startLine - 1, b.startLine - 1 + b.lineCount);
      const label = `${d.name}:${b.startLine} ${KIND[b.kind]} «${lines[0].slice(0, 50)}»`;
      try {
        if ((await B.source()) !== orig) await B.loadDoc(orig, d.name);
        await page.evaluate(() => getSelection().removeAllRanges());
        const zeroH = await page.evaluate(async (line) => { const pv = window.__mdr.app.preview; pv.scrollToLine(line, 0, 'instant'); await new Promise((r) => requestAnimationFrame(r)); await new Promise((r) => requestAnimationFrame(r)); const el = pv.elementOfBlock(pv.blockAtLine(line).id); return !!el && el.getBoundingClientRect().height === 0; }, b.startLine);
        if (zeroH) { out.refused.push(`${label}: renders to nothing (0 px)`); continue; }
        const elPoint = async (line) => (await B.textPoint(line, 'first')) ?? await page.evaluate((line) => {
          const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(line).id);
          const t = el && el.querySelector('img, .md-math, hr, pre, table');
          if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
        }, line);
        const pt = await elPoint(b.startLine);
        if (!pt) { out.noSession.push(`${label}: nothing to click`); continue; }
        const htmlBefore = await page.evaluate(async (args) => {
            const { line, count } = args;
            const pv = window.__mdr.app.preview; let html = ''; let l = line;
            while (l < line + count) {
              const b = pv.blockAtLine(l); if (!b) break;
              pv.scrollToLine(l, 0, 'instant');
              let got = null;
              for (let i = 0; i < 200; i++) {
                const el = pv.elementOfBlock(b.id);
                if (el && !el.classList.contains('is-stale') && !el.classList.contains('is-pending')) { got = el.innerHTML; break; }
                await new Promise((r) => requestAnimationFrame(r));
              }
              html += (got ?? '<<unmounted>>') + '\n';
              l = b.startLine + Math.max(1, b.lineCount);
            }
            return html;
          }, { line: b.startLine, count: b.lineCount });
        await B.mountLine(b.startLine);
        const pt0 = await elPoint(b.startLine);
        const v0 = await B.version();
        await page.mouse.click(pt0.x, pt0.y);
        await sleep(120);
        const e = await B.editing();
        if (!e) {
          const toast = await page.evaluate(() => document.querySelector('.mdr-toast, [class*="toast"]')?.textContent ?? '');
          (EDITABLE.has(b.kind) ? out.noSession : out.refused).push(`${label}${toast ? ` (toast: ${toast.trim().slice(0, 30)})` : ''}`);
          continue;
        }
        await sleep(100);
        const vClick = await B.version();
        await B.esc();
        const afterEsc = await B.source();
        const vEsc = await B.version();
        if (afterEsc !== orig || vEsc !== v0 || vClick !== v0) {
          const df = lineDiff(orig, afterEsc);
          out.escWrites.push({ block: label, versions: [v0, vClick, vEsc], diff: df });
          await B.loadDoc(orig, d.name);
        }
        // (2) type x at the end, delete it
        let ok2 = false;
        for (let k = 0; k < 3 && !ok2; k++) {
          const pt2 = (await B.textPoint(b.startLine, 'last')) ?? await elPoint(b.startLine);
          await page.mouse.click(pt2.x, pt2.y);
          await sleep(150);
          ok2 = !!(await B.editing());
          if (!ok2 && k === 0) out.errors.push(`${label}: second click did not start a session on attempt 1`);
        }
        if (!ok2) { out.noSession.push(`${label} (second click x3)`); continue; }
        await B.caretEnd();
        await page.keyboard.type('x');
        await sleep(80);
        await page.keyboard.press('Backspace');
        await sleep(80);
        await B.esc();
        await sleep(100);
        tested++;
        const after = await B.source();
        if (after !== orig) {
          const df = lineDiff(orig, after);
          // did the rendering change? compare the block HTML after a clean render of the new source
          await B.loadDoc(after, d.name);
          const htmlAfter = await page.evaluate(async (args) => {
            const { line, count } = args;
            const pv = window.__mdr.app.preview; let html = ''; let l = line;
            while (l < line + count) {
              const b = pv.blockAtLine(l); if (!b) break;
              pv.scrollToLine(l, 0, 'instant');
              let got = null;
              for (let i = 0; i < 200; i++) {
                const el = pv.elementOfBlock(b.id);
                if (el && !el.classList.contains('is-stale') && !el.classList.contains('is-pending')) { got = el.innerHTML; break; }
                await new Promise((r) => requestAnimationFrame(r));
              }
              html += (got ?? '<<unmounted>>') + '\n';
              l = b.startLine + Math.max(1, b.lineCount);
            }
            return html;
          }, { line: b.startLine, count: b.lineCount + after.split('\n').length - orig.split('\n').length });
          const norm = (h) => (h ?? '').replace(/\s(data-l|data-mdr-o|contenteditable|spellcheck)="[^"]*"/g, '').replace(/\s*\bis-(focus|editing)\b/g, '').replace(/\sclass=""/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
          const renderSame = norm(htmlBefore) === norm(htmlAfter);
          const rec = { block: label, renderSame, before: df.before, after: df.after };
          out.changed.push(rec);
          if (!renderSame) out.renderChanged.push({ ...rec, htmlBefore: norm(htmlBefore).slice(0, 400), htmlAfter: norm(htmlAfter).slice(0, 400) });
          await B.loadDoc(orig, d.name);
        } else same++;
      } catch (err) {
        out.errors.push(`${label}: ${err.message.split('\n')[0]}`);
        await B.loadDoc(orig, d.name).catch(() => {});
      }
    }
    out.docs[d.name] = { blocks: blocks.length, tested, identical: same };
    console.log(`${d.name}: ${blocks.length} non-blank blocks, ${tested} type+delete tested, ${same} byte-identical`);
  }
  const total = Object.values(out.docs).reduce((a, x) => a + x.tested, 0);
  measure('blocks round-tripped (click+Esc and type/delete)', total, '>= 60', total >= 60);
  check('click + Esc never writes (0 writes, byte-identical)', out.escWrites.length === 0, out.escWrites.map((x) => x.block).join(' ; ').slice(0, 800));
  check('type+delete never changes rendering', out.renderChanged.length === 0, `${out.renderChanged.length} blocks`);
  note('type+delete source changed (normalisations)', `${out.changed.length} blocks`);
  for (const c of out.changed) console.log(`  CHANGED ${c.renderSame ? '(render same)' : '(RENDER DIFFERS)'} ${c.block}\n     - ${JSON.stringify(c.before)}\n     + ${JSON.stringify(c.after)}`);
  for (const r of out.renderChanged) console.log(`  RENDER ${r.block}\n     before: ${r.htmlBefore}\n     after:  ${r.htmlAfter}`);
  console.log('refused (non-editable kinds):', out.refused);
  console.log('no session on editable kind:', out.noSession);
  console.log('errors:', out.errors);
  check('no script errors', out.errors.length === 0, out.errors.slice(0, 3).join(' | '));
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} finally {
  mkdirSync(resolve(ROOT, 'bench/verify/out'), { recursive: true });
  writeFileSync(resolve(ROOT, 'bench/verify/out/inline-verify-fidelity.json'), JSON.stringify(out, null, 2));
  await B.browser.close().catch(() => {});
  stopServer();
}
finish({ docs: out.docs, changed: out.changed.length, renderChanged: out.renderChanged.length, escWrites: out.escWrites.length });
