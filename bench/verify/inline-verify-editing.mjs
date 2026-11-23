// bench/verify/inline-verify-editing.mjs — verifier: keys and typing inside in-preview edit sessions (CONTRACT §11).
// Run: node bench/verify/inline-verify-editing.mjs   (own vite :5263, killed at exit)
import { startServer, stopServer, openBrowser, check, note, step, assert, eq, finish, sleep, measure } from './inline-verify-lib.mjs';

const DOC = [
  '# 文档标题',                                   // 1
  '',
  '普通段落，含**加粗文字在这里**和*斜体*，还有 `inline code` 与[链接](https://a.example.com)。', // 3
  '',
  '第二段落用于测试回车拆分和退格合并。',            // 5
  '',
  '- 列表项一',                                   // 7
  '- 列表项二',
  '  - 嵌套项',
  '- [ ] 任务项',                                  // 10
  '',
  '| 表头A | 表头B |',                              // 12
  '|-------|-------|',
  '| 单元一 | 单元二 |',
  '',
  '```js',                                        // 16
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
  '> 引用段落文字',                                // 21
  '',
  '## 二级标题',                                   // 23
  '',
  '尾段落。',                                      // 25
  '',
].join('\n');
const L = (needle) => DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
const S40 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';

await startServer();
const B = await openBrowser();
const { page, context } = B;

/** Types `text` one key at a time at `delay` ms and samples the caret after each key. */
async function typeWatch(text, delay = 40) {
  const miss = [];
  let sameEl = true;
  const el0 = await page.evaluate(() => { window.__vEl = document.querySelector('.mdr-preview .is-editing'); return !!window.__vEl; });
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    await sleep(delay);
    if (!(await B.caretInEditing())) miss.push(i);
    if (!(await page.evaluate(() => window.__vEl && window.__vEl.isConnected && window.__vEl.classList.contains('is-editing')))) sameEl = false;
  }
  return { miss, sameEl: el0 && sameEl };
}
const lineText = async (n) => (await B.source()).split('\n')[n - 1];

