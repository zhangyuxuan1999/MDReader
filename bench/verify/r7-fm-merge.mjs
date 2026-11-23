// bench/verify/r7-fm-merge.mjs — fix-merge (0.2.1, fix round 7): P1 (CONTRACT §11, Round-7 decisions; VF-1 of
// docs/FINDINGS-0.2.0-r6.md) in Chromium. A block the preview may not edit (rule T: raw HTML the sanitizer changes, a
// Markdown title or URL it takes, a reference whose definition elsewhere has such a URL; the gate; the guard; the size
// limit of the merged block), and below it a paragraph, a list whose first item is the target, or a quote. The user clicks
// into the lower block, puts the caret at its start, presses Backspace, waits, types Ж, then Esc.
// The guard's console lines are printed as <writes>w/<session starts>s (a refused start of a block the guard refuses is
// counted as a start, as at a click; a write must never be refused).
// Checks per case: the upper block's source is byte for byte what it was; the only change of the document is the typed Ж,
// at the start of the lower block's text (a paragraph: nothing else; a list item or a quote: whatever Chromium's own
// Backspace does inside the lower block is reported, never a join); the session is live after the Backspace and after
// the Ж; a paragraph below gets the toast. Controls: plain paragraphs above, which join as before (the Ж at the join).
// With MDR_BASE_PORT the same cases run on a second server (the released 0.2.0 build served by
// bench/verify/v5-cfm-perfserve.mjs) and every case prints whether the tree gives the same source as 0.2.0.
// Run: MDR_PORT=<dev server> [MDR_BASE_PORT=<0.2.0 build>] node bench/verify/r7-fm-merge.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, editing, esc, strDiff, show, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
const basePort = process.env.MDR_BASE_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const SHY = C(0xad), ZHE = C(0x416);

const UPPER = {
  iframe: '视频 <iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe> 说明文字',
  script: '统计 <script>window.dataLayer = [];</script> 文字',
  onclick: '点 <a href="https://e.example/" onclick="track(1)">这里</a> 查看',
  imgonerror: '图 <img src="a.png" onerror="x()"> 文字',
  jslink: '点 <a href="javascript:void(0)">展开</a> 查看',
  form: '搜索 <form action="/s"><input name="q"> <button>搜</button></form> 文字',
  custom: '组件 <my-card data-id="7">卡片</my-card> 文字',
  style: '样式 <style>.note { color: gray }</style> 文字',
  button: '按钮 <button>点我</button> 文字',
  mdtitle: '链接 [x](https://e.example/ "a-->b") 文字',
  obsidian: '链接 [笔记](obsidian://open?vault=x) 文字',
  refobsidian: '见 [笔记][r] 文字',
  idtitle: '前文 <span id="title">锚点</span> 结尾文字',
  gatedelins: '前文 <del>旧</del><ins>新</ins> 文本',
  gatebi: '前文 <b>粗</b> <i>斜</i> 文本',
  guardshy: `Go <https://e.example/a${SHY}b> and c&shy;d 文字`,
  ctrlref: '前文 <a href="x" title="a&#1;b">t</a> 文字',
  toolong: 'xxxxxxxxx '.repeat(5999) + 'xxxxxx',
};
const LOWER = {
  para: ['下面一段文字 below', '下面一段文字'],
  item: ['- 第一项 below\n- 第二项', '第一项'],
  quote: ['> 引用文字 below', '引用文字'],
};
const CONTROLS = {
  plain: '普通的上一段文字',
  formula: '公式 $x^2+1$ 文字',
  kbd: '按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 复制',
};
const CASES = [];
for (const [u, upper] of Object.entries(UPPER)) {
  for (const [l, [lower, needle]] of Object.entries(LOWER)) {
    const tail = u === 'refobsidian' ? '\n[r]: obsidian://open\n' : '';
    CASES.push({ name: `${u}-${l}`, upper, lower, needle, doc: `# 合并\n\n${upper}\n\n${lower}\n${tail}`, kind: l, control: false });
  }
}
for (const [u, upper] of Object.entries(CONTROLS)) {
  CASES.push({ name: `control-${u}-para`, upper, lower: LOWER.para[0], needle: LOWER.para[1], doc: `# 合并\n\n${upper}\n\n${LOWER.para[0]}\n`, kind: 'para', control: true });
}
const FILTERED = CASES.filter((c) => filter.test(c.name));

