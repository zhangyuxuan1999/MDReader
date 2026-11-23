// bench/verify/v7-vf-docs.mjs — verify-refs (round 6): sessions in documents as people write them (Chinese prose with
// em-space references, padded tables, soft hyphens, Persian with ZWNJ and direction marks, a changelog of bare URLs with
// percent-escapes, a README with badges). Per case: click a block, run the steps, Esc, read the source. Checks:
//   raw   — no character that is not plainly visible is added raw beyond what the steps put in (the guard's class);
//   refs  — no character reference / percent-escape of the source is lost outside the deleted text;
//   exact — where the case names the expected source, it is that byte for byte;
//   guard — the write guard's console lines (expected 0).
// Run: MDR_PORT=<dev or built server with hooks> node bench/verify/v7-vf-docs.mjs [filter]   (T_MS, default 110000)
// Writes nothing into the tree.
import { launch, openApp, load, source, toasts, clickAt, run, esc, rawAdded, refCounts, pctCounts, lostKeys, strDiff, show, shown, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const NBSP = C(0xa0), IDSP = C(0x3000);

const ZH = '# 春日随笔\n\n&emsp;&emsp;春天来了，万物复苏。我们一起去公园散步，看见了很多花。\n\n第二段没有缩进，但句中有全角空格&#x3000;和不换行空格&nbsp;两种写法，还有一个软连字符：Donau&shy;dampf&shy;schiff。\n\n- 第一项&emsp;说明\n- 第二项&ensp;说明\n- 第三项&#8194;说明\n\n> 引用里也有&emsp;全角空格\n> 第二行&zwnj;文字\n';
const TABLE = '# 库存\n\n| 名称 | 数量&nbsp;个 | 备注 |\n| --- | ---: | --- |\n| 苹果&ensp;红 | &nbsp;12 | 新鲜&emsp;好吃 |\n| 香蕉 | 3&thinsp;000 | 进口&#x2009;货 |\n\n表后的段落。\n';
const SHY = '# Wörter\n\nDie Donau&shy;dampf&shy;schiff&shy;fahrts&shy;gesell&shy;schaft ist ein langes Wort, und Rind&shy;fleisch&shy;etikettierung auch.\n\nZweiter Absatz mit Kon&shy;sti&shy;tu&shy;tion.\n';
const FA = '# فارسی\n\nمن می&zwnj;خواهم به خانه بروم. این یک جمله&zwnj;ی فارسی است.\n\n&rlm;سلام دنیا&lrm; (English) text&rlm;. پایان\n\nکتاب&#x200C;ها و نامه&#8204;ها\n';
const CL = '# Changelog\n\n## 1.2.0\n\n- 修复 https://example.com/docs/%E4%B8%AD%E6%96%87/intro 的链接\n- See https://example.com/a%E2%80%8Bb/c and <https://example.com/x%C2%A0y> too\n- Fixed https://example.com/path%E3%80%80with%E3%80%80spaces (#12)\n- Reported in https://github.com/org/repo/issues/12%E2%80%8E by someone\n\n## 1.1.0\n\nDownload <https://dl.example.com/v1.1%E2%80%AE/app.zip> here.\n';
const BADGE = '# Project\n\n[![Build](https://img.shields.io/badge/build-passing-green.svg "Build&nbsp;status")](https://ci.example.com/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE "MIT&#x2009;license") [![npm](https://img.shields.io/npm/v/pkg.svg)](https://www.npmjs.com/package/pkg) Version two\n\nA tool&#x2009;—&#x2009;for things. See the [docs](https://example.com/docs "Read&nbsp;the&nbsp;docs") today.\n\n![Logo&shy;type](logo.png "The&#x2009;logo") caption text\n';

// [name, doc, click needle, steps, expected source (null: invariants only), deleted text (references allowed to go)]
const CASES = [
  ['zh-indent-type', ZH, '万物复苏', ['caret:很多花', 'type:Ж'], ZH.replace('很多花', '很多花Ж')],
  ['zh-p2-type', ZH, '两种写法', ['caret:两种写法', 'type:Ж'], ZH.replace('两种写法', '两种写法Ж')],
  ['zh-p2-del', ZH, '两种写法', ['caret:两种写法', 'press:Backspace', 'press:Backspace'], ZH.replace('两种写法', '两种')],
  ['zh-p2-bold', ZH, '两种写法', ['caret:全角空格§0§4', 'press:Meta+b'], ZH.replace('全角空格&', '**全角空格**&')],
  ['zh-p2-paste', ZH, '两种写法', ['caret:还有', `paste:粘贴${NBSP}文字${IDSP}末`], null],
  ['zh-p2-ime', ZH, '两种写法', ['caret:软连字符', 'ime:z,zh,zho,zhon,zhong|中文'], ZH.replace('软连字符', '软连字符中文')],
  ['zh-shy-mid', ZH, '两种写法', ['caret:dampf§0', 'type:Ж'], ZH.replace('&shy;dampf', '&shy;Жdampf')],
  ['zh-list-type', ZH, '第二项', ['caret:第二项', 'type:Ж'], ZH.replace('第二项', '第二项Ж')],
  ['zh-list-join-bs', ZH, '第二项', ['caret:第二项§0', 'press:Backspace'], null],
  ['zh-list-join-del', ZH, '第一项', ['caret:第一项', 'press:End', 'press:Delete'], null],
  ['zh-list-enter', ZH, '第一项', ['caret:第一项', 'press:Enter', 'type:新项'], null],
  ['zh-list-undo', ZH, '第三项', ['caret:第三项', 'type:ЖЖ', 'wait:700', 'press:Meta+z', 'wait:300', 'press:Meta+Shift+z', 'wait:300', 'type:Я'], null],
  ['zh-quote-type', ZH, '第二行', ['caret:第二行', 'type:Ж'], ZH.replace('第二行', '第二行Ж')],
  ['zh-quote-join', ZH, '第二行', ['caret:第二行§0', 'press:Backspace'], null],
  ['zh-p2-to-p1-merge', ZH, '两种写法', ['caret:第二段§0', 'press:Backspace'], null],
  ['tab-cell-type', TABLE, '新鲜', ['caret:好吃', 'type:Ж'], TABLE.replace('好吃', '好吃Ж')],
  ['tab-cell-ensp', TABLE, '苹果', ['caret:苹果', 'type:Ж'], TABLE.replace('苹果', '苹果Ж')],
  ['tab-cell-thin', TABLE, '进口', ['caret:进口', 'type:Ж'], TABLE.replace('进口', '进口Ж')],
  ['tab-head-type', TABLE, '备注', ['caret:备注', 'type:Ж'], TABLE.replace('备注', '备注Ж')],
  ['tab-cell-del', TABLE, '香蕉', ['caret:香蕉', 'press:Backspace'], TABLE.replace('香蕉', '香')],
  ['tab-cell-bold', TABLE, '香蕉', ['caret:香蕉§0§2', 'press:Meta+b'], TABLE.replace('香蕉', '**香蕉**')],
  ['tab-cell-paste', TABLE, '香蕉', ['caret:香蕉', `paste:a${NBSP}b`], null],
  ['shy-type', SHY, 'langes', ['caret:langes', 'type:Ж'], SHY.replace('langes', 'langesЖ')],
  ['shy-in-word', SHY, 'langes', ['caret:schiff§3', 'type:Ж'], SHY.replace('schiff', 'schЖiff')],
  ['shy-del-shy', SHY, 'langes', ['caret:dampf', 'press:Delete', 'type:Ж'], null, '&shy;'],
  ['shy-italic', SHY, 'langes', ['caret:langes§0§6', 'press:Meta+i'], SHY.replace('langes', '*langes*')],
  ['shy-merge', SHY, 'Zweiter', ['caret:Zweiter§0', 'press:Backspace'], null],
  ['fa-type', FA, 'فارسی است', ['caret:است', 'type:Ж'], FA.replace('است', 'استЖ')],
  ['fa-zwnj-mid', FA, 'فارسی است', ['caret:خواهم', 'type:Ж'], FA.replace('خواهم', 'خواهمЖ')],
  ['fa-marks-type', FA, 'English', ['caret:English', 'type:Ж'], FA.replace('English', 'EnglishЖ')],
  ['fa-marks-del', FA, 'English', ['caret:text', 'press:Backspace'], FA.replace('text&rlm;', 'tex&rlm;')],
  ['fa-merge', FA, 'English', ['caret:سلام§0', 'press:Backspace'], null],
  ['fa-p3-type', FA, 'کتاب', ['caret:کتاب', 'type:Ж'], FA.replace('کتاب', 'کتابЖ')],
  ['fa-p3-ime', FA, 'کتاب', ['caret:کتاب', `ime:م|م${C(0x200c)}ی`], null],
  ['cl-item-type', CL, '的链接', ['caret:的链接', 'type:Ж'], CL.replace('的链接', '的链接Ж')],
  ['cl-item2-type', CL, 'too', ['caret:too', 'type:Ж'], CL.replace('too', 'tooЖ')],
  ['cl-item3-type', CL, '(#12)', ['caret:(#12)', 'type:Ж'], CL.replace('(#12)', '(#12)Ж')],
  ['cl-item4-type', CL, 'by someone', ['caret:someone', 'type:Ж'], CL.replace('someone', 'someoneЖ')],
  ['cl-autolink-p', CL, 'here', ['caret:here', 'type:Ж'], CL.replace('here.', 'here.').replace(' here', ' hereЖ')],
  ['cl-items-join', CL, 'Fixed', ['caret:Fixed§0', 'press:Backspace'], null],
  ['cl-items-enter', CL, 'See', ['caret:too', 'press:Enter', 'type:new item'], null],
  ['cl-items-bold', CL, 'Fixed', ['caret:Fixed§0§5', 'press:Meta+b'], CL.replace('Fixed', '**Fixed**')],
  ['badge-type', BADGE, 'Version two', ['caret:Version two', 'type:Ж'], BADGE.replace('Version two', 'Version twoЖ')],
  ['badge-p2-type', BADGE, 'for things', ['caret:today', 'type:Ж'], BADGE.replace('today', 'todayЖ')],
  ['badge-p2-bold', BADGE, 'for things', ['caret:things§0§6', 'press:Meta+b'], BADGE.replace('things.', '**things**.')],
  ['badge-p2-linktext', BADGE, 'for things', ['caret:docs', 'type:Ж'], BADGE.replace('[docs]', '[docsЖ]')],
  ['badge-img-caption', BADGE, 'caption', ['caret:caption text', 'type:Ж'], BADGE.replace('caption text', 'caption textЖ')],
  ['badge-merge', BADGE, 'for things', ['caret:A tool§0', 'press:Backspace'], null],
].filter((c) => filter.test(c[0]));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
const tally = { ok: 0, bad: 0, refused: 0, nosession: 0 };
try {
  browser = await launch();
  const A = await openApp(browser, port, process.env.MDR_USER ? { perf: false, stored: '1' } : { perf: true });
  if (A.user) console.log('real-user mode: no ?perf=1, mdr.previewEdit=1 stored, switch ' + (await A.page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'))));
  for (const [name, doc, needle, steps, want, deleted] of CASES) {
    A.guard.length = 0;
    await load(A, doc, name + '.md');
    const t0 = await toasts(A);
    const view0 = await shown(A);
    const started = await clickAt(A, needle, 0, 1);
    if (!started) {
      const tt = (await toasts(A)) - t0;
      const out = await source(A);
      const tag = tt ? 'REFUSED' : 'NOSESSION';
      if (tt) tally.refused++; else tally.nosession++;
      console.log(`${tag.padEnd(9)} ${name}: toast=${tt} guard=${A.guard.length} unchanged=${out === doc}`);
      continue;
    }
    let typed = '';
    let err = null;
    try { typed = await run(A, steps); } catch (e) { err = String(e.message || e); }
    await sleep(300);
    await esc(A);
    const out = await source(A);
    const tt = (await toasts(A)) - t0;
    const d = strDiff(doc, out);
    const added = rawAdded(doc, out, typed);
    const delRefs = deleted ? refCounts(deleted) : new Map();
    const refLost = lostKeys(refCounts(doc), refCounts(out)).filter((k) => !(deleted && [...delRefs.keys()].some((c) => k.startsWith('U+' + c.codePointAt(0).toString(16).toUpperCase()))));
    const pctLost = lostKeys(pctCounts(doc), pctCounts(out));
    const exact = want == null ? null : out === want;
    const view1 = await shown(A);
    const viewSame = view1.split('Ж').join('').split('Я').join('') === view0;
    const bad = added.length || refLost.length || pctLost.length || exact === false || A.guard.length || err;
    if (bad) tally.bad++; else tally.ok++;
    console.log(`${bad ? 'BAD' : 'ok'}`.padEnd(9) + ` ${name}: raw+=${added.join(',') || '-'} refsLost=${refLost.join(',') || '-'} pctLost=${pctLost.join(',') || '-'} exact=${exact} guard=${A.guard.length} toast=${tt} view=${viewSame ? 'same' : 'differs'}${err ? ' ERR ' + err : ''}`);
    if (bad || process.env.VERBOSE) console.log(`          diff at ${d.at}: del=${show(d.del)} ins=${show(d.ins)}${exact === false ? '\n          want ' + show(strDiff(doc, want).ins) : ''}`);
    if (!viewSame && process.env.VERBOSE) console.log('          view0 ' + show(view0) + '\n          view1 ' + show(view1));
  }
  console.log(`RESULT ok=${tally.ok} bad=${tally.bad} refused=${tally.refused} nosession=${tally.nosession} of ${CASES.length}`);
} finally { stop(); await browser?.close(); }
