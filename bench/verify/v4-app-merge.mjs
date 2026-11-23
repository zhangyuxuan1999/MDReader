// bench/verify/v4-app-merge.mjs — verify-app (0.2.0 stage 2d). H12 / U18 (c) variation: a block is emptied
// (⌘A-like selection + Backspace) whose two neighbours become ONE block once it is gone (two lists of the same
// type, two indented code blocks). The text typed next into the emptied element must be written at the deleted
// block's own place (between the two neighbours), and ⌘Z must give the document back byte for byte.
// Prints RESULT lines with the source after typing; `placed` is 'between' when the typed text stands
// between the neighbour texts in the source.
//   MDR_PORT=5436 node bench/verify/v4-app-merge.mjs [filter]
// Needs the renderer already listening (MDR_PORT may point at a renderer of an older snapshot too).
// Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
// [name, doc, needle in the block to empty, text before (neighbour above), text after (neighbour below)]
const CASES = [
  ['lists-around-quote', '- aaa\n\n> 乙引\n\n- zzz\n', '乙', 'aaa', 'zzz'],
  ['lists-around-para', '- aaa\n\n乙段落\n\n- zzz\n', '乙', 'aaa', 'zzz'],
  ['ordered-around-para', '1. aaa\n\n乙段落\n\n2. zzz\n', '乙', 'aaa', 'zzz'],
  ['lists-around-heading', '- aaa\n\n## 乙题\n\n- zzz\n', '乙', 'aaa', 'zzz'],
  ['tight-list-around-para', '- aaa\n- bbb\n\n乙段落\n\n- zzz\n- yyy\n', '乙', 'bbb', 'zzz'],
  ['indented-code-around-para', '    aaa code\n\n乙段落\n\n    zzz code\n', '乙', 'aaa', 'zzz'],
  ['tasks-around-para', '- [ ] aaa\n\n乙段落\n\n- [ ] zzz\n', '乙', 'aaa', 'zzz'],
  ['control-paras', 'aaa\n\n乙段落\n\nzzz\n', '乙', 'aaa', 'zzz'],
  ['control-diff-markers', '- aaa\n\n乙段落\n\n* zzz\n', '乙', 'aaa', 'zzz'],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, needle, above, below] of CASES) {
    for (const act of ['typeQ', 'enterQ']) {
      const k = `${name} ${act}`;
      if (only && !k.startsWith(only)) continue;
      try {
        await page.keyboard.press('Escape');
        await B.loadDoc(doc);
        await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
        await sleep(600);
        const line = doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
        await B.clickLine(line, 'first', needle);
        await sleep(120);
        await page.evaluate(() => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await page.keyboard.press('Backspace');
        await B.settle(300);
        const deleted = await B.source();
        if (act === 'enterQ') { await page.keyboard.press('Enter'); await sleep(60); }
        await page.keyboard.type('Q');
        await B.settle(400);
        const src = await B.source();
        const iA = src.indexOf(above), iQ = src.indexOf('Q'), iZ = src.indexOf(below);
        const placed = iQ < 0 ? 'missing' : iA < iQ && iQ < iZ ? 'between' : iQ > iZ ? 'after-below' : 'before-above';
        const shownBefore = await page.evaluate(() => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const all = document.querySelector('.mdr-preview').textContent;
          return el ? { editingText: el.textContent.trim(), qBeforeZ: all.indexOf('Q') < all.lastIndexOf('zzz') } : null;
        });
        await page.keyboard.press('Escape'); await B.settle(300);
        const all = await page.evaluate(() => document.querySelector('.mdr-preview').textContent);
        const shownAfterEsc = all.indexOf('Q') >= 0 && all.indexOf('Q') < all.indexOf('zzz') ? 'Q before zzz' : 'Q after zzz or missing';
        // undo back to the original
        for (let i = 0; i < 4 && (await B.source()) !== doc; i++) { await page.keyboard.press('ControlOrMeta+z'); await B.settle(250); }
        out(k, { deleted, src, placed, duringSession: shownBefore, shownAfterEsc, undoBack: (await B.source()) === doc });
      } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
