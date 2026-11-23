// bench/verify/v3-ses-empty.mjs — verify-session stage 2c: U9 (an emptied block) + U14 (leading blank lines) +
// createPreview's unkeepReusedId / held, in real Chromium. Each case: load a document, click (real press + release)
// into the target block, empty it (⌘A + Backspace, ⌘A + ⌘X, or Backspace per character), check the source and the
// preview (no duplicated / vanished block, the emptied element still edits), type N (a new block at the same place),
// check again, then ⌘Z inside the session back to the original BYTE FOR BYTE and ⇧⌘Z back to the final text.
// "shown" = the preview's block texts in order while the session lives; "after Esc" = the same once the session ended
// and the preview re-rendered from the source: both must agree (INV 1: source equals screen).
// Run: MDR_PORT=5382 node bench/verify/v3-ses-empty.mjs [name-filter]      (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, results, summary, view, shownText, clickText, undoTo, redoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;

async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(40); }
  return view(page);
}
async function emptyIt(how, len) {
  if (how === 'selbs') { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); }
  else if (how === 'cut') { await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+x'); }
  else if (how === 'bs') { for (let i = 0; i < len; i++) await page.keyboard.press('Backspace'); }
  else if (how === 'del') { for (let i = 0; i < len; i++) await page.keyboard.press('Delete'); }
}
const settle = async () => { await sleep(320); await B.settle(150); };

