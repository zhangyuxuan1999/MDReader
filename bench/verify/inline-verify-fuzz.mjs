// bench/verify/inline-verify-fuzz.mjs — verifier: random editing operations inside preview sessions; after each
// operation the source must not gain raw HTML / inline styles / &nbsp; noise and the structure must tile.
// Run: node bench/verify/inline-verify-fuzz.mjs [seed]   (own vite :5263, killed at exit)
import { startServer, stopServer, openBrowser, check, note, finish, sleep, measure } from './inline-verify-lib.mjs';

let seed = Number(process.argv[2] ?? 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const DOC = [
  '# 标题', '', '段落一含**粗体**、*斜体*、`代码`和[链接](https://a.com)，以及普通文字。', '',
  '- 项目一 **粗**', '- 项目二', '  - 嵌套', '- [ ] 任务', '', '> 引用里的 *文字*', '',
  '| 甲 | 乙 |', '|---|---|', '| 一 | 二 |', '', '段落二，English words here。', '',
].join('\n');
await startServer();
const B = await openBrowser();
const { page } = B;
const bad = [];
let ops = 0;
try {
  await B.boot('mode=split');
  await B.loadDoc(DOC);
  const orig = await B.source();
  for (let round = 0; round < 12; round++) {
    const lines = (await B.source()).split('\n');
    const cands = lines.map((l, i) => [l, i + 1]).filter(([l]) => /[一-龥]{2}/.test(l) && !/^\|[-: |]+\|$/.test(l));
    if (!cands.length) break;
    const [l, n] = pick(cands);
    const word = (l.match(/[一-龥]{2}/) ?? [])[0];
    try { await B.clickLine(n, 'first', word); } catch { continue; }
    if (!(await B.editing())) continue;
    for (let k = 0; k < 12; k++) {
      const op = pick(['type', 'type', 'bs', 'bs', 'del', 'sel', 'enter', 'senter', 'bold', 'italic', 'left', 'right', 'up', 'down', 'home', 'end', 'space2']);
      const label = op;
      switch (op) {
        case 'type': await page.keyboard.type(pick(['字', 'ab', ' ', '中文', 'x*y', '`', '$'])); break;
        case 'bs': await page.keyboard.press('Backspace'); break;
        case 'del': await page.keyboard.press('Delete'); break;
        case 'sel': await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.type('替'); break;
        case 'enter': await page.keyboard.press('Enter'); break;
        case 'senter': await page.keyboard.press('Shift+Enter'); break;
        case 'bold': await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('ControlOrMeta+b'); break;
        case 'italic': await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ControlOrMeta+i'); break;
        case 'left': await page.keyboard.press('ArrowLeft'); break;
        case 'right': await page.keyboard.press('ArrowRight'); break;
        case 'up': await page.keyboard.press('ArrowUp'); break;
        case 'down': await page.keyboard.press('ArrowDown'); break;
        case 'home': await page.keyboard.press('Home'); break;
        case 'end': await page.keyboard.press('End'); break;
        case 'space2': await page.keyboard.type('  '); break;
      }
      ops++;
      await sleep(60);
      const s = await B.source();
      const m = s.match(/style=|<span|<font|<div|<b>|<i>|<br>|&nbsp;|​|\uE00[0-3]/);
      if (m) { bad.push({ op: label, round, found: m[0], line: s.split('\n').find((x) => x.includes(m[0])) }); break; }
    }
    await B.esc();
    const t = await B.tiles();
    if (!t.ok) bad.push({ round, tiles: t });
  }
  measure('fuzz operations', ops, 'info', true);
  check('no raw HTML / style / &nbsp; / private-use chars leaked into the source', bad.length === 0, JSON.stringify(bad.slice(0, 6)));
  const fin = await B.source();
  note('final source', JSON.stringify(fin).slice(0, 600));
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
