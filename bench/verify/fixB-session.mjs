// bench/verify/fixB-session.mjs — real-Chrome checks for the 0.2.0 fix round of the in-preview editing
// session (fixer-B; CONTRACT §11 decisions U1, U3–U6; findings high 2, high 3, medium 4, 5, 6, 7 and the
// paste low item of docs/FINDINGS-inline-r1.md).
// Run: MDR_PORT=5272 node bench/verify/fixB-session.mjs   (starts / stops its own vite on that port)
import { startServer, stopServer, openBrowser, check, note, step, assert, eq, finish, sleep } from './inline-verify-lib.mjs';

const killer = setTimeout(() => { console.log('FAIL  global timeout (6 min)'); try { stopServer(); } catch { /* */ } process.exit(2); }, 6 * 60_000);

const DOC = [
  '# 文档标题',                                   // 1
  '',
  '普通段落，含**加粗**文字。',                    // 3
  '',
  '第二段落用于测试回车拆分和退格合并。',            // 5
  '',
  '```js',                                        // 7
  'const a = 1;',
  'const b = 2;',
  '```',
  '',
  '尾段落。',                                      // 12
  '',
].join('\n');
const L = (needle, d = DOC) => d.split('\n').findIndex((l) => l.includes(needle)) + 1;

await startServer();
const B = await openBrowser();
const { page, context } = B;

async function paste(text) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}
/** Waits (polling, ≤ 600 ms) until the resume capture element holds the focus: the split was written and
 *  the new session does not exist yet. True when the window was caught. */
async function waitForWindow() {
  const t0 = Date.now();
  while (Date.now() - t0 < 600) {
    if (await page.evaluate(() => !!document.activeElement?.classList.contains('mdr-preview__edit-capture'))) return true;
  }
  return false;
}
const styledOrHtml = (s) => /<a[\s>]|style=|<span|<font|<code/.test(s);

