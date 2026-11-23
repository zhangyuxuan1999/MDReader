// bench/verify/v4-app-zw.mjs — verify-app (0.2.0 stage 2d). U21's spacer (U+200B before a line-leading inline
// formula, inserted when a session begins) against the clipboard: what a copy from inside a session puts on
// the clipboard, and what pasting that into the editor pane writes into the source.
// Prints RESULT lines; `zwPlain` / `zwSource` count U+200B / U+FEFF characters.
//   Candidate:  MDR_PORT=5436 node bench/verify/v4-app-zw.mjs [filter]
//   Baseline:   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-zw.mjs [filter]   (no session: same gestures)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page, context } = B;
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const ZWC = [0x200b, 0xfeff];
const countZw = (s) => [...(s ?? '')].filter((c) => ZWC.includes(c.charCodeAt(0))).length;
const BS = String.fromCharCode(92);
const CASES = [
  ['para-start', '$c+d$ 开头是公式的段落', '开头是'],
  ['list-start', '- $x$ 列表项文字\n- 第二项', '列表项'],
  ['after-hardbreak', `第一行文字${BS}\n$y$ 第二行文字`, '第二行'],
  ['table-cell', '| 甲 | 乙 |\n| --- | --- |\n| $z$ 单元 | 其他 |', '单元'],
  ['heading-start', '## $h$ 标题文字', '标题文'],
];
const clip = () => page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const r = {};
  for (const it of items) for (const ty of it.types) r[ty] = await (await it.getType(ty)).text();
  return { plain: r['text/plain'] ?? null, html: r['text/html'] ?? '' };
});
try {
  await B.boot('mode=split');
  out('shim', await shimBaseline(page));
  for (const [name, body, needle] of CASES) {
    for (const how of ['triple', 'cmdA', 'shiftEnd', 'drag']) {
      const k = `${name} ${how}`;
      if (only && !k.startsWith(only)) continue;
      try {
        const doc = `前面的段落。\n\n${body}\n\n后面的段落。\n`;
        await page.keyboard.press('Escape');
        await B.loadDoc(doc);
        await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
        const line = doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
        const pt = await B.textPoint(line, 'first', needle);
        await page.mouse.click(pt.x, pt.y); await sleep(250);
        const session = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
        if (how === 'triple') {
          await page.mouse.click(pt.x, pt.y, { clickCount: 2 }); await page.mouse.click(pt.x, pt.y, { clickCount: 3 }); await sleep(200);
        } else if (how === 'cmdA') {
          await page.keyboard.press('ControlOrMeta+a'); await sleep(150);
        } else if (how === 'drag') {
          // drag from the left edge of the line that holds the formula to the end of its text (inside the session)
          const r = await page.evaluate((needle) => {
            const pv = document.querySelector('.mdr-preview');
            const w = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              const i = n.data.indexOf(needle); if (i < 0) continue;
              const rg = document.createRange(); rg.setStart(n, n.data.length - 1); rg.setEnd(n, n.data.length);
              const end = rg.getBoundingClientRect();
              const host = n.parentElement.closest('p, li, td, th, h1, h2, h3, h4, h5, h6');
              const hb = host.getBoundingClientRect();
              return { x0: hb.left + 1, y: end.top + end.height / 2, x1: end.right + 2 };
            }
            return null;
          }, needle);
          await page.mouse.move(r.x0, r.y); await page.mouse.down(); await page.mouse.move(r.x1, r.y, { steps: 6 }); await page.mouse.up(); await sleep(200);
        } else {
          await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await sleep(150);
        }
        const selZw = await page.evaluate((ZWC) => [...getSelection().toString()].filter((c) => ZWC.includes(c.charCodeAt(0))).length, ZWC);
        await page.keyboard.press('ControlOrMeta+c'); await sleep(200);
        const c = await clip();
        // paste the clipboard at the end of the editor pane
        await page.keyboard.press('Escape'); await B.settle(200);
        const before = await B.source();
        await page.click('.cm-content'); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('ControlOrMeta+v'); await B.settle(300);
        const after = await B.source();
        out(k, { session, selZw, zwPlain: countZw(c.plain), zwHtml: countZw(c.html), plainHead: (c.plain ?? '').slice(0, 14), zwSource: countZw(after) - countZw(before), srcUnchangedBeforePaste: before === doc });
      } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
