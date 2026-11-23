// bench/verify/v7-vf-seq.mjs — verify-refs (round 6): several sessions one after the other in ONE document that holds
// hidden characters in most blocks (Chinese prose indented with &emsp;&emsp;, a list with &ensp; / &#8194;, a quote with
// &zwnj;, German soft hyphens, Persian with ZWNJ and direction marks, a changelog of bare URLs and autolinks with
// percent-escapes, README badges with titles holding references). Each session types a marker after a word (one also
// bolds a word, one pastes); after all of them the source must be the original with exactly those changes, byte for byte
// (where a block holds two spellings of one character, R6CR-2 respells the second: allowed and reported), with no raw
// character that is not plainly visible added and the guard silent.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-seq.mjs [rounds=2]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, paste, esc, rawAdded, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const ROUNDS = Number(process.argv[2] ?? 2);
const T_MS = Number(process.env.T_MS ?? 110000);
const DOC = [
  '# 春日随笔', '',
  '&emsp;&emsp;春天来了，万物复苏。我们一起去公园散步，看见了很多花。', '',
  '- 第一项&emsp;说明', '- 第二项&ensp;说明', '- 第三项&ensp;说明', '',
  '> 引用里也有&emsp;全角空格', '> 第二行&zwnj;文字', '',
  'Die Donau&shy;dampf&shy;schiff&shy;fahrt ist ein langes Wort.', '',
  'من می&zwnj;خواهم به خانه بروم. این یک جمله&zwnj;ی فارسی است.', '',
  '- 修复 https://example.com/docs/%E4%B8%AD%E6%96%87/intro 的链接', '- See <https://example.com/x%C2%A0y> too', '- Fixed https://example.com/path%E3%80%80gap (#12)', '',
  '[![Build](https://img.shields.io/badge/b.svg "Build&nbsp;status")](https://ci.example.com/) Version two', '',
  'A tool&#x2009;—&#x2009;for things. See the [docs](https://example.com/docs "Read&nbsp;the&nbsp;docs") today.', '',
].join('\n');
// [click needle, caret needle, action]
const STEPS = [
  ['万物复苏', '很多花', 'type'], ['第二项', '第二项', 'type'], ['第二行', '引用里也有', 'type'], ['langes', 'langes', 'type'],
  ['فارسی', 'خانه', 'type'], ['的链接', '的链接', 'type'], ['too', 'too', 'type'], ['(#12)', '(#12)', 'paste'],
  ['Version', 'Version two', 'type'], ['for things', 'things', 'bold'],
];

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, process.env.MDR_USER ? { perf: false, stored: '1' } : { perf: true });   // MDR_USER=1: a real user (no ?perf=1, the switch stored on)
  for (let round = 0; round < ROUNDS; round++) {
    A.guard.length = 0;
    await load(A, DOC, 'seq.md');
    const t0 = await toasts(A);
    let want = DOC, typed = '', notes = [];
    for (let i = 0; i < STEPS.length; i++) {
      const [cn, at, act] = STEPS[i];
      const m = `Ж${i}`;
      const on = await clickAt(A, cn, 0, 1);
      if (!on) { notes.push(`${i}:no-session`); continue; }
      if (act === 'bold') {
        await caret(A, at, 0, at.length); await A.page.keyboard.press('Meta+b');
        const k = want.indexOf(at + '.'); want = want.slice(0, k) + '**' + at + '**' + want.slice(k + at.length);
      } else {
        await caret(A, at);
        if (act === 'paste') await paste(A, m); else await A.page.keyboard.type(m);
        typed += m;
        const k = want.indexOf(at) + at.length; want = want.slice(0, k) + m + want.slice(k);
      }
      await sleep(250);
      await esc(A);
    }
    const out = await source(A);
    const added = rawAdded(DOC, out, typed);
    const respelled = out.replace(/&ensp;说明Ж1/, '').length; void respelled;
    const exact = out === want;
    const tt = (await toasts(A)) - t0;
    if (!exact || added.length || A.guard.length || tt) bad++;
    console.log(`round ${round}: exact=${exact} raw+=${added.join(',') || '-'} guard=${A.guard.length} toast=${tt} ${notes.join(' ')}`);
    if (!exact) {
      const ol = out.split('\n'), wl = want.split('\n');
      for (let j = 0; j < Math.max(ol.length, wl.length); j++) if (ol[j] !== wl[j]) console.log(`   line ${j}: got ${show(ol[j] ?? '')} want ${show(wl[j] ?? '')}`);
    }
  }
  console.log(`RESULT bad=${bad} of ${ROUNDS}`);
} finally { stop(); await browser?.close(); }