/** The caret at the very start of the session block's first text that holds `needle`. */
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
  A.guard.length = 0;
  await load(A, c.doc, c.name + '.md');
  if (c.name.startsWith('toolong-')) {   // (the lower block is below the window that renders: scroll it in first)
    await A.page.evaluate(() => { const b = document.querySelectorAll('.md-block'); b[b.length - 1]?.scrollIntoView({ block: 'center' }); });
    await sleep(1200);
  }
  const t0 = await toasts(A);
  const on = await clickAt(A, c.needle, 0, 2);
  if (!on) return { on, err: 'no session in the lower block' };
  if (!(await caretAtStartOf(A, c.needle))) return { on, err: 'caret' };
  await A.page.keyboard.press('Backspace');
  await sleep(600);
  const liveAfterBs = await editing(A);
  await A.page.keyboard.type(ZHE);
  await sleep(400);
  const liveAfterType = await editing(A);
  const tt = (await toasts(A)) - t0;
  await esc(A);
  const out = await source(A);
  const writes = A.guard.filter((g) => !g.includes('session start')).length;
  return { on, liveAfterBs, liveAfterType, tt, out, guard: `${writes}w/${A.guard.length - writes}s` };
}

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0, same = 0, differ = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  const B = basePort ? await openApp(browser, basePort, { perf: true }) : null;
  for (const c of FILTERED) {
    const r = await runOne(A, c);
    let ok, why = '';
    if (r.err) { ok = false; why = r.err; }
    else {
      const upperKept = c.control || r.out.includes(c.upper + '\n\n');
      const d = strDiff(c.doc, r.out);
      if (c.control) {
        const want = c.doc.replace(c.upper + '\n\n' + c.lower, c.upper + ZHE + c.lower);
        ok = r.out === want && r.liveAfterBs && r.liveAfterType && r.tt === 0;
        if (!ok) why = 'control did not join as before';
      } else if (c.kind === 'para') {
        // (a form inside the upper paragraph leaves it no paragraph of its own: never a merge, no toast)
        ok = upperKept && r.tt === (c.name.startsWith('form-') ? 0 : 1) && r.out === c.doc.replace(c.lower, ZHE + c.lower) && r.liveAfterBs && r.liveAfterType;
        if (!ok) why = 'want: nothing but the Ж at the start, the session live, one toast';
      } else {
        // a list item or a quote below: no merge exists for them; the upper block must be untouched and the Ж written
        ok = upperKept && r.out.includes(ZHE) && r.liveAfterType && !d.del.includes(c.upper);
        if (!ok) why = 'the upper block changed or the typing was lost';
      }
      r.diff = `del=${show(d.del)} ins=${show(d.ins)}`;
    }
    if (!ok) bad++;
    let vs = '';
    if (B && !r.err) {
      const b = await runOne(B, c);
      if (b.out === r.out) { same++; vs = ' 0.2.0=same'; } else { differ++; vs = ` 0.2.0=DIFFERS(${show(strDiff(c.doc, b.out ?? '').ins)} / toast=${b.tt} live=${b.liveAfterType})`; }
    }
    console.log(`${ok ? 'ok ' : 'BAD'} ${c.name}: live=${r.liveAfterBs}/${r.liveAfterType} toast=${r.tt} guard=${r.guard} ${r.diff ?? ''}${why ? ' -- ' + why : ''}${vs}`);
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}${B ? ` same-as-0.2.0=${same} differs=${differ}` : ''}`);
} finally { stop(); await browser?.close(); }
