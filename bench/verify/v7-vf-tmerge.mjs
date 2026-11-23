// bench/verify/v7-vf-tmerge.mjs — verify-refs (round 6): Backspace at the start of a paragraph whose previous block may
// not be edited in the preview. The paragraph below is in a session; Backspace at its start; then the user goes on
// typing "QR" (as one does after joining two paragraphs). Prints per case: whether the join was written into the source,
// whether a refusal toast came, whether a session is live afterwards, and whether the typed "QR" reached the source.
// Cases: previous block refused by rule T (raw HTML the sanitizer changes), refused by the fidelity gate (a raw em space at
// the paragraph's end next to an &emsp; reference), and a control (a plain previous paragraph).
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-tmerge.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, esc, editing, show, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const CASES = [
  ['ruleT-iframe', '视频 <iframe src="https://www.youtube.com/embed/abc"></iframe> 说明文字'],
  ['ruleT-onclick', '点 <a href="https://e.example/" onclick="track(1)">这里</a> 查看'],
  ['ruleT-script', '统计 <script>window.x = 1;</script> 文字'],
  ['gate-trailing-emsp', '段落中间&emsp;引用，结尾' + C(0x2003)],
  ['control-plain', '普通的上一段文字'],
].filter((c) => filter.test(c[0]));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, prev] of CASES) {
    A.guard.length = 0;
    const doc = `# 合并\n\n${prev}\n\n下面一段文字\n`;
    await load(A, doc, name + '.md');
    const t0 = await toasts(A);
    const on = await clickAt(A, '下面一段文字', 0, 2);
    await caret(A, '下面一段文字', 0);
    await A.page.keyboard.press('Backspace');
    await A.page.keyboard.type('QR', { delay: 60 });
    await sleep(800);
    const live = await editing(A);
    const tt = (await toasts(A)) - t0;
    await esc(A);
    const out = await source(A);
    const joined = !out.includes(prev + '\n\n下面');
    console.log(`${name}: session=${on} joinWritten=${joined} toast=${tt} liveAfter=${live} typedWritten=${out.includes('Q') && out.includes('R')} guard=${A.guard.length} source=${show(out.replace('# 合并\n\n', ''))}`);
  }
} finally { stop(); await browser?.close(); }