// name, doc, needle (clicked; caret placed after it when how=bs, before it when how=del), how, expected after emptying,
// expected after typing N, shown-after-empty (block texts), shown-after-N
const C = [
  ['lead1-first', '\nabc\n\nghi\n', 'abc', 'selbs', '\nghi\n', '\nN\n\nghi\n', ['ghi'], ['N', 'ghi']],
  ['lead1-first-same-next', '\nsame\n\nsame\n', 'same', 'selbs', '\nsame\n', '\nN\n\nsame\n', ['same'], ['N', 'same']],
  ['first-same-next', 'same\n\nsame\n\nz\n', 'same', 'selbs', 'same\n\nz\n', 'N\n\nsame\n\nz\n', ['same', 'z'], ['N', 'same', 'z']],
  ['mid-same-next', 'a\n\nsame\n\nsame\n\nz\n', 'same', 'selbs', 'a\n\nsame\n\nz\n', 'a\n\nN\n\nsame\n\nz\n', ['a', 'same', 'z'], ['a', 'N', 'same', 'z']],
  ['mid-same-next-cut', 'a\n\nsame\n\nsame\n\nz\n', 'same', 'cut', 'a\n\nsame\n\nz\n', 'a\n\nN\n\nsame\n\nz\n', ['a', 'same', 'z'], ['a', 'N', 'same', 'z']],
  // (fix-session-a, round 3 — lead decision U18 (a): "bs" presses Backspace needle.length + 2 times; the first extra one
  // no longer stays in the emptied element but moves the caret to the end of "a" (the U3 merge of the empty paragraph,
  // or U18 (a) once the deletion is written), the second deletes "a", which is then emptied and deleted in turn: N is
  // typed at its place. Expected before U18: 'a⏎⏎same⏎⏎z⏎', 'a⏎⏎N⏎⏎same⏎⏎z⏎', [a, same, z], [a, N, same, z].)
  ['mid-same-next-bs', 'a\n\nsame\n\nsame\n\nz\n', 'same', 'bs', 'same\n\nz\n', 'N\n\nsame\n\nz\n', ['same', 'z'], ['N', 'same', 'z']],
  ['only-block', 'abc\n', 'abc', 'selbs', '', 'N\n', [], ['N']],
  ['only-block-lead', '\nabc\n', 'abc', 'selbs', '', '\nN\n', [], ['N']],
  ['last-block-nonl', 'abc\n\nlast', 'last', 'selbs', 'abc\n', 'abc\n\nN', ['abc'], ['abc', 'N']],
  ['last-block', 'abc\n\nlast\n', 'last', 'selbs', 'abc\n', 'abc\n\nN\n', ['abc'], ['abc', 'N']],
  ['blank2', 'a\n\n\nmid\n\n\nz\n', 'mid', 'selbs', 'a\n\n\nz\n', 'a\n\n\nN\n\n\nz\n', ['a', 'z'], ['a', 'N', 'z']],
  ['blank5', 'a\n\n\n\n\n\nmid\n\n\n\n\n\nz\n', 'mid', 'selbs', 'a\n\n\n\n\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  ['heading', 'a\n\n# Head\n\nz\n', 'Head', 'selbs', 'a\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  ['quote', 'a\n\n> quoted\n\nz\n', 'quoted', 'selbs', 'a\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  ['list-whole', 'a\n\n- one\n- two\n\nz\n', 'one', 'selbs', 'a\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  ['code', 'a\n\n```\ncode\n```\n\nz\n', 'code', 'selbs', 'a\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  ['table', 'a\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\nz\n', 'h', 'selbs', 'a\n\nz\n', null, ['a', 'z'], ['a', 'N', 'z']],
  // tight neighbours: the emptied block has no blank line before or after it
  ['tight-heading-between-paras', '# H1\ntext1\n# H2\ntext2\n', 'H2', 'selbs', null, null, ['H1', 'text1', 'text2'], ['H1', 'text1', 'N', 'text2']],
  ['tight-heading-after-para', 'para one\n# Head\n\nz\n', 'Head', 'selbs', 'para one\n\nz\n', null, ['para one', 'z'], ['para one', 'N', 'z']],
  ['tight-code-between-paras', 'p1\n```\ncode\n```\np2\n', 'code', 'selbs', null, null, ['p1', 'p2'], ['p1', 'N', 'p2']],
  ['tight-list-after-para', 'p1\n- item\n\nz\n', 'item', 'selbs', 'p1\n\nz\n', null, ['p1', 'z'], ['p1', 'N', 'z']],
];

let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, needle, how, exp1, exp2, shown1, shown2] of C) {
    if (filter && !name.includes(filter)) continue;
    const det = [];
    let ok = true;
    try {
      await B.loadDoc(doc);
      const orig = await B.source();
      if (orig !== doc) throw new Error('loaded ' + J(orig));
      await sleep(650);                                  // past the navigation anchor
      await clickText(page, needle, how === 'del' ? 0 : needle.length - 1, { side: how === 'del' ? 'left' : 'right' });
      let v = await waitSession();
      if (!v.editing) throw new Error('no session after click ' + J(v));
      await emptyIt(how, needle.length + 2);
      await settle();
      v = await view(page);
      const sh1 = await shownText(page);
      if (exp1 !== null && v.src !== exp1) { ok = false; det.push(`empty: src=${J(v.src)} exp=${J(exp1)}`); }
      if (J(sh1) !== J(shown1)) { ok = false; det.push(`empty: shown=${J(sh1)} exp=${J(shown1)}`); }
      if (!v.editing) { ok = false; det.push('empty: no session on the emptied element ' + J(v)); }
      if (v.dupIds.length) { ok = false; det.push('empty: duplicate ids ' + J(v.dupIds)); }
      const afterEmpty = v.src;
      await page.keyboard.type('N');
      await settle();
      v = await view(page);
      const sh2 = await shownText(page);
      if (exp2 !== null && v.src !== exp2) { ok = false; det.push(`typed: src=${J(v.src)} exp=${J(exp2)}`); }
      if (J(sh2) !== J(shown2)) { ok = false; det.push(`typed: shown=${J(sh2)} exp=${J(shown2)}`); }
      if (!v.editing || !v.editing.text.includes('N')) { ok = false; det.push('typed: session not on N ' + J(v.editing)); }
      if (v.dupIds.length) { ok = false; det.push('typed: duplicate ids ' + J(v.dupIds)); }
      const fin = v.src;
      // INV 1: what the session shows is what the source renders
      await B.esc(); await settle();
      const sh3 = await shownText(page);
      if (J(sh3) !== J(sh2)) { ok = false; det.push(`after Esc shown=${J(sh3)} (session showed ${J(sh2)})`); }
      // undo inside a session: click N again
      await clickText(page, 'N', 0, { side: 'right' });
      await waitSession();
      const u = await undoTo(B, orig, 12);
      if (!u.ok) { ok = false; det.push(`undo: now=${J(u.now)} after ${u.n}`); }
      const r = await redoTo(B, fin, 12);
      if (!r.ok) { ok = false; det.push(`redo: now=${J(r.now)} after ${r.n}`); }
      v = await view(page);
      det.push(`afterEmpty=${J(afterEmpty)} final=${J(fin)} undo=${u.n} redo=${r.n} live=${!!v.editing}`);
      if (!ok) bad++;
      check(name, ok, det.join(' ; '));
    } catch (e) { bad++; check(name, false, 'threw ' + e.message.split('\n')[0] + ' ' + det.join(' ; ')); }
    await B.esc().catch(() => {});
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
