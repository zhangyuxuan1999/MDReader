// bench/verify/v4-app-dirty.mjs — verify-app (0.2.0 stage 2d). False dirty flags from sessions that change
// nothing: click + Esc, arrows/Home/End + Esc, a word selection + Esc, ⌘A ⌘A, ⌘C, a click into each block kind
// (incl. U21 spacer paragraphs, tables, code, math, task lists) + Esc, a click on a formula (TeX source) + Esc.
// The title must stay clean and the editor version unchanged. Prints RESULT lines.
//   MDR_PORT=5436 node bench/verify/v4-app-dirty.mjs
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const DOC = [
  '# 标题 heading', '', '普通段落 para text。', '', '$a+b$ 开头公式段落', '', '- [ ] 任务 task one', '- [x] 任务 task two', '',
  '| 表头 h1 | 表头 h2 |', '| --- | --- |', '| 单元 c1 | 单元 c2 |', '', '```js', 'const code = 1;', '```', '', '$$', 'x^2', '$$', '',
  `图片段 ![p](${GIF}) 后文`, '', '> 引用 quote text', '',
].join('\n');
const L = (needle) => DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
const state = () => page.evaluate(() => ({ title: document.title, version: window.__mdr.version(), src: window.__mdr.app.getText() }));
try {
  await B.boot('mode=split');
  await B.loadDoc(DOC, 'dirty.md');
  await sleep(600);
  const v0 = await state();
  out('loaded', { title: v0.title });
  const cases = [
    ['para click+Esc', 'para', async () => {}],
    ['para arrows+Home/End+Esc', 'para', async () => { for (const k of ['ArrowRight', 'ArrowLeft', 'End', 'Home', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(k); }],
    ['para word selection+Esc', 'para', async () => { await B.selectText('para'); }],
    ['para Cmd-A Cmd-A', 'para', async () => { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+a'); }],
    ['para Cmd-C', 'para', async () => { await B.selectText('para'); await page.keyboard.press('ControlOrMeta+c'); }],
    ['formula-start click+Esc', '开头公式', async () => {}],
    ['formula-start Home+End+Esc', '开头公式', async () => { await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('ControlOrMeta+ArrowLeft'); }],
    ['task click+Esc', 'task one', async () => {}],
    ['table click+Tab+Esc', 'c1', async () => { await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); }],
    ['code click+Esc', 'const', async () => {}],
    ['image para click+arrows+Esc', '图片段', async () => { for (const k of ['End', 'ArrowLeft', 'ArrowLeft', 'Home']) await page.keyboard.press(k); }],
    ['quote click+Esc', 'quote', async () => {}],
    ['heading click+Esc', 'heading', async () => {}],
  ];
  for (const [name, needle, fn] of cases) {
    try {
      await page.keyboard.press('Escape'); await sleep(150);
      await B.clickLine(L(needle), 'first', needle);
      await sleep(200);
      const s = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
      await fn();
      await sleep(150);
      await page.keyboard.press('Escape');
      await B.settle(400);
      const st = await state();
      out(name, { session: s, title: st.title, versionSame: st.version === v0.version, srcSame: st.src === v0.src });
    } catch (e) { out(name, `ERROR ${String(e.message).split('\n')[0]}`); }
  }
  // a click on the block formula (its TeX source opens) and Esc
  try {
    await page.keyboard.press('Escape');
    await B.mountLine(L('x^2'));
    const pt = await page.evaluate(() => { const r = document.querySelector('.mdr-preview .katex-display, .mdr-preview .md-math--block')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
    await page.mouse.click(pt.x, pt.y); await sleep(300); await page.keyboard.press('Escape'); await B.settle(400);
    const st = await state();
    out('math block click+Esc', { title: st.title, versionSame: st.version === v0.version, srcSame: st.src === v0.src });
  } catch (e) { out('math block click+Esc', `ERROR ${String(e.message).split('\n')[0]}`); }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
