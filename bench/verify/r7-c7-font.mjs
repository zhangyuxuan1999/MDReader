// bench/verify/r7-c7-font.mjs — challenge-7 (round 7): attacks P2 (the CSS font shorthand is edited, not expanded) with forms
// bench/verify/r7-fm-font.mjs does not have: quoted and several families, upper case, !important, four words before the
// size, oblique with an angle, the word normal, bolder, 600, a command repeated (toggle back), undone (⌘Z in the session),
// inside italic text, a system font and var(). The runner is r7-fm-font's (switch ON, ⌘B / ⌘I on a part or the whole);
// a case without an expected source (null) is judged by: no font longhand written (font-family / -size / -variant ...),
// what the screen showed at Esc equals what the source renders, no invented style property, no guard line.
// Run: MDR_PORT=5465 node bench/verify/r7-c7-font.mjs [filter]   (T_MS, default 110000). Writes nothing in the tree.
import { launch, openApp, load, source, clickAt, caret, esc, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const P = (b) => `# P2\n\n${b}\n\nbelow para words\n`;
const sp = (style, text) => `<span style="${style}">${text}</span>`;
// [name, paragraph, needle, offset, length, key, end of the selection (needle, offset) or null, the paragraph written]
const CASES = [
  ['c7-families-quoted', `前文 ${sp('font: bold 16px &quot;Times New Roman&quot;, serif', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, null],
  ['c7-families-single', `前文 ${sp("font: bold 16px 'Times New Roman', serif", '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, `前文 ${sp("font: 16px 'Times New Roman', serif", '简写')}${sp("font: bold 16px 'Times New Roman', serif", '粗体 here')} 后面 words`],
  ['c7-upper', `前文 ${sp('FONT: BOLD 16PX SERIF', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, null],
  ['c7-important', `前文 ${sp('font: bold 16px serif !important', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, 'Meta+b', null, null],
  ['c7-four-words', `前文 ${sp('font: italic small-caps bold 16px/2 Georgia, serif', '四词斜体 here')} 后面 words`, '四词斜体', 0, 2, 'Meta+i', null, `前文 ${sp('font: small-caps bold 16px/2 Georgia, serif', '四词')}${sp('font: italic small-caps bold 16px/2 Georgia, serif', '斜体 here')} 后面 words`],
  ['c7-oblique-angle', `前文 ${sp('font: oblique 10deg 16px serif', '倾斜文字 here')} 后面 words`, '倾斜文字', 0, 2, 'Meta+i', null, `前文 ${sp('font: 16px serif', '倾斜')}${sp('font: oblique 10deg 16px serif', '文字 here')} 后面 words`],
  ['c7-normal-word-bold', `前文 ${sp('font: normal 16px serif', '正常文字 here')} 后面 words`, '正常文字', 0, 2, 'Meta+b', null, null],
  ['c7-bolder', `前文 ${sp('font: bolder 16px serif', '更粗文字 here')} 后面 words`, '更粗文字', 0, 2, 'Meta+b', null, null],
  ['c7-600', `前文 ${sp('font: 600 15px serif', '半粗文字 here')} 后面 words`, '半粗文字', 0, 2, 'Meta+b', null, null],
  ['c7-repeat-toggle', `前文 ${sp('font: bold 16px serif', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, ['Meta+b', 'Meta+b'], null, null],
  ['c7-undo', `前文 ${sp('font: bold 16px serif', '简写粗体 here')} 后面 words`, '简写粗体', 0, 2, ['Meta+b', 'Meta+z'], null, `前文 ${sp('font: bold 16px serif', '简写粗体 here')} 后面 words`],
  ['c7-bold-whole-toggle', `前文 ${sp('font: 15px serif', '简写正常')} 后面 words`, '简写正常', 0, 4, ['Meta+b', 'Meta+b'], null, null],
  ['c7-whole-quotes-color', `前文 ${sp("font: bold 1em/1.2 'A', serif; color: red", '整段粗体')} 后面 words`, '整段粗体', 0, 4, 'Meta+b', null, `前文 ${sp("font: 1em/1.2 'A', serif; color: red", '整段粗体')} 后面 words`],
  ['c7-unitalic-in-italic-text', `*斜 ${sp('font: italic 15px serif', '简写斜体 here')} 后* words`, '简写斜体', 0, 2, 'Meta+i', null, null],
  ['c7-system-font', `前文 ${sp('font: caption', '系统字体 here')} 后面 words`, '系统字体', 0, 2, 'Meta+b', null, null],
  ['c7-var', `前文 ${sp('font: bold var(--x, 16px) serif', '变量字体 here')} 后面 words`, '变量字体', 0, 2, 'Meta+b', null, null],
];
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
        for (const k of [].concat(key)) { if (k.startsWith('toolbar:')) await A.page.click(`[data-cmd="${k.slice(8)}"]`); else await A.page.keyboard.press(k); await sleep(200); }
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
    const longhands = (written.match(/font-(?:family|size|variant|stretch|kerning|optical|feature|variation|synthesis|size-adjust|language)/g) || []).length;
    const exact = want === null ? longhands === 0 : written === want;
    const ok = on && !err && exact && seen === after && invented.length === 0 && !A.guard.length;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${name}: session=${on} exact=${exact} look=${seen === after} invented=${invented.join(',') || '-'} guard=${A.guard.length}${err ? ' ERR ' + err : ''}`);
    if (!exact || want === null || process.env.VERBOSE) console.log('    wrote ' + show(written) + '\n    want  ' + show(want));
    if (seen !== after) console.log('    seen  ' + seen + '\n    after ' + after);
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
