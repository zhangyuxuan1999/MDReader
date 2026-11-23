// bench/verify/v4-app-probe.mjs — verify-app (0.2.0 stage 2d): triple-click inside a session on a line that
// starts with an inline formula, with and without the U21 spacer, and with the formula in mid-line.
//   MDR_PORT=5436 node bench/verify/v4-app-probe.mjs          (candidate)
//   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-probe.mjs (0.1.1: no session, same gesture)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
try {
  await B.boot('mode=split');
  await shimBaseline(page);
  for (const [name, body, needle, strip] of [
    ['start', '$c+d$ 开头是公式的段落', '开头是', false],
    ['start-nospacer', '$c+d$ 开头是公式的段落', '开头是', true],
    ['middle', '文字 $c+d$ 中间有公式', '中间有', false],
    ['end', '结尾有公式 $c+d$', '结尾有', false],
    ['bold', '文字 **加粗部分** 中间有粗体', '中间有', false],
    ['link', '文字 [链接文字](https://example.com) 中间有链接', '中间有', false],
    ['code', '文字 `code span` 中间有代码', '中间有', false],
    ['image', '文字 ![alt](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==) 中间有图片', '中间有', false],
    ['two-formulas', '甲 $a$ 乙 $b$ 丙丙丙', '丙丙', false],
    ['list-formula', '- 项目 $q$ 之后的文字', '之后的', false],
  ]) {
    const doc = `前面的段落。\n\n${body}\n\n后面的段落。\n`;
    await page.keyboard.press('Escape');
    await B.loadDoc(doc);
    const line = 3;
    const pt = await B.textPoint(line, 'first', needle);
    await page.mouse.click(pt.x, pt.y); await sleep(250);
    const session = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
    if (strip && session) {
      await page.evaluate(() => {
        const el = document.querySelector('.mdr-preview .is-editing');
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const kill = [];
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data === String.fromCharCode(0x200b)) kill.push(n);
        kill.forEach((n) => n.remove());
      });
    }
    await page.mouse.click(pt.x, pt.y, { clickCount: 2 }); await page.mouse.click(pt.x, pt.y, { clickCount: 3 }); await sleep(200);
    const sel = await page.evaluate(() => getSelection().toString().replace(/\n/g, '|'));
    out(name, { session, sel });
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  console.log('BASE', BASE);
}
