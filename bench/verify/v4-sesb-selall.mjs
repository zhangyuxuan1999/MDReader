// bench/verify/v4-sesb-selall.mjs — verify-session-b: H22 / U7 ⌘A two-step rule in every block kind. Click into the
// block (a session), ⌘A: the block's own content is selected (⌘C copies it), ⌘A again: the session ends and the
// whole preview is selected (the first and the last paragraph are in the copy); the source never changes.
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-selall.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, copied, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const F = '`'.repeat(3);
const HEAD = 'Top first para.\n\n';
const TAIL = '\n\nBottom last para.\n';
// [name, block source, needle to click, k, text the first ⌘A must copy (null: not checked)]
const C = [
  ['code-lang', F + 'js\nconst a = 1;\nlet b = 2;\n' + F, 'const', 1, 'const a = 1;\nlet b = 2;'],
  ['code-nolang', F + '\nplain one\nplain two\n' + F, 'plain one', 2, 'plain one\nplain two'],
  ['code-one-line', F + 'py\nx = 1\n' + F, 'x = 1', 1, 'x = 1'],
  ['code-trailing-blank', F + '\nline a\n\n' + F, 'line a', 2, null],
  ['code-tilde', '~~~\ntilde code\n~~~', 'tilde', 2, 'tilde code'],
  ['code-indented', '    indented code\n    second', 'indented', 2, null],
  ['math-block', '$$\nx^2 + 1\n$$', null, 0, null],
  ['table-cell', '| ha | hb |\n| --- | --- |\n| c1 | c2 |', 'c2', 1, null],
  ['list-first', '- item one\n- item two', 'item one', 2, null],
  ['list-last', '- item one\n- item two', 'item two', 2, null],
  ['list-nested', '- item one\n  - nested x\n- item two', 'nested x', 2, null],
  ['task', '- [ ] task a\n- [x] task b', 'task b', 2, null],
  ['quote', '> quote a\n>\n> quote b', 'quote b', 2, null],
  ['heading', '## Head line', 'Head', 2, 'Head line'],
  ['para-formula-end', 'Ends with $y^2$', 'Ends', 2, null],
  ['para-image-end', 'Pic ![alt](data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==)', 'Pic', 1, null],
  ['para-hard-break-end', 'Line one  \nline two', 'line two', 2, null],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, block, needle, k, firstExp] of C) {
    if (filter && !name.includes(filter)) continue;
    const doc = HEAD + block + TAIL;
    try {
      await prepare(A, doc);
      let p = needle ? await pointOf(page, needle, k) : await page.evaluate(() => { const e = document.querySelector('.mdr-preview .md-math--block, .mdr-preview .katex-display'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (!p) throw new Error('not shown ' + needle);
      await page.mouse.click(p.x, p.y); await sleep(400);
      const v0 = await view(page);
      if (!v0.editing) throw new Error('no session');
      await page.keyboard.press('Meta+a'); await sleep(150);
      const c1 = await copied(page);
      const v1 = await view(page);
      await page.keyboard.press('Meta+a'); await sleep(200);
      const c2 = await copied(page);
      const v2 = await view(page);
      await page.keyboard.press('Escape'); await A.settle(150);
      const src = await A.source();
      const whole = c2.includes('Top first para.') && c2.includes('Bottom last para.');
      const firstOk = firstExp === null ? !c1.includes('Top first') && !c1.includes('Bottom last') : c1 === firstExp;
      const ok = whole && !v2.editing && !!v1.editing && firstOk && src === doc;
      check(name, ok, `first=${J(c1)}${firstOk ? '' : ' exp=' + J(firstExp)} session1=${!!v1.editing} second.whole=${whole} second.len=${c2.length} session2=${!!v2.editing} srcSame=${src === doc}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  // the emptied element: ⌘A ⌘A selects the whole preview and the session (the element) is left as U9 says
  if (!filter || 'emptied'.includes(filter)) {
    try {
      const doc = HEAD + 'Mid para here.' + TAIL;
      await prepare(A, doc);
      const p = await pointOf(page, 'Mid para', 2); await page.mouse.click(p.x, p.y); await sleep(400);
      await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await sleep(400);
      const s1 = await A.source();
      await page.keyboard.press('Meta+a'); await sleep(150);
      await page.keyboard.press('Meta+a'); await sleep(200);
      const c2 = await copied(page);
      const v2 = await view(page);
      await page.keyboard.press('Escape'); await A.settle(150);
      const src = await A.source();
      check('emptied', c2.includes('Top first') && c2.includes('Bottom last') && src === s1, `afterEmpty=${J(s1)} copy=${J(c2.slice(0, 60))} session2=${!!v2.editing} src=${J(src)}`);
    } catch (e) { check('emptied', false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