try {
  await B.boot('mode=split');

  // ------------------------------------------------------------ typing 40 chars at 40 ms in many places
  const places = [
    { name: 'middle of bold text', line: L('加粗文字'), needle: '加粗文', expect: (s) => s.includes(`**加粗文${S40}字在这里**`) },
    { name: 'very start of a paragraph block', line: L('第二段落'), needle: '第二段落', where: 'before', expect: (s) => s.includes(`\n${S40}第二段落`) },
    { name: 'very end of a paragraph block', line: L('第二段落'), needle: '退格合并。', expect: (s) => s.includes(`退格合并。${S40}\n`) },
    { name: 'inside inline code', line: L('inline code'), needle: 'inline', expect: (s) => s.includes(`\`inline${S40} code\``) },
    { name: 'inside a list item', line: L('列表项一'), needle: '列表项一', expect: (s) => s.includes(`- 列表项一${S40}\n`) },
    { name: 'inside a nested list item', line: L('列表项一'), needle: '嵌套项', expect: (s) => s.includes(`  - 嵌套项${S40}\n`) },
    { name: 'inside a table cell', line: L('表头A'), needle: '单元一', expect: (s) => s.includes(`单元一${S40}`) && /\n\| 单元一\w+ \| 单元二 \|/.test(s) },
    { name: 'inside a code fence', line: L('```js'), needle: ' a = ', joined: 'const a', expect: (s) => s.includes(`\`\`\`js\nconst a${S40} = 1;\nconst b = 2;\n\`\`\``) },
    { name: 'inside a quote', line: L('引用段落'), needle: '引用段落', expect: (s) => s.includes(`> 引用段落${S40}文字`) },
    { name: 'in a heading', line: L('二级标题'), needle: '二级标题', expect: (s) => s.includes(`## 二级标题${S40}\n`) },
    { name: 'end of document (last block)', line: L('尾段落'), needle: '尾段落。', expect: (s) => s.includes(`尾段落。${S40}`) },
  ];
  const typingLat = [];
  for (const p of places) {
    await step(`type 40 chars @40ms ${p.name}: caret never leaves, block element kept, source exact`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(p.line, 'first', p.needle);
      assert(await B.editing(), 'no session');
      if (p.joined) await B.joined(p.joined); else await B.caretAt(p.needle, p.where ?? 'after');
      const r = await typeWatch(S40, 40);
      await B.settle(200);
      const s = await B.source();
      assert(r.miss.length === 0, `caret left the block after keys ${r.miss.join(',')}`);
      assert(r.sameEl, 'editing element replaced / session lost during typing');
      assert(p.expect(s), `source: ${JSON.stringify(s.split('\n').filter((l) => l.includes('abc')).join(' / '))}`);
      // only the lines of this block changed
      const a = DOC.split('\n'), b = s.split('\n');
      const changed = b.map((l, i) => (l !== a[i] ? i + 1 : 0)).filter(Boolean);
      await B.esc();
      return `changed lines ${changed.join(',')}`;
    });
  }

  // ------------------------------------------------------------ Enter at start / middle / end
  await step('Enter at END of a paragraph → new empty paragraph, session resumes there, typing lands in it', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新段');
    await B.settle(400);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    assert(s.includes('第二段落用于测试回车拆分和退格合并。\n\n新段\n'), `src ${JSON.stringify(s.split('\n').slice(3, 9))}`);
    assert(e && e.text.includes('新段'), `session on ${e && e.text}`);
  });
  await step('Enter at START of a paragraph → empty paragraph before, caret stays with the text', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('第二段落', 'before');
    await page.keyboard.press('Enter');
    await page.keyboard.type('前');
    await B.settle(400);
    const s = await B.source();
    await B.esc();
    return JSON.stringify(s.split('\n').slice(2, 9));
  });
  await step('Enter mid-paragraph ×3 quickly then type → 4 paragraphs, all text kept, typing at the right place', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('第二');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A');
    await page.keyboard.press('Enter');
    await page.keyboard.type('B');
    await page.keyboard.press('Enter');
    await page.keyboard.type('C');
    await B.settle(600);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 14).join('\\n');
    assert(s.includes('第二\n\nA\n\nB\n\nC段落用于测试回车拆分和退格合并。'), seg);
    return seg;
  });

  // ------------------------------------------------------------ Backspace after a split / at block start
  await step('Backspace at START of a paragraph block (merge with previous?) — report', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('第二段落', 'before');
    const v0 = await B.version();
    await page.keyboard.press('Backspace');
    await B.settle(300);
    const s = await B.source();
    const e = await B.editing();
    note('Backspace at block start', `source ${s === DOC ? 'unchanged (no merge)' : 'CHANGED: ' + JSON.stringify(s.split('\n').slice(2, 6))}; writes ${(await B.version()) - v0}; session ${e ? 'still on block' : 'gone'}; caret offset ${await B.caretOffset()}`);
    await B.esc();
  });
  await step('accidental Enter then immediate Backspace (fix a typo) → source back to one paragraph', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await sleep(30);
    await page.keyboard.press('Backspace');
    await B.settle(400);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 9);
    assert(s.includes('第二段落用于测试回车拆分和退格合并。'), `after Enter+Backspace: ${JSON.stringify(seg)}`);
  });
  await step('accidental Enter, wait, Backspace at start of the split-off block → merged back', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await B.settle(400);
    await page.keyboard.press('Backspace');
    await B.settle(400);
    const s = await B.source();
    await B.esc();
    assert(s.includes('第二段落用于测试回车拆分和退格合并。'), `after Enter, pause, Backspace: ${JSON.stringify(s.split('\n').slice(4, 9))}`);
  });
  await step('Backspace typed ≤ 1 frame after a split-causing keystroke is not lost (heading directly followed by a paragraph)', async () => {
    const d = '## 标题\n紧跟的段落文字。\n\n尾段\n';
    await B.loadDoc(d);
    await B.clickLine(1, 'first', '段落');
    await B.caretAt('段落');
    await page.keyboard.type('x');
    await sleep(20);
    await page.keyboard.press('Backspace');
    await B.settle(400);
    const s = await B.source();
    await B.esc();
    assert(!s.includes('段落x'), `typed x survived the Backspace: ${JSON.stringify(s)}`);
  });
  await step('ArrowLeft + typing ≤ 1 frame after Enter lands where the caret moved (keys other than printable/Backspace during resume)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Z');
    await B.settle(400);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 8);
    assert(s.includes('\n\n拆Z分'), `after Enter, →, Z: ${JSON.stringify(seg)}`);
  });

  // ------------------------------------------------------------ Shift+Enter then Enter
  await step('Shift+Enter then Enter → hard break "  \\n" then new paragraph', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('测试');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Q');
    await B.settle(500);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 10);
    return JSON.stringify(seg);
  });
  await step('Shift+Enter at end of paragraph then type → "  \\n" + text', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('下一行');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    eq(s.split('\n').slice(4, 6).join('\n'), '第二段落用于测试回车拆分和退格合并。  \n下一行', 'lines');
  });

  // ------------------------------------------------------------ ⌘B partially bold, ⌘E toggle off
  await step('⌘B on a selection that is partially bold → valid Markdown, render keeps the text', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('加粗文字'), 'first', '普通段落');
    await B.joined('含加粗', 'select');
    // selection "含加粗" spans plain "含" + bold "加粗"
    await page.keyboard.press('ControlOrMeta+b');
    await B.settle(200);
    const s1 = (await B.source()).split('\n')[2];
    await page.keyboard.press('ControlOrMeta+b');
    await B.settle(200);
    const s2 = (await B.source()).split('\n')[2];
    await B.esc();
    const txt = await page.evaluate(() => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(3).id).textContent; });
    assert(txt.includes('普通段落，含加粗文字在这里和斜体'), `text after: ${txt}`);
    assert(!/\*\*\*\*|\*\* \*\*/.test(s1 + s2), `odd markers: ${s1} | ${s2}`);
    return `1st ⌘B: ${s1.slice(0, 40)} · 2nd ⌘B: ${s2.slice(0, 40)}`;
  });
  await step('⌘E with caret inside inline code toggles it off (text kept, backticks gone)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('inline code'), 'first', '普通段落');
    await B.caretAt('inline');
    await page.keyboard.press('ControlOrMeta+e');
    await B.settle(200);
    const s = (await B.source()).split('\n')[2];
    assert(s.includes('还有 inline code 与') && !s.includes('`'), s);
    await page.keyboard.type('Y');
    await B.settle(200);
    const s2 = (await B.source()).split('\n')[2];
    await B.esc();
    assert(s2.includes('inlineY code'), `caret after toggle-off: ${s2}`);
  });
  await step('⌘E with nothing selected then typing → text lands inside `…`, then → leaves it', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.type('npm i');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' 完成');
    await B.settle(300);
    const s = (await B.source()).split('\n')[4];
    await B.esc();
    assert(s.endsWith('退格合并。`npm i` 完成'), s);
  });

  // ------------------------------------------------------------ paste
  async function paste(data) {
    await page.evaluate((data) => {
      const dt = new DataTransfer();
      for (const [k, v] of Object.entries(data)) dt.setData(k, v);
      const el = document.activeElement;
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, data);
  }
  await step('paste multi-line plain text in a paragraph → lines joined by hard breaks, nothing lost', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await paste({ 'text/plain': '第一行\n第二行\r\n第三行 *星* `码` $5' });
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 8);
    await B.loadDoc(s);
    const txt = await page.evaluate(() => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(5).id).innerText; });
    assert(txt.includes('第三行 *星* `码` $5'), `rendered: ${txt}`);
    return JSON.stringify(seg);
  });
  await step('paste rich HTML (text/html + text/plain) → plain text only, no raw HTML in source', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await paste({ 'text/html': '<meta charset="utf-8"><b style="color:red">富文本</b><script>alert(1)</script><a href="https://x.com">链接</a><div>块</div>', 'text/plain': '富文本链接\n块' });
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 7);
    assert(!/<(b|script|a|div|meta)/.test(seg.join('\n')), `HTML leaked: ${JSON.stringify(seg)}`);
    return JSON.stringify(seg);
  });
  await step('paste multi-line text inside a code fence → real newlines in the fence', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('```js'), 'first', ' a = ');
    await B.joined('= 1;');
    await paste({ 'text/plain': '\nconst c = 3;\nconst d = 4;' });
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    assert(s.includes('```js\nconst a = 1;\nconst c = 3;\nconst d = 4;\nconst b = 2;\n```'), JSON.stringify(s.split('\n').slice(15, 22)));
  });
  await step('paste multi-line text inside a table cell → table stays one valid table', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('表头A'), 'first', '单元一');
    await B.caretAt('单元一');
    await paste({ 'text/plain': '甲\n乙' });
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(11, 15);
    assert(seg[2] && seg[2].startsWith('| 单元一') && seg[2].trim().endsWith('|') && seg[3] === '', `table: ${JSON.stringify(seg)}`);
    return JSON.stringify(seg);
  });

  // ------------------------------------------------------------ typing Markdown-significant characters literally
  const literals = [
    { name: 'asterisks', text: '*不是斜体*' },
    { name: 'underscores', text: '_不是强调_' },
    { name: 'backticks', text: '`不是代码`' },
    { name: 'dollars', text: '$x$ 与 $5' },
    { name: 'html tag', text: '<b>不是粗体</b>' },
    { name: 'brackets', text: '[不是](链接)' },
    { name: 'backslash', text: 'C:\\temp\\' },
    { name: 'pipe', text: 'a | b' },
    { name: 'tilde', text: '~~不是删除~~' },
    { name: 'entity', text: '&amp; &lt;' },
    { name: 'autolink-ish', text: '<https://x.com>' },
  ];
  for (const lit of literals) {
    await step(`typing literal ${lit.name} «${lit.text}» renders as the same literal text`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(L('第二段落'), 'first', '退格合并。');
      await B.caretAt('退格合并。');
      await page.keyboard.type(lit.text, { delay: 10 });
      await B.settle(250);
      await B.esc();
      const s = await B.source();
      await B.loadDoc(s);
      const txt = await page.evaluate(() => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(5).id).textContent; });
      assert(txt.includes('退格合并。' + lit.text), `rendered «${txt.trim()}» from source «${s.split('\n')[4]}»`);
      return `source «${s.split('\n')[4].slice(17)}»`;
    });
  }
  const starts = ['# ', '1. ', '- ', '> ', '+ ', '---', '```', '| a |', '    缩进'];
  for (const st of starts) {
    await step(`typing «${st}» at the START of a paragraph stays literal text (no block change)`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(L('第二段落'), 'first', '第二段落');
      await B.caretAt('第二段落', 'before');
      await page.keyboard.type(st, { delay: 10 });
      await B.settle(250);
      await B.esc();
      const s = await B.source();
      await B.loadDoc(s);
      const r = await page.evaluate(() => { const pv = window.__mdr.app.preview; const b = pv.blockAtLine(5); const el = pv.elementOfBlock(b.id); return { kind: b.kind, text: el.textContent, html: el.innerHTML.slice(0, 80) }; });
      assert(r.kind === 0 && r.text.replace(/\s+/g, ' ').includes((st + '第二段落').replace(/\s+/g, ' ').trim()), `kind ${r.kind} «${r.html}» src «${s.split('\n')[4]}»`);
      return `source «${s.split('\n')[4].slice(0, 16)}»`;
    });
  }

  // ------------------------------------------------------------ IME
  await step('IME multi-step pinyin composition (CDP) mid-bold: 0 writes while composing, exact text after', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('加粗文字'), 'first', '普通段落');
    await B.caretAt('加粗');
    const cdp = await context.newCDPSession(page);
    const v0 = await B.version();
    for (const t of ['z', 'zh', 'zho', 'zhon', 'zhong', 'zhong w', 'zhong we', 'zhong wen']) {
      await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(40);
    }
    await sleep(150);
    const vDuring = await B.version();
    await cdp.send('Input.insertText', { text: '中文' });
    await B.settle(250);
    // second composition, replaced once (candidate change)
    for (const t of ['s', 'sh', 'shu', 'shur']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(40); }
    await cdp.send('Input.imeSetComposition', { text: '输入', selectionStart: 2, selectionEnd: 2 });
    await sleep(40);
    await cdp.send('Input.insertText', { text: '输入' });
    await B.settle(250);
    const s = (await B.source()).split('\n')[2];
    const caretOk = await B.caretInEditing();
    await cdp.detach();
    await B.esc();
    eq(vDuring, v0, 'version during composition');
    assert(s.includes('**加粗中文输入文字在这里**'), s);
    assert(caretOk, 'caret lost after IME');
    return `${s.slice(0, 50)}`;
  });
  await step('IME composition then Enter to confirm then Enter → no stray newline/paragraph from the confirm key', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    const cdp = await context.newCDPSession(page);
    for (const t of ['h', 'ha', 'hao']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(30); }
    // confirming with Enter emits keydown isComposing=true (keyCode 229) then insertText
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send('Input.insertText', { text: 'hao' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await B.settle(300);
    const s = await B.source();
    await cdp.detach();
    await B.esc();
    const seg = s.split('\n').slice(4, 7);
    assert(seg[0] === '第二段落用于测试回车拆分和退格合并。hao' && seg[1] === '', JSON.stringify(seg));
  });

  // ------------------------------------------------------------ undo / redo
  await step('⌘Z / ⇧⌘Z inside a session: undo the last typing, redo it; source follows', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.type('undo test', { delay: 30 });
    await B.settle(300);
    const typed = (await B.source()).split('\n')[4];
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(300);
    const undone = (await B.source()).split('\n')[4];
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await B.settle(300);
    const redone = (await B.source()).split('\n')[4];
    const e = await B.editing();
    await B.esc();
    assert(typed.endsWith('undo test'), typed);
    eq(undone, '第二段落用于测试回车拆分和退格合并。', 'after ⌘Z');
    eq(redone, typed, 'after ⇧⌘Z');
    assert(e, 'session ended by undo/redo');
  });
  await step('⌘Z inside the session after an Enter split → undoes the split (report what happens)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await B.settle(400);
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(400);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    const seg = s.split('\n').slice(4, 8);
    note('⌘Z after an Enter split', `${JSON.stringify(seg)}; session ${e ? 'alive' : 'none'}`);
    assert(s.includes('第二段落用于测试回车拆分和退格合并。'), `split not undone: ${JSON.stringify(seg)}`);
  });
  await step('⌘Z after the session ended (preview mode, Esc) → undoes the preview edit', async () => {
    await B.loadDoc(DOC);
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(300);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.type('预览模式', { delay: 30 });
    await B.esc();
    const typed = await B.source();
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(300);
    const s = await B.source();
    const mode = await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.mode);
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(300);
    assert(typed.includes('预览模式'), 'typing missing');
    assert(!s.includes('预览模式'), `⌘Z after Esc in preview mode did nothing (mode ${mode})`);
    return `mode after ⌘Z: ${mode}`;
  });

  // ------------------------------------------------------------ selection across two blocks
  await step('drag-select across two blocks and type → neither block corrupted', async () => {
    await B.loadDoc(DOC);
    const a = await B.textPoint(L('加粗文字'), 'first', '斜体');
    const b = await B.textPoint(L('第二段落'), 'first', '回车');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    await sleep(100);
    const selInfo = await page.evaluate(() => { const s = getSelection(); return { text: s.toString().slice(0, 60), ed: !!document.querySelector('.is-editing') }; });
    await page.keyboard.type('Z');
    await B.settle(300);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    const out = s.split('\n').slice(2, 6);
    const lostA = !out.join('\n').includes('普通段落，含**加粗文字在这里**');
    assert(!lostA && s.includes('第二段落用于测试回车拆分和退格合并。'.slice(4)), `blocks corrupted: ${JSON.stringify(out)}`);
    return `selection «${selInfo.text}» session=${selInfo.ed}; after typing Z: ${JSON.stringify(out)}; editing=${!!e}`;
  });
  await step('shift+click extends a selection from an editing block into the next block, then Backspace → other block untouched', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('加粗文字'), 'first', '斜体');
    const b = await B.textPoint(L('第二段落'), 'first', '回车');
    await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
    await sleep(100);
    const sel = await page.evaluate(() => getSelection().toString().slice(0, 80));
    await page.keyboard.press('Backspace');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    const out = s.split('\n').slice(2, 6);
    assert(s.includes('第二段落用于测试回车拆分和退格合并。'), `second block changed: ${JSON.stringify(out)}`);
    return `selected «${sel}» → ${JSON.stringify(out)}`;
  });
  await step('⌘A inside a session then type → only the session block is replaced', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '回车');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('全选替换');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    const a = DOC.split('\n'), b = s.split('\n');
    assert(b.length === a.length && b[4] === '全选替换' && b.every((l, i) => i === 4 || l === a[i]), JSON.stringify(b.slice(0, 8)));
  });
  await step('select all text of a block and Backspace/Delete → block emptied; Esc removes it cleanly', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '回车');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await B.settle(300);
    const mid = await B.source();
    await B.esc();
    const s = await B.source();
    const t = await B.tiles();
    assert(t.ok, 'structure does not tile');
    return `during: ${mid === DOC ? 'unchanged (pending)' : 'changed'}; after Esc: ${JSON.stringify(s.split('\n').slice(2, 8))}`;
  });

  // ------------------------------------------------------------ lists and tables keys
  await step('list: Tab indents, Shift+Tab outdents; Enter on an empty item leaves the list', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('列表项一'), 'first', '列表项二');
    await B.caretAt('列表项二');
    await page.keyboard.press('Tab');
    await B.settle(200);
    const s1 = (await B.source()).split('\n').slice(6, 11);
    await page.keyboard.press('Shift+Tab');
    await B.settle(200);
    const s2 = (await B.source()).split('\n').slice(6, 11);
    await B.caretAt('任务项');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新任务');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('列表外段落');
    await B.settle(500);
    const s3 = (await B.source()).split('\n').slice(6, 16);
    await B.esc();
    assert(s1.join('\n').includes('- 列表项一\n  - 列表项二'), `Tab: ${JSON.stringify(s1)}`);
    assert(s2.join('\n').includes('- 列表项一\n- 列表项二'), `Shift+Tab: ${JSON.stringify(s2)}`);
    assert(s3.join('\n').includes('- [ ] 新任务') && s3.join('\n').includes('\n\n列表外段落'), `Enter: ${JSON.stringify(s3)}`);
    return JSON.stringify(s3);
  });
  await step('table: Enter is a no-op; Shift+Tab goes back a cell; typing in header cell keeps table', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('表头A'), 'first', '单元二');
    await B.caretAt('单元二');
    const v0 = await B.version();
    await page.keyboard.press('Enter');
    await B.settle(200);
    const v1 = await B.version();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('左');
    await B.settle(200);
    const s = (await B.source()).split('\n').slice(11, 15);
    await B.esc();
    eq(v1, v0, 'Enter in a table wrote');
    assert(s[2].includes('单元一左') && s[2].includes('单元二'), JSON.stringify(s));
  });
  await step('code: Tab inserts two spaces; Enter at the end of the last code line adds a line', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('```js'), 'first', ' b = ');
    await B.joined('= 2;');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('x();');
    await B.settle(300);
    const s = (await B.source()).split('\n').slice(15, 21);
    await B.esc();
    eq(s.join('\n'), '```js\nconst a = 1;\nconst b = 2;\n  x();\n```\n', 'fence');
  });

  // ------------------------------------------------------------ math click
  await step('click on an inline formula → TeX source editable; typing inside keeps $…$', async () => {
    const d = '公式 $a+b$ 结尾。\n';
    await B.loadDoc(d);
    const pt = await page.evaluate(() => { const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(1).id); const r = el.querySelector('.md-math').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(pt.x, pt.y);
    await sleep(150);
    await page.keyboard.type('+c');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    eq(s, '公式 $a+b+c$ 结尾。\n', 'source');
  });


  // ------------------------------------------------------------ more: collapsed-caret formatting, spaces, paragraphs paste
  for (const [key, want] of [['b', '**粗体**'], ['i', '*斜体*']]) {
    await step(`⌘${key.toUpperCase()} with a collapsed caret, then typing → formatted text (${want})`, async () => {
      await B.loadDoc(DOC);
      await B.clickLine(L('第二段落'), 'first', '退格合并。');
      await B.caretAt('退格合并。');
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await page.keyboard.type(want.replace(/\*/g, ''));
      await B.settle(300);
      const l = (await B.source()).split('\n')[4];
      await B.esc();
      assert(l.endsWith('退格合并。' + want), l);
    });
  }
  await step('⌘K with a collapsed caret → URL input → inserts a link whose text is the URL', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(100);
    await page.keyboard.type('https://c.example/');
    await page.keyboard.press('Enter');
    await B.settle(300);
    const l = (await B.source()).split('\n')[4];
    await page.keyboard.type('后');
    await B.settle(300);
    const l2 = (await B.source()).split('\n')[4];
    await B.esc();
    return `${l.slice(17)} → typing after: ${l2.slice(17)}`;
  });
  await step('typing two spaces between words / at the end → source readable (no &nbsp; noise)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.type('a  b end  ');
    await B.settle(300);
    const l = (await B.source()).split('\n').slice(4, 6);
    await B.esc();
    const fin = (await B.source()).split('\n').slice(4, 6);
    assert(!/&nbsp;/.test(fin.join('\n')), `source ${JSON.stringify(fin)}`);
    return `${JSON.stringify(l)} → after Esc ${JSON.stringify(fin)}`;
  });
  await step('paste plain text with blank-line paragraphs → paragraphs (not <br> runs)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await paste({ 'text/plain': '段一\n\n段二\n\n段三' });
    await B.settle(500);
    const s = await B.source();
    await B.esc();
    const seg = s.split('\n').slice(4, 11);
    await B.loadDoc(await B.source());
    const html = await page.evaluate(() => { const pv = window.__mdr.app.preview; return pv.elementOfBlock(pv.blockAtLine(5).id).innerHTML.replace(/\s(data-l|class)="[^"]*"/g, ''); });
    return `${JSON.stringify(seg)} → ${html.slice(0, 160)}`;
  });
  await step('shift+click into the next block while editing — what happens (report)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('加粗文字'), 'first', '斜体');
    const id1 = (await B.editing())?.id;
    const b = await B.textPoint(L('第二段落'), 'first', '回车');
    await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
    await sleep(150);
    const st = await page.evaluate(() => ({ sel: getSelection().toString().slice(0, 60), ce: [...document.querySelectorAll('[contenteditable="true"]')].map((e) => e.dataset.id + ':' + e.className), active: document.activeElement?.className, editing: document.querySelector('.is-editing')?.dataset.id }));
    note('shift+click', `session before ${id1}; after: ${JSON.stringify(st)}`);
    await B.esc();
  });
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
