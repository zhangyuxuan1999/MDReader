// bench/verify/r7-c7-merge.mjs — challenge-7 (round 7): attacks P1 (a Backspace merge into a block a session may not edit is
// refused: nothing written, the toast, the session stays) beyond bench/verify/r7-fm-merge.mjs: more kinds above (a heading
// with raw HTML, a list whose last item has raw HTML, a block the sanitizer cannot take, a quote with raw HTML), a HEADING
// below as well as a paragraph, and the key pressed once, twice and six times in a row ("held"), then typing Ж, then Esc or
// a click on another block. Switch ON. Checks: the document's only change is the typed Ж (anywhere inside the lower block's
// text); no part of the upper block's source changed; the session is live after the Backspaces and after the Ж; for a
// paragraph or heading below that would merge: one toast per Backspace (refused merges) — reported, not judged; no page
// error. With MDR_BASE_PORT (the released 0.2.0 build, ?perf=1) every case also prints what 0.2.0 wrote.
//   MDR_PORT=5465 [MDR_BASE_PORT=<0.2.0 perfserve>] node bench/verify/r7-c7-merge.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, editing, esc, strDiff, show, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
const basePort = process.env.MDR_BASE_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const ZHE = C(0x416);

const UPPER = {
  iframe: '视频 <iframe src="https://www.youtube.com/embed/abc"></iframe> 说明文字',
  onclick: '点 <a href="https://e.example/" onclick="track(1)">这里</a> 查看',
  jslink: '点 <a href="javascript:void(0)">展开</a> 查看',
  headraw: '## 标题 <span onclick="x()">点</span> 文字',
  listraw: '- 第一项\n- 末项 <img src="a.png" onerror="x()"> 文字',
  quoteraw: '> 引用 <a href="javascript:x()">j</a> 文字',
  pi: '处理指令 <?form ?> 文字',
  mdtitle: '链接 [x](https://e.example/ "a-->b") 文字',
};
const LOWER = {
  para: ['下面一段文字 below', '下面一段文字'],
  head: ['## 下面标题 below', '下面标题'],
};
const PRESSES = { once: 1, twice: 2, held: 6 };
const CASES = [];
for (const [u, upper] of Object.entries(UPPER)) for (const [l, [lower, needle]] of Object.entries(LOWER)) for (const [p, n] of Object.entries(PRESSES)) {
  for (const end of ['esc', 'click']) {
    if (end === 'click' && p !== 'twice') continue;
    CASES.push({ name: `${u}-${l}-${p}-${end}`, upper, lower, needle, n, end, doc: `# 合并\n\n${upper}\n\n${lower}\n\n末尾段落 tail\n` });
  }
}
CASES.push({ name: 'control-plain-para-once-esc', upper: '普通的上一段文字', lower: LOWER.para[0], needle: LOWER.para[1], n: 1, end: 'esc', control: true, doc: `# 合并\n\n普通的上一段文字\n\n${LOWER.para[0]}\n\n末尾段落 tail\n` });
const FILTERED = CASES.filter((c) => filter.test(c.name));

const caretAtStartOf = (A, needle) => A.page.evaluate((needle) => {
  const el = document.querySelector('.md-block.is-editing');
  if (!el) return false;
  const tw = document.createTreeWalker(el, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const i = n.data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  }
  return false;
}, needle);

async function runOne(A, c) {
  await load(A, c.doc, c.name + '.md');
  const e0 = A.errors ? A.errors.length : 0;
  const t0 = await toasts(A);
  const on = await clickAt(A, c.needle, 0, 2);
  if (!on) return { err: 'no session in the lower block' };
  if (!(await caretAtStartOf(A, c.needle))) return { err: 'caret' };
  for (let k = 0; k < c.n; k++) { await A.page.keyboard.press('Backspace'); await sleep(c.n > 2 ? 60 : 350); }
  await sleep(400);
  const liveAfterBs = await editing(A);
  await A.page.keyboard.type(ZHE);
  await sleep(400);
  const liveAfterType = await editing(A);
  const tt = (await toasts(A)) - t0;
  if (c.end === 'esc') await esc(A);
  else { await clickAt(A, '末尾段落', 0, 2); await esc(A); }
  const out = await source(A);
  return { liveAfterBs, liveAfterType, tt, out, errs: A.errors ? A.errors.slice(e0) : [] };
}

let browser;
globalTimeout(T_MS, async () => browser?.close());
let bad = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  const B = basePort ? await openApp(browser, basePort, { perf: true }) : null;
  for (const c of FILTERED) {
    const r = await runOne(A, c);
    let ok = true, why = '';
    if (r.err) { ok = false; why = r.err; }
    else {
      const d = strDiff(c.doc, r.out);
      const want = c.control ? c.doc.replace(c.upper + '\n\n' + c.lower, c.upper + ZHE + c.lower) : null;
      const onlyZhe = d.del === '' && d.ins === ZHE;
      if (c.control) { ok = r.out === want; if (!ok) why = 'control did not join'; }
      else {
        if (!onlyZhe) { ok = false; why = `change del=${show(d.del)} ins=${show(d.ins)}`; }
        else if (r.out !== c.doc.replace(c.needle, ZHE + c.needle)) { ok = false; why = 'Ж not at the start of the lower block'; }
        if (!r.out.includes(c.upper + '\n\n')) { ok = false; why += ' upper changed'; }
        if (!r.liveAfterBs || !r.liveAfterType) { ok = false; why += ` live=${r.liveAfterBs}/${r.liveAfterType}`; }
      }
      if (r.errs.length) { ok = false; why += ' page errors ' + JSON.stringify(r.errs.slice(0, 2)); }
    }
    if (!ok) bad++;
    let vs = '';
    if (B && !r.err) {
      const b = await runOne(B, c);
      vs = b.err ? ` 0.2.0: ${b.err}` : ` 0.2.0: ${b.out === r.out ? 'same' : 'ins=' + show(strDiff(c.doc, b.out).ins) + ' del=' + show(strDiff(c.doc, b.out).del)} live=${b.liveAfterType}`;
    }
    console.log(`${ok ? 'ok ' : 'BAD'} ${c.name}: live=${r.liveAfterBs}/${r.liveAfterType} toasts=${r.tt}${why ? ' -- ' + why : ''}${vs}`);
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}`);
  process.exitCode = bad ? 1 : 0;
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  try { await browser?.close(); } catch { /* */ }
  process.exit(process.exitCode ?? 0);
}
