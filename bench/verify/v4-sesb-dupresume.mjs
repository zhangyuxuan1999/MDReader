// bench/verify/v4-sesb-dupresume.mjs — verify-session-b: U19 / H4 variation. A split (a paste of paragraphs, Enter,
// Shift-less Enter in a quote) whose resume target block has the same text as the block that stood at the target's
// line BEFORE the split (a neighbour with identical text). tryResume accepts a block by its expected text before the
// structure shows the split, so the session can continue in that neighbour: "QR" typed next must still land in the
// block that holds the caret (U19: "into the block that now holds the caret").
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-dupresume.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
// [name, doc, needle, nth, k, side, action, expected]
const C = [
  ['paste-x-ws-before-dup', 'a\n\ndup\n\ndup\n\nz\n', 'dup', 0, 0, 'left', { paste: 'x\n\n ' }, 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
  ['paste-x-before-dup-text', 'a\n\ndup text\n\ndup text\n\nz\n', 'dup text', 0, 0, 'left', { paste: 'x\n\n ' }, 'a\n\nx\n\nQRdup text\n\ndup text\n\nz\n'],
  ['paste-dup-ws-mid-of-three', 'dup\n\ndup\n\ndup\n', 'dup', 1, 0, 'left', { paste: 'dup\n\n ' }, 'dup\n\ndup\n\nQRdup\n\ndup\n'],
  ['paste-two-paras-before-dup', 'a\n\ndup\n\nb\n\ndup\n\nz\n', 'dup', 0, 0, 'left', { paste: 'x\n\ny\n\n ' }, 'a\n\nx\n\ny\n\nQRdup\n\nb\n\ndup\n\nz\n'],
  ['enter-mid-before-dup', 'a\n\nxdup\n\ndup\n\nz\n', 'xdup', 0, 1, 'left', { key: 'Enter' }, 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
  ['enter-mid-before-dup-wait', 'a\n\nxdup\n\ndup\n\nz\n', 'xdup', 0, 1, 'left', { key: 'Enter', wait: 500 }, 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
  // (fix-session-c, round 4, rule 4: the expectation had "See " with a trailing space; K5 drops a paragraph's
  // trailing whitespace when it is written, so the split's first part is "See")
  ['enter-mid-word-dup', 'Intro\n\nSee note one\n\nnote one\n\nz\n', 'See note', 0, 4, 'left', { key: 'Enter' }, 'Intro\n\nSee\n\nQRnote one\n\nnote one\n\nz\n'],
  ['enter-quote-before-dup', 'a\n\n> xdup\n\n> dup\n\nz\n', 'xdup', 0, 1, 'left', { key: 'Enter' }, 'a\n\n> x\n>\n> QRdup\n\n> dup\n\nz\n'],
  ['control-enter-unique', 'a\n\nxdup\n\nother\n\nz\n', 'xdup', 0, 1, 'left', { key: 'Enter' }, 'a\n\nx\n\nQRdup\n\nother\n\nz\n'],
];
async function caretAt(page, needle, nth, k, side) {
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
  for (const [name, doc, needle, nth, k, side, act, exp] of C) {
    for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
      const cname = `${name}${process.env.RUNS ? '#' + run : ''}`;
      if (filter && !cname.includes(filter)) continue;
      try {
        await prepare(A, doc);
        await caretAt(page, needle, nth, k, side);
        if (act.paste !== undefined) { await page.evaluate((t) => navigator.clipboard.writeText(t), act.paste); await page.keyboard.press('Meta+v'); }
        else await page.keyboard.press(act.key);
        if (act.wait) await sleep(act.wait);
        await page.keyboard.type('QR');
        await sleep(600);
        await page.keyboard.press('Escape'); await A.settle(200);
        const src = await A.source();
        check(cname, src === exp, `src=${J(src)}${src === exp ? '' : ' exp=' + J(exp)}`);
      } catch (e) { check(cname, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
