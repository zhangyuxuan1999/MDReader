// bench/verify/fixC-nbsp.mjs — where does Chromium's contenteditable put U+00A0 while typing?
// Evidence for the serializer's non-breaking-space rule (src/preview/serialize.ts fixNbsp): a single
// NBSP between two non-space characters inside one text node is never produced by typing, so such an
// NBSP comes from the document (`&nbsp;`) and is kept. No server needed. Global timeout 60 s.
// Run: node bench/verify/fixC-nbsp.mjs
import { chromium } from '@playwright/test';

const timer = setTimeout(() => { console.log('FAIL  global timeout'); process.exit(2); }, 60_000);
let browser = null;
let bad = 0;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const show = (s) => s.replace(/ /g, '⍽');
  const cases = [
    // [initial html of the paragraph, caret text offset, keys to type (array; strings are typed, {key} pressed)]
    ['ab', 1, [' ']],
    ['ab', 2, [' ', 'c']],
    ['ab', 2, [' ', ' ', 'c']],
    ['ab', 1, [' ', ' ']],
    ['a b', 2, [' ']],
    ['a b c', 3, [{ key: 'Backspace' }]],
    ['a b c', 2, [{ key: 'Delete' }]],
    ['a bx c', 4, [{ key: 'Backspace' }, { key: 'Backspace' }]],
    ['abc', 3, [' ', 'd', ' ', 'e']],
    ['abc', 0, [' ', 'x']],
    ['a <b>b</b>', 2, [' ', 'x']],
    ['a', 1, [' ', 'b', ' ', ' ', 'c']],
    ['中文', 1, [' ', '字']],
  ];
  for (const [html, at, keys] of cases) {
    await page.setContent(`<p id="p" contenteditable="true">${html}</p>`);
    await page.evaluate((at) => {
      const p = document.getElementById('p'); p.focus();
      const t = p.firstChild; const r = document.createRange(); r.setStart(t, at); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, at);
    for (const k of keys) { if (typeof k === 'string') await page.keyboard.type(k); else await page.keyboard.press(k.key); }
    const texts = await page.evaluate(() => {
      const out = []; const w = document.createTreeWalker(document.getElementById('p'), 4);
      for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n.data); return out;
    });
    // an NBSP with a non-space character on both sides inside one text node
    const inner = texts.some((d) => /[^\s ] [^\s ]/.test(d));
    if (inner) bad++;
    console.log(`${inner ? 'SEEN' : 'ok  '}  ${JSON.stringify(html)} @${at} + ${JSON.stringify(keys.map((k) => (typeof k === 'string' ? k : `<${k.key}>`)).join(''))} → ${texts.map((d) => JSON.stringify(show(d))).join(' | ')}`);
  }
} catch (err) {
  bad++;
  console.log('FAIL ', err instanceof Error ? err.stack : String(err));
} finally {
  clearTimeout(timer);
  try { await browser?.close(); } catch { /* */ }
}
console.log(bad ? `RESULT: typing produced ${bad} inner NBSP case(s)` : 'RESULT: typing never produced an NBSP between two non-space characters');
process.exit(bad ? 1 : 0);
