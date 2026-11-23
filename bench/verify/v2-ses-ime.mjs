// bench/verify/v2-ses-ime.mjs — verify-session: IME compositions inside sessions and across the resume window.
// Compositions are real Chromium compositions driven through CDP (Input.imeSetComposition / Input.insertText);
// the keys an IME consumes are sent as rawKeyDown with keyCode 229 (what Chromium reports for them), so the page
// sees what it sees under a real IME. Run: MDR_PORT=5282 node bench/verify/v2-ses-ime.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
const cdp = await B.getCdp();
const comp = (t) => cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
const commit = (t) => cdp.send('Input.insertText', { text: t });
const key229 = async (key, code) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
};
const C = {
  async 'enter-commits'() {
    await B.loadDoc('abc def\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('zh'); await sleep(50); await comp('zhong'); await sleep(50);
    await key229('Enter', 'Enter'); await commit('中'); await sleep(400); await B.settle();
    return { src: await B.source(), want: 'abc中 def\n' };
  },
  async 'backspace-in-composition-at-start'() {
    await B.loadDoc('one\n\ntwo\n'); await B.clickLine(3, 'first', 'two'); await B.caretAt('two', 'before');
    await comp('z'); await sleep(50); await key229('Backspace', 'Backspace'); await comp(''); await sleep(50);
    await key229('Backspace', 'Backspace');   // (some IMEs report the last Backspace with 229 too)
    await sleep(400); await B.settle();
    return { src: await B.source(), want: 'one\n\ntwo\n', live: (await B.state()).editing !== null };
  },
  async 'esc-cancels-composition'() {
    await B.loadDoc('abc\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('zh'); await sleep(50); await key229('Escape', 'Escape'); await comp(''); await sleep(300); await B.settle();
    const live = (await B.state()).editing !== null;
    await page.keyboard.type('x'); await sleep(300); await B.settle();
    return { src: await B.source(), want: 'abcx\n', live };
  },
  async 'composition-open-long'() {
    await B.loadDoc('abc\n\nnext\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('ni'); await sleep(1500); const mid = await B.source(); await comp('nihao'); await sleep(1500);
    await commit('你好'); await sleep(300); await B.settle();
    return { src: await B.source(), want: 'abc你好\n\nnext\n', mid, midWant: 'abc\n\nnext\n' };
  },
  async 'composition-across-resume-3s'() {
    await B.loadDoc('abcdef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.press('Enter');
    await comp('zh'); await sleep(3000); await comp('zhong'); await sleep(200); await commit('中'); await sleep(400); await B.settle();
    return { src: await B.source(), want: 'abc\n\n中def\n', live: (await B.state()).editing !== null };
  },
  async 'composition-then-enter-split'() {
    await B.loadDoc('abcdef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('zh'); await sleep(30); await commit('中'); await page.keyboard.press('Enter'); await comp('w'); await commit('文'); await sleep(400); await B.settle();
    return { src: await B.source(), want: 'abc中\n\n文def\n' };
  },
  async 'composition-then-esc-immediately'() {
    await B.loadDoc('abc\n\nnext\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('zh'); await sleep(30); await commit('中'); await page.keyboard.press('Escape'); await sleep(300); await B.settle();
    return { src: await B.source(), want: 'abc中\n\nnext\n' };
  },
  async 'composition-then-click-other'() {
    await B.loadDoc('abc\n\nnext\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await comp('zh'); await sleep(30);
    await B.clickLine(3, 'first', 'next'); await sleep(300); await B.settle();
    return { src: await B.source(), want: null };
  },
  async 'composition-merge-paragraphs'() {
    await B.loadDoc('one\n\ntwo\n'); await B.clickLine(3, 'first', 'two'); await B.caretAt('two', 'before');
    await page.keyboard.press('Backspace'); await comp('z'); await commit('字'); await sleep(400); await B.settle();
    return { src: await B.source(), want: 'one字two\n' };
  },
  async 'composition-after-undo'() {
    await B.loadDoc('abc\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.type('XY'); await sleep(700); await page.keyboard.press('Meta+z'); await comp('z'); await commit('字'); await sleep(400); await B.settle();
    return { src: await B.source(), want: 'abc字\n' };
  },
};
try {
  await B.boot('mode=split');
  for (const [name, fn] of Object.entries(C)) {
    if (filter && !name.includes(filter)) continue;
    try {
      const r = await fn();
      const ok = (r.want === null || r.src === r.want) && (r.live === undefined || r.live) && (r.midWant === undefined || r.mid === r.midWant);
      check(name, ok, J(r));
      await page.keyboard.press('Escape'); await sleep(100);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
