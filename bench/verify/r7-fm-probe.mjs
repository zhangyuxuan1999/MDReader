// bench/verify/r7-fm-probe.mjs — fix-merge (round 7): what Chromium's bold / italic commands do to the style attributes
// of spans styled with the CSS font shorthand inside a session (the live DOM after the command, with the session's
// presentation stamps), and what the session writes. A probe for the P2 repair; prints, checks nothing.
// Run: MDR_PORT=<dev server> node bench/verify/r7-fm-probe.mjs [filter]   (T_MS, default 100000)
import { writeFileSync } from 'node:fs';
import { launch, openApp, load, source, clickAt, caret, esc, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 100000);
const P = (b) => `# P2\n\n${b}\n\nbelow para words\n`;
const CASES = [
  ['sh-unbold-part', P('前文 <span style="font: bold 16px serif">简写粗体 here</span> 后面 words'), '简写粗体', 0, 2, 'Meta+b'],
  ['sh-unbold-whole', P('前文 <span style="font: bold 16px serif">简写粗体</span> 后面 words'), '简写粗体', 0, 4, 'Meta+b'],
  ['sh-unitalic-part', P('前文 <span style="font: italic 15px serif">简写斜体 here</span> 后面 words'), '简写斜体', 0, 2, 'Meta+i'],
  ['sh-bold-plain-part', P('前文 <span style="font: 15px serif">简写正常 here</span> 后面 words'), '简写正常', 0, 2, 'Meta+b'],
  ['sh-italic-plain-part', P('前文 <span style="font: 15px serif">简写正常 here</span> 后面 words'), '简写正常', 0, 2, 'Meta+i'],
  ['sh-italic-bold-part', P('前文 <span style="font: bold 15px serif">简写粗体 here</span> 后面 words'), '简写粗体', 0, 2, 'Meta+i'],
  ['sh-unbold-italic-bold', P('前文 <span style="font: italic bold 15px serif">简写粗斜 here</span> 后面 words'), '简写粗斜', 0, 2, 'Meta+b'],
  ['sh-unitalic-italic-bold', P('前文 <span style="font: italic bold 15px serif">简写粗斜 here</span> 后面 words'), '简写粗斜', 0, 2, 'Meta+i'],
  ['sh-unbold-700', P('前文 <span style="font: 700 16px/1.5 serif; color: red">简写七百 here</span> 后面 words'), '简写七百', 0, 2, 'Meta+b'],
  ['lh-unbold-part', P('前文 <span style="font-weight: bold">粗体文字 here</span> 后面 words'), '粗体文字', 2, 2, 'Meta+b'],
  ['n1-bold-in-bold-parent', P('**粗 <span style="font: 15px serif">简写正常 here</span> 后** words'), '简写正常', 0, 2, 'Meta+b'],
  ['n2-unbold-in-bold-parent', P('**粗 <span style="font: bold 16px serif">简写粗体 here</span> 后** words'), '简写粗体', 0, 2, 'Meta+b'],
  ['n3-lh-unbold-in-bold-parent', P('**粗 <span style="font-weight: bold">粗体文字 here</span> 后** words'), '粗体文字', 0, 2, 'Meta+b'],
  ['n4-bold-light', P('前文 <span style="font: 300 15px serif">简写细体 here</span> 后面 words'), '简写细体', 0, 2, 'Meta+b'],
  ['n5-unbold-across', P('前文 <span style="font: bold 16px serif">甲乙</span><span style="font: bold 16px serif">丙丁</span> 后面 words'), '乙', 0, 1, 'Meta+b', ['丙', 1]],
  ['n6-unbold-whole-ib', P('前文 <span style="font: italic bold 15px serif">简写粗斜</span> 后面 words'), '简写粗斜', 0, 4, 'Meta+b'],
  ['n7-unitalic-whole', P('前文 <span style="font: italic 15px serif">简写斜体</span> 后面 words'), '简写斜体', 0, 4, 'Meta+i'],
  ['n8-bold-whole-plain', P('前文 <span style="font: 15px serif">简写正常</span> 后面 words'), '简写正常', 0, 4, 'Meta+b'],
  ['n10-sh-then-lh', P('前文 <span style="font: 16px serif; font-weight: bold">混合粗体 here</span> 后面 words'), '混合粗体', 0, 2, 'Meta+b'],
  ['n11-lh-normal-bold-part', P('前文 <span style="font-weight: normal">正常文字 here</span> 后面 words'), '正常文字', 0, 2, 'Meta+b'],
  ['n12-bold-across-plain', P('前文 <span style="font: 15px serif">甲乙</span><span style="font: 15px serif">丙丁</span> 后面 words'), '乙', 0, 1, 'Meta+b', ['丙', 1]],
  ['n13-in-italic-parent', P('*斜 <span style="font: 15px serif">简写正常 here</span> 后* words'), '简写正常', 0, 2, 'Meta+i'],
];
const FILTERED = CASES.filter((c) => filter.test(c[0]));
const json = [];   // with R7FM_JSON=<file>: per case { name, src (the paragraph), html (the session's <p> after the command), out }

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, doc, needle, off, len, k, to] of FILTERED) {
    await load(A, doc, name + '.md');
    const on = await clickAt(A, 'words', 0, 1);
    if (!on) { console.log(`${name}: NO SESSION`); continue; }
    await caret(A, needle, off, len);
    if (to) await A.page.evaluate(([n2, o2]) => {
      const s = getSelection(); const r = s.getRangeAt(0); const el = document.querySelector('.md-block.is-editing');
      const tw = document.createTreeWalker(el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.includes(n2)) { r.setEnd(n, n.data.indexOf(n2) + o2); break; }
      s.removeAllRanges(); s.addRange(r);
    }, to);
    const before = await A.page.evaluate(() => document.querySelector('.md-block.is-editing p').innerHTML);
    await A.page.keyboard.press(k);
    await sleep(250);
    const after = await A.page.evaluate(() => document.querySelector('.md-block.is-editing p').innerHTML);
    await esc(A);
    const out = await source(A);
    console.log(`${name}:\n  before ${before}\n  after  ${after}\n  source ${show(out.split('\n')[2])}`);
    json.push({ name, src: doc.split('\n')[2], html: after, out: out.split('\n')[2] });
  }
  if (process.env.R7FM_JSON) writeFileSync(process.env.R7FM_JSON, JSON.stringify(json, null, 1));
} finally { stop(); await browser?.close(); }