try {
  await B.boot('mode=split');

  // ------------------------------------------------------------ B1 / U6
  await step('B1: paste multi-line text inside a code fence → every newline kept', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('```js'), 'first', ' a = ');
    await B.joined('= 1;');
    await paste('\nconst c = 3;\nconst d = 4;');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    assert(s.includes('```js\nconst a = 1;\nconst c = 3;\nconst d = 4;\nconst b = 2;\n```'), JSON.stringify(s.split('\n').slice(6, 13)));
  });
  await step('B1: paste lines at the very end of the last code line → lines appended, fence intact', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('```js'), 'first', ' b = ');
    await B.joined('= 2;');
    await paste('\nx();\ny();');
    await B.settle(300);
    const s = await B.source();
    await B.esc();
    assert(s.includes('```js\nconst a = 1;\nconst b = 2;\nx();\ny();\n```\n'), JSON.stringify(s.split('\n').slice(6, 13)));
  });

  // ------------------------------------------------------------ B2 / U5
  await step('B2: ⌘K with a collapsed caret → no raw HTML / style in the source, link DOM without style, typing goes after it', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(100);
    await page.keyboard.type('https://c.example/');
    await page.keyboard.press('Enter');
    await B.settle(250);
    const dom = await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const a = el?.querySelector('a[href="https://c.example/"]');
      return { a: !!a, style: a?.getAttribute('style') ?? null, text: a?.textContent ?? null, styled: [...(el?.querySelectorAll('[style]') ?? [])].filter((e) => !e.hasAttribute('data-mdr-o')).length };
    });
    await page.keyboard.type('后');
    await B.settle(300);
    const l = (await B.source()).split('\n')[4];
    const after = await page.evaluate(() => { const a = document.querySelector('.mdr-preview .is-editing a[href="https://c.example/"]'); return a ? { text: a.textContent, next: a.nextSibling?.textContent ?? '' } : null; });
    await B.esc();
    assert(dom.a && dom.style === null && dom.styled === 0, `link DOM ${JSON.stringify(dom)}`);
    assert(!styledOrHtml(l), `source line has markup: ${l}`);
    assert(l.startsWith('第二段落用于测试回车拆分和退格合并。') && l.includes('https://c.example/') && l.endsWith('后'), l);
    assert(after && after.text === 'https://c.example/' && after.next.startsWith('后'), `typed text went into the link: ${JSON.stringify(after)}`);
    // How it renders back is the serializer's spelling of the link (bare URL + 后 → linkify takes 后 along).
    await B.loadDoc(await B.source());
    const back = await page.evaluate(() => { const pv = window.__mdr.app.preview; const a = pv.elementOfBlock(pv.blockAtLine(5).id).querySelector('a'); return a ? { href: a.getAttribute('href'), text: a.textContent } : null; });
    note('B2 re-render of the written source', `source «${l.slice(18)}» → link ${JSON.stringify(back)}${back && back.text !== 'https://c.example/' ? '  (serializer: bare autolink followed by 后 — reported to fixer-C)' : ''}`);
    return `source «${l.slice(18)}»`;
  });
  await step('B2: ⌘K on a selection still links the selected text (no style)', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.selectText('退格');
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(100);
    await page.keyboard.type('https://d.example/');
    await page.keyboard.press('Enter');
    await B.settle(300);
    const l = (await B.source()).split('\n')[4];
    await B.esc();
    eq(l, '第二段落用于测试回车拆分和[退格](https://d.example/)合并。', 'line 5');
  });

  // ------------------------------------------------------------ B6 / U5
  await step('B6: ⌘E with nothing selected → typing lands inside `…`, → leaves it', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.type('npm i');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' 完成');
    await B.settle(300);
    const l = (await B.source()).split('\n')[4];
    await B.esc();
    eq(l, '第二段落用于测试回车拆分和退格合并。`npm i` 完成', 'line 5');
  });
  await step('B6: ⌘E, type, ⌘E again leaves the code; ⌘E twice without typing leaves nothing', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.type('ls');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.type('后');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.press('ControlOrMeta+e');
    await page.keyboard.type('尾');
    await B.settle(300);
    const l = (await B.source()).split('\n')[4];
    await B.esc();
    eq(l, '第二段落用于测试回车拆分和退格合并。`ls`后尾', 'line 5');
  });

  // ------------------------------------------------------------ B3 / U4
  await step('B3: x, Enter, then 0 ms apart y, Backspace, z and CJK committed without a keydown → all in the new paragraph, in order', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    const inWindow = await waitForWindow();
    const cdp = await context.newCDPSession(page);
    await page.keyboard.type('y');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('z');
    await cdp.send('Input.insertText', { text: '中文' });
    const stillWaiting = await page.evaluate(() => !document.querySelector('.mdr-preview .is-editing'));
    await cdp.detach();
    await B.settle(500);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    note('B3 window', `capture caught: ${inWindow}; keys sent before the session resumed: ${stillWaiting}`);
    assert(s.includes('第二段落用于测试回车x\n\nz中文拆分和退格合并。\n'), JSON.stringify(s.split('\n').slice(4, 8)));
    assert(e && e.text.includes('z中文拆分'), `session on ${e && e.text}`);
  });
  await step('B3: Enter ×3 quickly with typing in between → 4 paragraphs, all text at the right place', async () => {
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
    assert(s.includes('第二\n\nA\n\nB\n\nC段落用于测试回车拆分和退格合并。'), JSON.stringify(s.split('\n').slice(4, 12)));
  });
  for (const [what, body, needle, want] of [
    ['a paragraph', '紧跟的段落文字。', '段落', '紧跟的段落y文字。'],
    ['a table', '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |', '1', '| 1y |'],
  ]) {
    await step(`B3: first edit of a heading directly followed by ${what}: x then Backspace ≤ 1 frame later, then y → nothing lost`, async () => {
      const d = `## 标题\n${body}\n\n尾段\n`;
      await B.loadDoc(d);
      await B.clickLine(1, 'first', needle);
      await B.caretAt(needle);
      await page.keyboard.type('x');
      await sleep(16);
      await page.keyboard.press('Backspace');
      await B.settle(400);
      await page.keyboard.type('y');
      await B.settle(400);
      const s = await B.source();
      await B.esc();
      assert(!s.includes('x') && s.includes(want), JSON.stringify(s));
      return JSON.stringify(s.split('\n').slice(0, 5));
    });
  }

  // ------------------------------------------------------------ B4 / U3
  await step('B4: Backspace at the very start of a paragraph merges it into the paragraph before (caret at the join)', async () => {
    const d = '第一段文字。\n\n第二段文字。\n\n尾。\n';
    await B.loadDoc(d);
    await B.clickLine(3, 'first', '第二段');
    await B.caretAt('第二段', 'before');
    await page.keyboard.press('Backspace');
    await B.settle(400);
    const s1 = await B.source();
    await page.keyboard.type('|');
    await B.settle(300);
    const s2 = await B.source();
    await B.esc();
    eq(s1, '第一段文字。第二段文字。\n\n尾。\n', 'after Backspace');
    eq(s2, '第一段文字。|第二段文字。\n\n尾。\n', 'typing at the join');
  });
  await step('B4: accidental Enter then immediate Backspace → back to one paragraph', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await sleep(30);
    await page.keyboard.press('Backspace');
    await B.settle(500);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    assert(s === DOC, `after Enter+Backspace: ${JSON.stringify(s.split('\n').slice(4, 8))}`);
    assert(e, 'no session after the merge');
  });
  await step('B4: accidental Enter, pause, Backspace at the start of the split-off block → merged back', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await B.settle(400);
    await page.keyboard.press('Backspace');
    await B.settle(400);
    const s = await B.source();
    await page.keyboard.type('#');
    await B.settle(300);
    const s2 = await B.source();
    await B.esc();
    assert(s === DOC, JSON.stringify(s.split('\n').slice(4, 8)));
    assert(s2.includes('第二段落用于测试回车#拆分和退格合并。'), `typing after the merge: ${JSON.stringify(s2.split('\n')[4])}`);
  });
  await step('B4: Backspace at the start of a paragraph under a heading does nothing (other combinations unchanged)', async () => {
    const d = '# 标题\n\n段落文字。\n';
    await B.loadDoc(d);
    await B.clickLine(3, 'first', '段落');
    await B.caretAt('段落', 'before');
    await page.keyboard.press('Backspace');
    await B.settle(300);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    eq(s, d, 'source');
    assert(e, 'session ended');
  });

  // ------------------------------------------------------------ B5 / U1
  await step('B5: ⌘Z / ⇧⌘Z inside a session undo / redo the typing burst through the source; session stays', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await page.keyboard.type('undo test', { delay: 30 });
    await B.settle(300);
    const typed = (await B.source()).split('\n')[4];
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(400);
    const undone = (await B.source()).split('\n')[4];
    const e1 = await B.editing();
    const off1 = await B.caretOffset();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await B.settle(400);
    const redone = (await B.source()).split('\n')[4];
    const e2 = await B.editing();
    await page.keyboard.type('!');
    await B.settle(300);
    const after = (await B.source()).split('\n')[4];
    await B.esc();
    assert(typed.endsWith('undo test'), typed);
    eq(undone, '第二段落用于测试回车拆分和退格合并。', 'after ⌘Z');
    eq(redone, typed, 'after ⇧⌘Z');
    assert(e1 && e2, 'session ended by undo/redo');
    eq(after, typed + '!', 'typing after redo lands at the step\'s end');
    return `caret after ⌘Z at offset ${off1}`;
  });
  await step('B5: ⌘Z right after an Enter split merges the blocks back; the session continues in the merged block', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '第二段落');
    await B.caretAt('回车');
    await page.keyboard.press('Enter');
    await B.settle(400);
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(400);
    const s = await B.source();
    const e = await B.editing();
    await page.keyboard.type('@');
    await B.settle(300);
    const s2 = await B.source();
    await B.esc();
    eq(s, DOC, 'after ⌘Z');
    assert(e && e.text.includes('第二段落用于测试回车拆分和退格合并。'), `session on ${e && e.text}`);
    assert(s2.split('\n')[4].includes('@'), `typing after ⌘Z: ${s2.split('\n')[4]}`);
    return `typed at: ${s2.split('\n')[4]}`;
  });
  await step('B5: ⌘Z back to non-canonical source (`_em_`, `|---|`) → source restored exactly, session resumes', async () => {
    const d = '有 _强调_ 的段落。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    await B.loadDoc(d);
    await B.clickLine(1, 'first', '的段落');
    await B.caretAt('的段落');
    await page.keyboard.type('Q');
    await B.settle(300);
    const typed = await B.source();
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(500);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    assert(typed.includes('Q'), 'typing missing');
    eq(s, d, 'after ⌘Z');
    assert(e, 'no session after ⌘Z to a non-canonical block');
  });
  await step('B5: ⌘Z with nothing to undo does nothing; the session stays', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('尾段落'), 'first', '尾段落');
    const e0 = await B.editing();
    await page.keyboard.press('ControlOrMeta+z');
    await B.settle(300);
    const e1 = await B.editing();
    const s = await B.source();
    await B.esc();
    eq(s, DOC, 'source');
    assert(e0 && e1 && e0.id === e1.id, 'session changed');
  });

  // ------------------------------------------------------------ B7 (paste low item)
  await step('B7: paste paragraphs separated by blank lines → paragraphs, no line holding only "  "', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(L('第二段落'), 'first', '退格合并。');
    await B.caretAt('退格合并。');
    await paste('段一\n\n段二\n\n段三');
    await B.settle(500);
    const s = await B.source();
    const e = await B.editing();
    await B.esc();
    assert(s.includes('第二段落用于测试回车拆分和退格合并。段一\n\n段二\n\n段三\n'), JSON.stringify(s.split('\n').slice(4, 11)));
    assert(!/^[ \t]+$/m.test(s), 'a whitespace-only line');
    assert(e && e.text.includes('段三'), `session on ${e && e.text}`);
  });

  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
  clearTimeout(killer);
}
finish();
