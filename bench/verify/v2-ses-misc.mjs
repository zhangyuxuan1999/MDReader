// bench/verify/v2-ses-misc.mjs — verify-session: things users do without thinking, and history corner cases.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-misc.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results, readRoot } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
const st = () => B.state();
const T = {
  async 'undo-deleted-block'() {
    await B.loadDoc('aaa\n\nbbb\n\nccc\n'); await B.clickLine(3, 'first', 'bbb');
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await sleep(200);
    const pt = await B.textPoint(5, 'first'); await page.mouse.click(pt.x, pt.y); await sleep(400); await B.settle();
    const del = await B.source();
    await page.keyboard.press('Meta+z'); await sleep(500); await B.settle();
    const u = await B.source();
    await page.keyboard.press('Meta+Shift+z'); await sleep(500); await B.settle();
    const r = await B.source();
    return [u === 'aaa\n\nbbb\n\nccc\n' && r === del && (await st()).editing !== null, J({ del, u, r, st: await st() })];
  },
  async 'redo-after-new-typing-does-nothing'() {
    await B.loadDoc('abc\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.type('XYZ'); await sleep(700); await page.keyboard.press('Meta+z'); await sleep(300);
    await page.keyboard.type('Q'); await sleep(700); await page.keyboard.press('Meta+Shift+z'); await sleep(400); await B.settle();
    return [(await B.source()) === 'abcQ\n', J(await B.source())];
  },
  async 'undo-interleaved-with-typing'() {
    await B.loadDoc('abc\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.type('a'); await sleep(700); await page.keyboard.type('b'); await sleep(700);
    await page.keyboard.press('Meta+z'); await sleep(300); await page.keyboard.type('c'); await sleep(700);
    const mid = await B.source();
    await page.keyboard.press('Meta+z'); await sleep(300); await B.settle(); const u1 = await B.source();
    await page.keyboard.press('Meta+z'); await sleep(300); await B.settle(); const u2 = await B.source();
    return [mid === 'abcac\n' && u1 === 'abca\n' && u2 === 'abc\n', J({ mid, u1, u2 })];
  },
  async 'undo-caret-position'() {
    await B.loadDoc('hello world\n'); await B.clickLine(1, 'first', 'hello'); await B.caretAt('hello');
    await page.keyboard.type('XYZ'); await sleep(700); await page.keyboard.press('Meta+z'); await sleep(400); await B.settle();
    await page.keyboard.type('|'); await sleep(300); await B.settle();
    return [(await B.source()) === 'hello| world\n', J(await B.source())];
  },
  async 'redo-caret-position'() {
    await B.loadDoc('hello world\n'); await B.clickLine(1, 'first', 'hello'); await B.caretAt('hello');
    await page.keyboard.type('XYZ'); await sleep(700); await page.keyboard.press('Meta+z'); await sleep(400);
    await page.keyboard.press('Meta+Shift+z'); await sleep(400); await B.settle();
    await page.keyboard.type('|'); await sleep(300); await B.settle();
    return [(await B.source()) === 'helloXYZ| world\n', J(await B.source())];
  },
  async 'undo-of-split-caret'() {
    await B.loadDoc('abcdef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await sleep(600); await page.keyboard.press('Enter'); await sleep(700); await page.keyboard.press('Meta+z'); await sleep(400); await B.settle();
    await page.keyboard.type('|'); await sleep(300); await B.settle();
    return [(await B.source()) === 'abc|def\n', J(await B.source())];
  },
  async 'click-other-block-with-pending-edit'() {
    await B.loadDoc('aaa\n\nbbb\n'); await B.clickLine(1, 'first', 'aaa'); await B.caretAt('aaa');
    const pt = await B.textPoint(3, 'first');
    await page.keyboard.type('X'); await page.mouse.click(pt.x, pt.y); await sleep(300); await B.settle();
    return [(await B.source()) === 'aaaX\n\nbbb\n' && (await st()).editing !== null, J([await B.source(), await st()])];
  },
  async 'esc-in-resume-window'() {
    await B.loadDoc('abcdef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await sleep(400); await B.settle();
    const s = await st();
    return [(await B.source()) === 'abc\n\ndef\n' && s.editing === null && !s.capFocused, J([await B.source(), s])];
  },
  async 'toggle-edit-off-in-resume-window'() {
    await B.loadDoc('abcdef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.press('Enter'); await page.keyboard.press('Meta+Shift+e'); await sleep(400); await B.settle();
    const s = await st();
    await page.keyboard.press('Meta+Shift+e'); await sleep(200);
    return [s.editing === null && !s.capFocused && (await B.source()) === 'abc\n\ndef\n', J([await B.source(), s])];
  },
  async 'inline-math-edit'() {
    await B.loadDoc('a $x+1$ b\n');
    const box = await page.evaluate(() => { const r = document.querySelector('.mdr-preview .md-math').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(box.x, box.y); await sleep(200); await page.keyboard.type('+2'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await sleep(300); await B.settle();
    return [(await B.source()) === 'a $x+1+2$ b\n', J(await B.source())];
  },
  async 'shift-arrow-across-edge'() {
    await B.loadDoc('aaa\n\nbbb\n\nccc\n'); await B.clickLine(3, 'first', 'bbb'); await B.caretAt('bbb');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.type('Z'); await sleep(300); await B.settle();
    return [(await B.source()) === 'aaa\n\nbbbZ\n\nccc\n', J(await B.source())];
  },
  async 'shift-arrow-up-across-edge'() {
    await B.loadDoc('aaa\n\nbbb\n\nccc\n'); await B.clickLine(3, 'first', 'bbb'); await B.caretAt('b', 'before');
    await page.keyboard.press('Shift+ArrowUp'); await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.type('Z'); await sleep(300); await B.settle();
    return [/^aaa\n\nZ?b*\n\nccc\n$/.test(await B.source()), J(await B.source())];
  },
  async 'triple-click-type'() {
    await B.loadDoc('> one two\n>\n> three\n\nnext\n');
    const pt = await B.textPoint(1, 'first', 'two');
    await page.mouse.click(pt.x, pt.y); await sleep(100); await page.mouse.click(pt.x, pt.y, { clickCount: 3 }); await sleep(100);
    await page.keyboard.type('Z'); await sleep(300); await B.settle();
    return [true, 'INFO ' + J(await B.source())];
  },
  async 'double-click-new-block'() {
    await B.loadDoc('one two three\n');
    const pt = await B.textPoint(1, 'first', 'two');
    await page.mouse.dblclick(pt.x, pt.y); await sleep(100); await page.keyboard.type('Z'); await sleep(300); await B.settle();
    return [(await B.source()) === 'one Z three\n', J(await B.source())];
  },
  async 'right-click-keeps-session'() {
    await B.loadDoc('abc\n\nnext\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    const pt = await B.textPoint(3, 'first');
    await page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(200);
    await page.keyboard.press('Escape'); await sleep(100);
    return [true, 'INFO after right-click on another block: ' + J(await st())];
  },
  async 'tab-in-paragraph'() {
    await B.loadDoc('abc\n\nnext\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc');
    await page.keyboard.press('Tab'); await page.keyboard.type('Z'); await sleep(300); await B.settle();
    return [(await B.source()) === 'abcZ\n\nnext\n' && (await st()).editing !== null, J(await B.source())];
  },
  async 'scroll-stable-on-split-large'() {
    const t = readRoot('test-data/large.md');
    await B.loadDoc(t);
    const n = 54403;
    await B.clickLine(n, 'first', '这是一个'); await B.caretAt('这是一个');
    const y0 = await page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().top);
    await page.keyboard.press('Enter'); await sleep(500); await B.settle();
    const y1 = await page.evaluate(() => getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect().top : null);
    return [y1 !== null && Math.abs(y1 - y0) < 120, J({ y0, y1, st: await st() })];
  },
};
try {
  await B.boot('mode=split');
  for (const [name, fn] of Object.entries(T)) {
    if (filter && !name.includes(filter)) continue;
    try { const [ok, d] = await fn(); check(name, ok, d); } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
    await page.keyboard.press('Escape').catch(() => {}); await sleep(100);
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
