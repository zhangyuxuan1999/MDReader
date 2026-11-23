// bench/verify/v7-vf-rulet.mjs — verify-refs (round 6): RULE T under the user's gestures. Documents with embeds and
// scripts as people write them; per case a gesture on or next to the block whose raw HTML the sanitizer changes:
// click + type, double click + type, a task tick in the block, Backspace at the start of the paragraph below (a merge),
// Delete at the end of the paragraph above, a paste after a refused click, ArrowDown / ArrowUp from a session next door.
// Checks: the raw HTML is still in the source byte for byte; nothing but the typed text (in a block that may be edited)
// changed; the guard's console lines.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-rulet.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, paste, esc, editing, strDiff, show, globalTimeout, sleep } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);

const RAW = {
  iframe: '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315" allowfullscreen></iframe>',
  script: '<script>window.dataLayer = [];</script>',
  onclick: '<a href="https://e.example/" onclick="track(1)">这里</a>',
  jslink: '<a href="javascript:void(0)">展开</a>',
  form: '<form action="/s"><input name="q"> <button>搜</button></form>',
  custom: '<my-card data-id="7">卡片</my-card>',
  style: '<style>.note { color: gray }</style>',
};
const mk = (raw) => `# 文档\n\n上面一段文字 above\n\n视频在这里 ${raw} 后面的文字 mid\n\n下面一段文字 below\n`;
const CASES = [];
for (const [k, raw] of Object.entries(RAW)) {
  CASES.push([`${k}-click-type`, mk(raw), raw, async (A) => { const on = await clickAt(A, '后面的文字', 0, 2); if (on) { await caret(A, '后面的文字'); await A.page.keyboard.type('Ж'); } return on; }]);
  CASES.push([`${k}-dblclick-type`, mk(raw), raw, async (A) => { const on = await clickAt(A, '后面的文字', 0, 2, { double: true }); if (on) await A.page.keyboard.type('Ж'); else await A.page.keyboard.type('Ж'); return on; }]);
  CASES.push([`${k}-click-paste`, mk(raw), raw, async (A) => { const on = await clickAt(A, '后面的文字', 0, 2); await paste(A, '粘贴Ж'); return on; }]);
  CASES.push([`${k}-merge-from-below`, mk(raw), raw, async (A) => { await clickAt(A, '下面一段文字', 0, 2); await caret(A, '下面一段文字', 0); await A.page.keyboard.press('Backspace'); await sleep(500); await A.page.keyboard.type('Ж'); return false; }]);
  CASES.push([`${k}-delete-from-above`, mk(raw), raw, async (A) => { await clickAt(A, '上面一段文字', 0, 2); await caret(A, 'above'); await A.page.keyboard.press('Delete'); await sleep(500); await A.page.keyboard.type('Ж'); return false; }]);
  CASES.push([`${k}-arrow-down-in`, mk(raw), raw, async (A) => { await clickAt(A, '上面一段文字', 0, 2); await caret(A, 'above'); await A.page.keyboard.press('ArrowDown'); await sleep(500); await A.page.keyboard.type('Ж'); return false; }]);
  CASES.push([`${k}-arrow-up-in`, mk(raw), raw, async (A) => { await clickAt(A, '下面一段文字', 0, 2); await caret(A, '下面一段文字', 0); await A.page.keyboard.press('ArrowUp'); await sleep(500); await A.page.keyboard.type('Ж'); return false; }]);
  const task = `# 清单\n\n- [ ] 第一项 ${raw} 说明\n- [ ] 第二项\n\n结尾段落\n`;
  CASES.push([`${k}-task-tick`, task, raw, async (A) => {
    const box = await A.page.evaluate(() => { const i = document.querySelector('.md-block input[type=checkbox]'); if (!i) return null; const b = i.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    if (box) { await A.page.mouse.click(box.x, box.y); await sleep(600); }
    return !!box;
  }]);
}
// an iframe as a block of its own with a caption below (blank line) and right under it (same paragraph)
const BLOCK = '# 视频\n\n<iframe src="https://player.example/v?id=1" allowfullscreen></iframe>\n\n*视频说明文字 cap*\n\n结尾\n';
CASES.push(['iframeblock-caption-type', BLOCK, '<iframe src="https://player.example/v?id=1" allowfullscreen></iframe>', async (A) => { const on = await clickAt(A, '视频说明文字', 0, 2); if (on) { await caret(A, 'cap'); await A.page.keyboard.type('Ж'); } return on; }]);
CASES.push(['iframeblock-caption-merge', BLOCK, '<iframe src="https://player.example/v?id=1" allowfullscreen></iframe>', async (A) => { const on = await clickAt(A, '视频说明文字', 0, 2); if (on) { await caret(A, '视频说明文字', 0); await A.page.keyboard.press('Backspace'); await sleep(500); await A.page.keyboard.type('Ж'); } return on; }]);
const GLUED = '# 视频\n\n<iframe src="https://player.example/v?id=1"></iframe>\n*视频说明文字 cap*\n\n结尾\n';
CASES.push(['iframe-glued-caption', GLUED, '<iframe src="https://player.example/v?id=1"></iframe>', async (A) => { const on = await clickAt(A, '视频说明文字', 0, 2); if (on) { await caret(A, 'cap'); await A.page.keyboard.type('Ж'); } return on; }]);
const FILTERED = CASES.filter((c) => filter.test(c[0]));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
let bad = 0;
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, doc, raw, act] of FILTERED) {
    A.guard.length = 0;
    await load(A, doc, name + '.md');
    const t0 = await toasts(A);
    let started = null, err = null;
    try { started = await act(A); } catch (e) { err = String(e.message || e); }
    await sleep(300);
    await esc(A);
    const out = await source(A);
    const tt = (await toasts(A)) - t0;
    const d = strDiff(doc, out);
    const kept = out.includes(raw);
    const onlyTyped = d.del === '' && /^[Ж粘贴]*$/.test(d.ins);
    const tick = name.endsWith('task-tick') && d.del === ' ' && d.ins === 'x';
    const ok = kept && (out === doc || onlyTyped || tick) && !err;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${name}: session=${started} kept=${kept} toast=${tt} guard=${A.guard.length} diff del=${show(d.del)} ins=${show(d.ins)}${err ? ' ERR ' + err : ''}`);
  }
  console.log(`RESULT bad=${bad} of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
