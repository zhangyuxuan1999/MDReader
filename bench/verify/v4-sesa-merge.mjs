// bench/verify/v4-sesa-merge.mjs — verify-session-a: the caret after a U3 merge (Backspace at the start of a
// paragraph whose previous block is a paragraph) when the paragraph above ENDS with an inline atom or inline
// formatting (image, inline formula, inline code, bold, link). The merge resumes on the merged block at the join
// (a source position mapped by offsetForSource onto visible text); the next typed character must stand at the
// join: between the atom / formatting of the upper paragraph and the first character of the lower one.
// Human speed (settles between the keys). Each case: click into the lower paragraph, put the caret at its start
// (⌘←), Backspace, type Q; then ⌘Z until the original source is back.
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-merge.mjs [name-filter]   (T_MS = global timeout, default 110 s)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, undoTo, waitSession, load, caretCtx } from './v4-sesa-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const IMG = 'https://e.example/i.png';
const cases = [
  ['plain', 'a1 xx\n\nb1 yy\n\nzz\n', 'a1 xxQb1 yy\n\nzz\n'],
  ['image-end', `see ![i](${IMG})\n\nb1 yy\n\nzz\n`, `see ![i](${IMG})Qb1 yy\n\nzz\n`],
  ['math-end', 'a1 $x^2$\n\nb1 yy\n\nzz\n', 'a1 $x^2$Qb1 yy\n\nzz\n'],
  ['math-only', '$x^2$\n\nb1 yy\n\nzz\n', '$x^2$Qb1 yy\n\nzz\n'],
  ['code-end', 'a1 `cd`\n\nb1 yy\n\nzz\n', 'a1 `cd`Qb1 yy\n\nzz\n'],
  ['bold-end', 'a1 **bb**\n\nb1 yy\n\nzz\n', 'a1 **bb**Qb1 yy\n\nzz\n'],
  ['link-end', 'a1 [lk](https://e.example/)\n\nb1 yy\n\nzz\n', 'a1 [lk](https://e.example/)Qb1 yy\n\nzz\n'],
  ['image-end-2line', `a1\nsee ![i](${IMG})\n\nb1 yy\n\nzz\n`, `a1\nsee ![i](${IMG})Qb1 yy\n\nzz\n`],
  ['math-end-2line', 'a1\nb2 $x^2$\n\nb1 yy\n\nzz\n', 'a1\nb2 $x^2$Qb1 yy\n\nzz\n'],
  // the lower paragraph starts with the atom: the join is before it
  ['lower-image-start', `a1 xx\n\n![i](${IMG}) yy\n\nzz\n`, `a1 xxQ![i](${IMG}) yy\n\nzz\n`],
  ['lower-math-start', 'a1 xx\n\n$x^2$ yy\n\nzz\n', 'a1 xxQ$x^2$ yy\n\nzz\n'],
];

try {
  await B.boot('mode=split');
  for (const [name, doc, want] of cases) {
    if (filter && !name.includes(filter)) continue;
    try {
      await load(B, doc);
      await clickText(page, 'yy', 1, { side: 'right' });
      const v0 = await waitSession(page);
      if (!v0.editing) throw new Error('no session');
      await page.keyboard.press('Meta+ArrowLeft'); await sleep(120);
      const c0 = await caretCtx(page);
      await page.keyboard.press('Backspace'); await settle(600);
      const c1 = await caretCtx(page);
      await page.keyboard.type('Q'); await settle(600);
      const v = await view(page);
      const ok = v.src === want;
      await page.keyboard.press('Escape'); await settle(200);
      const u = await undoTo(B, doc, 8, 150);
      check(name, ok && u.ok, `src=${J(v.src)}${ok ? '' : ' want=' + J(want)} caretBefore=${J(c0)} caretAfterMerge=${J(c1)} editing=${J(v.editing && v.editing.text.slice(0, 40))} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}`);
    } catch (e) { check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = results_bad();
}
function results_bad() { return 0; }
