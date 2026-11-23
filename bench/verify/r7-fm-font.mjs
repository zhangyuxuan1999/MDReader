// bench/verify/r7-fm-font.mjs — fix-merge (0.2.1, fix round 7): P2 (CONTRACT §11, Round-7 decisions; VF-2 of
// docs/FINDINGS-0.2.0-r6.md) in Chromium. The session's bold / italic commands (⌘B / ⌘I, and the toolbar's) on part of,
// the whole of, and across spans styled with the CSS font shorthand (with and without a weight and a style word, a line
// height, a colour, a longhand after the shorthand, inside bold or italic text) and on longhand spans (round 6's cases).
// Checks per case: (1) the source written is the expected one, byte for byte (the shorthand's own word edited, never
// expanded; a record the command did not change left alone); (2) what the screen showed at Esc (per character: computed
// weight, style, colour) is what the source renders after Esc; (3) no style property appears that the source did not have;
// (4) the guard's console lines.
// Run: MDR_PORT=<dev server> node bench/verify/r7-fm-font.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, clickAt, caret, esc, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const P = (b) => `# P2\n\n${b}\n\nbelow para words\n`;
const sp = (style, text) => `<span style="${style}">${text}</span>`;
// [name, paragraph, needle, offset, length, key, end of the selection (needle, offset) or null, the paragraph written]
const CASES = [
  ['sh-unbold-part', `前文 ${sp('font: bold 16px serif', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, `前文 ${sp('font: 16px serif', '简写')}${sp('font: bold 16px serif', '粗体 here')} 后面 words`],
  ['sh-unbold-whole', `前文 ${sp('font: bold 16px serif', '简写粗体')} 后面 words`, '简写粗体', 0, 4, 'Meta+b', null, `前文 ${sp('font: 16px serif', '简写粗体')} 后面 words`],
  ['sh-unitalic-part', `前文 ${sp('font: italic 15px serif', '简写斜体 here')} 后面 words`, '简写斜体', 0, 2, 'Meta+i', null, `前文 ${sp('font: 15px serif', '简写')}${sp('font: italic 15px serif', '斜体 here')} 后面 words`],
  ['sh-unitalic-whole', `前文 ${sp('font: italic 15px serif', '简写斜体')} 后面 words`, '简写斜体', 0, 4, 'Meta+i', null, `前文 ${sp('font: 15px serif', '简写斜体')} 后面 words`],
  ['sh-unitalic-toolbar', `前文 ${sp('font: italic 15px serif', '简写斜体 here')} 后面 words`, '简写斜体', 0, 2, 'toolbar:edit.italic', null, `前文 ${sp('font: 15px serif', '简写')}${sp('font: italic 15px serif', '斜体 here')} 后面 words`],
  ['sh-bold-plain-part', `前文 ${sp('font: 15px serif', '简写正常 here')} 后面 words`, '简写正常', 0, 2, 'Meta+b', null, `前文 ${sp('font: 15px serif', '**简写**')}${sp('font: 15px serif', '正常 here')} 后面 words`],
  ['sh-bold-plain-whole', `前文 ${sp('font: 15px serif', '简写正常')} 后面 words`, '简写正常', 0, 4, 'Meta+b', null, `前文 ${sp('font: 15px serif', '**简写正常**')} 后面 words`],
  ['sh-bold-plain-toolbar', `前文 ${sp('font: 15px serif', '简写正常 here')} 后面 words`, '简写正常', 0, 2, 'toolbar:edit.bold', null, `前文 ${sp('font: 15px serif', '**简写**')}${sp('font: 15px serif', '正常 here')} 后面 words`],
  ['sh-italic-plain-part', `前文 ${sp('font: 15px serif', '简写正常 here')} 后面 words`, '简写正常', 0, 2, 'Meta+i', null, `前文 ${sp('font: 15px serif', '*简写*')}${sp('font: 15px serif', '正常 here')} 后面 words`],
  ['sh-italic-on-bold-part', `前文 ${sp('font: bold 15px serif', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+i', null, `前文 ${sp('font: bold 15px serif', '*简写*')}${sp('font: bold 15px serif', '粗体 here')} 后面 words`],
  ['sh-bold-on-italic-part', `前文 ${sp('font: italic 15px serif', '简写斜体 here')} 后面 words`, '简写斜体', 0, 2, 'Meta+b', null, `前文 ${sp('font: italic 15px serif', '**简写**')}${sp('font: italic 15px serif', '斜体 here')} 后面 words`],
  ['sh-both-unbold-part', `前文 ${sp('font: italic bold 15px serif', '简写粗斜 here')} 后面 words`, '简写粗斜', 0, 2, 'Meta+b', null, `前文 ${sp('font: italic 15px serif', '简写')}${sp('font: italic bold 15px serif', '粗斜 here')} 后面 words`],
  ['sh-both-unitalic-part', `前文 ${sp('font: italic bold 15px serif', '简写粗斜 here')} 后面 words`, '简写粗斜', 0, 2, 'Meta+i', null, `前文 ${sp('font: bold 15px serif', '简写')}${sp('font: italic bold 15px serif', '粗斜 here')} 后面 words`],
  ['sh-both-unbold-whole', `前文 ${sp('font: italic bold 15px serif', '简写粗斜')} 后面 words`, '简写粗斜', 0, 4, 'Meta+b', null, `前文 ${sp('font: italic 15px serif', '简写粗斜')} 后面 words`],
  ['sh-700-lh-color', `前文 ${sp('font: 700 16px/1.5 serif; color: red', '简写七百 here')} 后面 words`, '简写七百', 0, 2, 'Meta+b', null, `前文 ${sp('font: 16px/1.5 serif; color: red', '简写')}${sp('font: 700 16px/1.5 serif; color: red', '七百 here')} 后面 words`],
  ['sh-light-bold-part', `前文 ${sp('font: 300 15px serif', '简写细体 here')} 后面 words`, '简写细体', 0, 2, 'Meta+b', null, `前文 ${sp('font: 15px serif', '**简写**')}${sp('font: 300 15px serif', '细体 here')} 后面 words`],
  ['sh-then-longhand', `前文 ${sp('font: 16px serif; font-weight: bold', '混合粗体 here')} 后面 words`, '混合粗体', 0, 2, 'Meta+b', null, `前文 ${sp('font: 16px serif', '混合')}${sp('font: 16px serif; font-weight: bold', '粗体 here')} 后面 words`],
  ['sh-unbold-across', `前文 ${sp('font: bold 16px serif', '甲乙')}${sp('font: bold 16px serif', '丙丁')} 后面 words`, '乙', 0, 1, 'Meta+b', ['丙', 1], `前文 ${sp('font: bold 16px serif', '甲')}${sp('font: 16px serif', '乙')}${sp('font: 16px serif', '丙')}${sp('font: bold 16px serif', '丁')} 后面 words`],
  ['sh-bold-across', `前文 ${sp('font: 15px serif', '甲乙')}${sp('font: 15px serif', '丙丁')} 后面 words`, '乙', 0, 1, 'Meta+b', ['丙', 1], `前文 ${sp('font: 15px serif', '甲')}**${sp('font: bold 15px serif', '乙')}${sp('font: bold 15px serif', '丙')}**${sp('font: 15px serif', '丁')} 后面 words`],
  ['sh-bold-in-bold-text', `**粗 ${sp('font: 15px serif', '简写正常 here')} 后** words`, '简写正常', 0, 2, 'Meta+b', null, `**粗 ${sp('font: bold 15px serif', '简写')}${sp('font: 15px serif', '正常 here')} 后** words`],
  ['sh-unbold-in-bold-text', `**粗 ${sp('font: bold 16px serif', '简写粗体 here')} 后** words`, '简写粗体', 0, 2, 'Meta+b', null, `**粗** ${sp('font: 16px serif', '简写')}${sp('font: bold 16px serif', '粗体 here')} **后** words`],
  ['sh-italic-in-italic-text', `*斜 ${sp('font: 15px serif', '简写正常 here')} 后* words`, '简写正常', 0, 2, 'Meta+i', null, `*斜 ${sp('font: italic 15px serif', '简写')}${sp('font: 15px serif', '正常 here')} 后* words`],
  ['sh-no-space-semicolon', `前文 ${sp('font:bold 16px serif;', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, `前文 ${sp('font:16px serif;', '简写')}${sp('font:bold 16px serif;', '粗体 here')} 后面 words`],
  ['sh-in-list-item', null, '简写粗体', 0, 2, 'Meta+b', null, null],
  // longhand spans: round 6's results
  ['lh-unbold-part', `前文 ${sp('font-weight: bold', '粗体文字 here')} 后面 words`, '粗体文字', 2, 2, 'Meta+b', null, `前文 ${sp('font-weight: bold', '粗体')}<span>文字</span> ${sp('font-weight: bold', 'here')} 后面 words`],
  ['lh-unbold-whole', `前文 ${sp('font-weight: 700', '整段粗体')} 后面 words`, '整段粗体', 0, 4, 'Meta+b', null, '前文 <span>整段粗体</span> 后面 words'],
  ['lh-unitalic-part-color', `前文 ${sp('font-style: italic; color: red', '斜体红字 here')} 后面 words`, '斜体红字', 2, 2, 'Meta+i', null, `前文 ${sp('font-style: italic; color: red', '斜体')}${sp('color: red;', '红字')} ${sp('font-style: italic; color: red', 'here')} 后面 words`],
  ['lh-bold-in-color', `前文 ${sp('color: blue', '蓝色文字 here')} 后面 words`, '蓝色文字', 2, 2, 'Meta+b', null, `前文 ${sp('color: blue', '蓝色**文字** here')} 后面 words`],
  ['lh-unbold-in-bold-text', `**粗 ${sp('font-weight: bold', '粗体文字 here')} 后** words`, '粗体文字', 0, 2, 'Meta+b', null, `**粗** <span>粗体</span>${sp('font-weight: bold', '文字 here')} **后** words`],
  ['lh-normal-bold-part', `前文 ${sp('font-weight: normal', '正常文字 here')} 后面 words`, '正常文字', 0, 2, 'Meta+b', null, `前文 ${sp('font-weight: normal', '**正常**')}${sp('font-weight: normal', '文字 here')} 后面 words`],
];
const LIST = `- 项目 ${sp('font: bold 16px serif', '简写粗体 here')} words\n- 第二项`;
CASES[CASES.findIndex((c) => c[0] === 'sh-in-list-item')] = ['sh-in-list-item', LIST, '简写粗体', 0, 2, 'Meta+b', null, `- 项目 ${sp('font: 16px serif', '简写')}${sp('font: bold 16px serif', '粗体 here')} words\n- 第二项`];
const FILTERED = CASES.filter((c) => filter.test(c[0]));

/** Per character of the block (text order): computed weight / style / colour. A weight of 600 or more is "B": the app's
 *  stylesheet gives strong (what ** renders) 600 where the session shows Chromium's b at 700 (as in v7-vf-m3); lighter
 *  weights are compared as numbers. */
const look = (A, editingBlock) => A.page.evaluate((editingBlock) => {
  const root = window.__mdr.app.preview.el;
  const el = editingBlock ? root.querySelector('.md-block.is-editing') : root.querySelectorAll('.md-block')[1];
  if (!el) return null;
  const out = [];
  const tw = document.createTreeWalker(el, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const cs = getComputedStyle(n.parentElement);
    const w = Number(cs.fontWeight) >= 600 ? 'B' : cs.fontWeight;
    for (const c of n.data) if (c.trim() && c.codePointAt(0) !== 0x200b) out.push(c + w + cs.fontStyle + cs.color.replace(/\s/g, ''));
  }
  return out.join('|');
}, editingBlock);
const props = (s) => new Set([...s.matchAll(/style="([^"]*)"/g)].flatMap((m) => m[1].split(';').map((d) => d.split(':')[0].trim()).filter(Boolean)));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, para, needle, off, len, key, to, want] of FILTERED) {
    A.guard.length = 0;
    const doc = P(para);
    await load(A, doc, name + '.md');
    const on = await clickAt(A, 'words', 0, 1);
    let err = null, seen = null;
    if (on) {
      try {
        if (!(await caret(A, needle, off, len))) throw new Error('caret ' + needle);
        if (to) await A.page.evaluate(([n2, o2]) => {
          const s = getSelection(); const r = s.getRangeAt(0); const el = document.querySelector('.md-block.is-editing');
          const tw = document.createTreeWalker(el, 4);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.data.includes(n2)) { r.setEnd(n, n.data.indexOf(n2) + o2); break; }
          s.removeAllRanges(); s.addRange(r);
        }, to);
        if (key.startsWith('toolbar:')) await A.page.click(`[data-cmd="${key.slice(8)}"]`); else await A.page.keyboard.press(key);
        await sleep(300);
        seen = await look(A, true);
      } catch (e) { err = String(e.message || e); }
    }
    await esc(A);
    await sleep(300);
    const out = await source(A);
    const after = await look(A, false);
    const written = out.split('\n# P2\n')[0].replace(/^# P2\n\n/, '').split('\n\nbelow para words')[0];
    const invented = [...props(out)].filter((p) => !props(doc).has(p));
    const exact = written === want;
    const ok = on && !err && exact && seen === after && invented.length === 0 && !A.guard.length;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${name}: session=${on} exact=${exact} look=${seen === after} invented=${invented.join(',') || '-'} guard=${A.guard.length}${err ? ' ERR ' + err : ''}`);
    if (!exact || process.env.VERBOSE) console.log('    wrote ' + show(written) + '\n    want  ' + show(want));
    if (seen !== after) console.log('    seen  ' + seen + '\n    after ' + after);
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
