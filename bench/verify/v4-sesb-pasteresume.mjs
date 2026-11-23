// bench/verify/v4-sesb-pasteresume.mjs — verify-session-b: U19 / H4 class. A split (a paste of paragraphs, an Enter)
// after which the remaining block renders the same text as before, then "QR" typed at once or after 500 ms: every
// keystroke is written once, in the block that holds the caret. Expected sources are what a text editor (and typing
// the same text) gives. Also: a paste whose text ends in a blank line.
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-pasteresume.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const D = 'before\n\nabcdef\n\nafter\n';
const TAB = String.fromCharCode(9);
// [name, doc, caret [needle, k, side], action {paste} | {key}, expected after "QR" (string or array of acceptable)]
const C = [
  ['h4-orig', D, ['abcdef', 0], { paste: 'vao\n\n ' }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['h4-two', D, ['abcdef', 0], { paste: 'vao\n\nwuu\n\n ' }, 'before\n\nvao\n\nwuu\n\nQRabcdef\n\nafter\n'],
  ['ws-spaces', D, ['abcdef', 0], { paste: 'vao\n\n   ' }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['ws-tab', D, ['abcdef', 0], { paste: 'vao\n\n' + TAB }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['ws-newline-space', D, ['abcdef', 0], { paste: 'vao\n\n \n ' }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['trailing-blank', D, ['abcdef', 0], { paste: 'vao\n\n' }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['trailing-blanks', D, ['abcdef', 0], { paste: 'vao\n\n\n\n' }, 'before\n\nvao\n\nQRabcdef\n\nafter\n'],
  ['identical-follow', D, ['abcdef', 0], { paste: 'abcdef\n\n ' }, 'before\n\nabcdef\n\nQRabcdef\n\nafter\n'],
  ['identical-mid', D, ['abcdef', 3], { paste: 'def\n\nabc' }, 'before\n\nabcdef\n\nabcQRdef\n\nafter\n'],
  ['identical-mid-ws', D, ['abcdef', 3], { paste: 'def\n\n ' }, 'before\n\nabcdef\n\nQRdef\n\nafter\n'],
  ['dup-neighbours', 'dup\n\ndup\n\ndup\n', ['dup', 0], { paste: 'dup\n\n ', nth: 1 }, 'dup\n\ndup\n\nQRdup\n\ndup\n'],
  ['enter-end-identical', 'same\n\nsame\n\nz\n', ['same', 3, 'right'], { key: 'Enter' }, 'same\n\nQR\n\nsame\n\nz\n'],
  ['enter-start-identical', 'same\n\nsame\n\nz\n', ['same', 0], { key: 'Enter', nth: 1 }, ['same\n\nsame\n\nQRsame\n\nz\n', 'same\n\n\n\nQRsame\n\nz\n']],
  ['quote-ws', '> qa qb\n\nz\n', ['qb', 0], { paste: 'x\n\n ' }, '> qa x\n>\n> QRqb\n\nz\n'],
  ['quote-identical', '> qa\n\nz\n', ['qa', 0], { paste: 'qa\n\n ' }, '> qa\n>\n> QRqa\n\nz\n'],
  ['heading-ws', '# Head here\n\nz\n', ['here', 0], { paste: 'x\n\n ' }, null],
  ['item-ws', '- one\n- two\n\nz\n', ['two', 0], { paste: 'x\n\n ' }, null],
  ['leading-blank-at-end', D, ['abcdef', 5, 'right'], { paste: '\n\nvao' }, 'before\n\nabcdef\n\nvaoQR\n\nafter\n'],
  ['leading-blank-mid', D, ['abcdef', 3], { paste: '\n\nvao' }, 'before\n\nabc\n\nvaoQRdef\n\nafter\n'],
  ['both-blank-mid', D, ['abcdef', 3], { paste: '\n\nvao\n\n' }, 'before\n\nabc\n\nvao\n\nQRdef\n\nafter\n'],
  ['para-end-ws', D, ['abcdef', 5, 'right'], { paste: '\n\n ' }, ['before\n\nabcdef\n\nQR\n\nafter\n', 'before\n\nabcdef\n\n QR\n\nafter\n']],
];
async function caretAt(page, needle, k, side, nth = 0) {
  // nth occurrence: scroll and click the character directly
  const p = await page.evaluate(({ needle, k, side, nth }) => {
    const root = document.querySelector('.mdr-preview');
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      if (seen++ < nth) continue;
      const r = document.createRange(); r.setStart(n, i + k); r.setEnd(n, i + k + 1);
      const b = r.getBoundingClientRect();
      return { x: side === 'right' ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { needle, k, side, nth });
  if (!p) throw new Error('not shown ' + needle);
  await page.mouse.click(p.x, p.y);
  await sleep(350);
}
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, doc, [needle, k, side], act, exp] of C) {
    for (const wait of [0, 500]) {
      const cname = `${name}-${wait}`;
      if (filter && !new RegExp(filter).test(cname)) continue;
      try {
        await prepare(A, doc);
        await caretAt(page, needle, k, side ?? 'left', act.nth ?? 0);
        if (act.paste !== undefined) { await page.evaluate((t) => navigator.clipboard.writeText(t), act.paste); await page.keyboard.press('Meta+v'); }
        else await page.keyboard.press(act.key);
        if (wait) await sleep(wait);
        await page.keyboard.type('QR');
        await sleep(600);
        const v = await view(page);
        await page.keyboard.press('Escape'); await A.settle(200);
        const src = await A.source();
        const okExp = exp === null ? true : Array.isArray(exp) ? exp.includes(src) : src === exp;
        const once = src.split('QR').length === 2 && src.split('Q').length === 2;
        const inSession = !!v.editing && v.editing.text.includes('QR');
        check(cname, okExp && once && inSession, `src=${J(src)}${okExp ? '' : ' exp=' + J(exp)} once=${once} session=${inSession}`);
      } catch (e) { check(cname, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
