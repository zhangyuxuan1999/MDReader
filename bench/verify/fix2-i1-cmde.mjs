// bench/verify/fix2-i1-cmde.mjs — fix-session-1: repeats inline-verify-editing's "⌘E with caret inside inline
// code toggles it off, then typing" N times on MDR_PORT (needs a renderer there), with timing variants.
import { openBrowser, check, sleep, finish, ensureServer } from './v2-app-lib.mjs';
await ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser();
const { page } = B;
const DOC = ['# 文档标题', '', '普通段落，含**加粗文字在这里**和*斜体*，还有 `inline code` 与[链接](https://a.example.com)。', '', '第二段落用于测试回车拆分和退格合并。', ''].join('\n');
try {
  await B.boot('mode=split');
  for (let i = 0; i < Number(process.env.N ?? 6); i++) {
    await B.loadDoc(DOC);
    await B.clickLine(3, 'first', '普通段落');
    await B.caretAt('inline');
    await page.keyboard.press('ControlOrMeta+e');
    await B.settle(200);
    const s = (await B.source()).split('\n')[2];
    const st = await page.evaluate(() => ({ ed: document.querySelector('.mdr-preview .is-editing')?.textContent.slice(0, 20) ?? null, act: document.activeElement?.className ?? '' }));
    await page.keyboard.type('Y');
    await B.settle(200);
    const s2 = (await B.source()).split('\n')[2];
    await B.esc();
    check(`run ${i}: toggle-off then Y at the caret`, s2.includes('inlineY code') && !s.includes('`'), JSON.stringify({ s, s2, st }));
  }
} finally { finish(); clearTimeout(KILL); await B.browser.close().catch(() => {}); }
