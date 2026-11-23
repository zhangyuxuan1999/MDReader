// bench/verify/v4-sesb-pastemisc.mjs — verify-session-b: paste corners (U8 / U19): a second paste inside the resume
// window of the first, a paste into the emptied element, CRLF / CR line ends, a tab, NBSP, U+2028, an HTML-only
// clipboard. Each checks the source (accepted spellings listed) and that "Q" typed next lands right after the paste.
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-pastemisc.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const D = 'before\n\nabcdef\n\nafter\n';
const ch = (n) => String.fromCharCode(n);
const paste = async (page, t) => { await page.evaluate((t) => navigator.clipboard.writeText(t), t); await page.keyboard.press('Meta+v'); };
const C = [
  ['paste-in-resume-window', async (page) => { await paste(page, 'a1\n\nb1'); await paste(page, 'c1'); }, ['before\n\na1\n\nb1c1Qabcdef\n\nafter\n']],
  ['paste-twice-paras', async (page) => { await paste(page, 'a1\n\nb1'); await paste(page, 'c1\n\nd1'); }, ['before\n\na1\n\nb1c1\n\nd1Qabcdef\n\nafter\n']],
  ['paste-into-emptied', async (page) => { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await sleep(300); await paste(page, 'x1\n\ny1'); }, ['before\n\nx1\n\ny1Q\n\nafter\n']],
  ['paste-into-emptied-line', async (page) => { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await sleep(300); await paste(page, 'x1'); }, ['before\n\nx1Q\n\nafter\n']],
  ['crlf', async (page) => { await paste(page, 'c1\r\n\r\nd1'); }, ['before\n\nc1\n\nd1Qabcdef\n\nafter\n']],
  ['cr', async (page) => { await paste(page, 'c1\r\rd1'); }, ['before\n\nc1\n\nd1Qabcdef\n\nafter\n']],
  ['crlf-single', async (page) => { await paste(page, 'c1\r\nd1'); }, ['before\n\nc1  \nd1Qabcdef\n\nafter\n', 'before\n\nc1\\\nd1Qabcdef\n\nafter\n']],
  ['tab', async (page) => { await paste(page, 'c1' + ch(9) + 'd1'); }, ['before\n\nc1' + ch(9) + 'd1Qabcdef\n\nafter\n', 'before\n\nc1 d1Qabcdef\n\nafter\n']],
  ['nbsp', async (page) => { await paste(page, 'c1' + ch(0xa0) + 'd1'); }, ['before\n\nc1&nbsp;d1Qabcdef\n\nafter\n', 'before\n\nc1' + ch(0xa0) + 'd1Qabcdef\n\nafter\n']],
  ['u2028', async (page) => { await paste(page, 'c1' + ch(0x2028) + 'd1'); }, null],
  ['html-only', async (page) => {
    await page.evaluate(async () => { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob(['<b>hx</b>'], { type: 'text/html' }) })]); });
    await page.keyboard.press('Meta+v');
  }, ['before\n\nQabcdef\n\nafter\n']],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, act, exps] of C) {
    if (filter && !new RegExp(filter).test(name)) continue;
    try {
      await prepare(A, D);
      const p = await pointOf(page, 'abcdef', 0); await page.mouse.click(p.x, p.y); await sleep(350);
      if (!(await view(page)).editing) throw new Error('no session');
      await act(page);
      await sleep(500);
      await page.keyboard.type('Q');
      await sleep(500);
      const v = await view(page);
      await page.keyboard.press('Escape'); await A.settle(200);
      const src = await A.source();
      const ok = exps === null ? src.includes('Q') && src.split('Q').length === 2 : exps.includes(src);
      check(name, ok, `src=${J(src)}${ok ? '' : ' exp=' + J(exps)} session=${!!v.editing} errors=${J(A.pageErrors.slice(-1))}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
