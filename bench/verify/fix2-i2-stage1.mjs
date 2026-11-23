// bench/verify/fix2-i2-stage1.mjs — fix-session-2: attribution helper. Runs a few cases of v2-ses-resume /
// v2-ses-paste / v2-ses-lists (same documents, actions and expectations, copied) against whatever serves
// MDR_PORT, with ?perf=1 so a production build (vite preview of dist/ = the stage-1 renderer) exposes window.__mdr.
// Run: MDR_PORT=5312 node bench/verify/fix2-i2-stage1.mjs
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';
const B = await openB();
const stop = globalTimeout(110_000, B.close);
const { page } = B;
async function act(a) {
  if (typeof a === 'object') {
    await page.evaluate(({ text }) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, { text: a.paste });
    await sleep(40); return;
  }
  const [k, ...rest] = a.split(':'); const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'caret') await B.caretAt(v, 'after');
  else if (k === 'wait') await sleep(Number(v));
}
const C = [
  ['nb-type', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Enter', 'type:Q'], 'abc\n\nQdef\n'],
  ['p-start-enter', 'abc\n', 1, 'abc', ['press:Home', 'press:Enter', 'type:Q'], '\nQabc\n'],
  ['p-alt-arrow', 'abc def ghi\n', 1, 'abc', ['caret:abc', 'press:Enter', 'press:Alt+ArrowRight', 'type:Q'], 'abc\n\ndefQ ghi\n'],
  ['h-tight-para-enter', '# Head\ntext\n', 1, 'Head', ['caret:Head', 'press:Enter', 'type:Q'], '# Head\n\nQ\ntext\n'],
  ['syn-fence', 'abc```def\n', 1, 'abc', ['caret:abc', 'press:Enter', 'type:X'], 'abc\n\nX```def\n'],
  ['heading-lines', '# Title\n\nnext\n', 1, 'Title', ['caret:Title', { paste: 'A\nB' }], null],
  ['cell-lines', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', ['caret:cc', { paste: 'X\nY' }], null],
  ['ul-middle-emptied', '- a\n- x\n- o\n\nafter\n', 2, 'x', ['caret:x', 'press:Backspace'], null],
];
try {
  await B.boot('mode=split&perf=1');
  for (const [name, doc, line, needle, actions, want] of C) {
    try {
      await B.loadDoc(doc);
      await B.clickLine(line, 'first', needle);
      if (name === 'p-start-enter') await B.caretAt(needle, 'before');
      for (const a of actions) { if (a === 'press:Home') continue; await act(a); }
      await sleep(400); await B.settle(200);
      const html = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML.slice(0, 300) ?? null);
      await page.keyboard.press('Escape'); await B.settle(300);
      const src = await B.source();
      check(name, want === null || src === want, `src=${J(src)} session=${J(html)}`);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
} finally { console.log(`${results.pass}/${results.pass + results.fail}`); stop(); await B.close(); }
